use anyhow::Context;
use reqwest::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::time::Duration;
use tracing::{info, warn};

use crate::capture::spawn_capture_plan;
use crate::channel_map::{capture_plan_for_job, channel_map_details, render_capture_output};
use crate::config::AgentConfig;
use crate::health_log::{self, AgentHealthEvent};
use crate::state::write_job_state;
use crate::telemetry::MeterFrame;

const DURATION_HEADER: &str = "x-rakkr-duration-seconds";
const FILE_NAME_HEADER: &str = "x-rakkr-file-name";
const AGENT_ID_HEADER: &str = "x-rakkr-agent-id";
const JOB_ID_HEADER: &str = "x-rakkr-recording-job-id";

pub struct CacheFileUpload<'a> {
    pub allow_insecure_controller: bool,
    pub content_type: &'a str,
    pub controller_url: &'a str,
    pub duration_seconds: Option<u64>,
    pub file_name: Option<String>,
    pub file_path: &'a std::path::Path,
    pub job_id: Option<&'a str>,
    pub recording_id: &'a str,
    pub token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecordingJob {
    pub command: ControllerCaptureCommand,
    pub failure_reason: Option<String>,
    pub id: String,
    pub node_id: String,
    pub recording_id: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerCaptureCommand {
    pub capture_channels: u16,
    pub capture_device: String,
    pub capture_format: String,
    pub capture_interface_id: Option<String>,
    pub capture_sample_rate: u32,
    pub channel_map: Option<ControllerRecordingJobChannelMap>,
    pub duration_seconds: u64,
    pub output_bitrate_kbps: Option<u32>,
    pub output_codec: Option<String>,
    pub output_file_name: String,
    pub output_vbr: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecordingJobChannelMap {
    pub assignment_id: String,
    pub channel_mode: String,
    pub entries: Vec<ControllerChannelMapEntry>,
    pub source_channels: u16,
    pub target_id: String,
    pub target_type: String,
    pub template_id: String,
    pub template_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapBundle {
    pub assignment: ControllerChannelMapAssignment,
    pub template: ControllerChannelMapTemplate,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapAssignment {
    pub assigned_at: String,
    pub id: String,
    pub target_id: String,
    pub target_type: String,
    pub template_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapTemplate {
    pub channel_mode: String,
    pub entries: Vec<ControllerChannelMapEntry>,
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapEntry {
    pub included: bool,
    pub label: String,
    pub output_channel_index: Option<u16>,
    pub source_channel_index: u16,
}

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
}

pub async fn fetch_channel_map_assignments(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<Vec<ControllerChannelMapBundle>> {
    config.validate_controller_transport()?;
    let url = node_url(
        &config.controller_url,
        &config.node_id,
        "channel-map-assignments",
    );
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("fetch channel map assignments")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected channel map assignment request with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<Vec<ControllerChannelMapBundle>>>()
        .await
        .context("decode channel map assignments")?;

    Ok(envelope.data)
}

pub async fn attach_cache_file(config: &AgentConfig) -> anyhow::Result<()> {
    let recording_id = config
        .attach_cache_recording_id
        .as_deref()
        .context("missing --attach-cache-recording-id")?;
    let file_path = config
        .attach_cache_file
        .as_deref()
        .context("missing --attach-cache-file")?;
    let token = config
        .controller_token
        .as_deref()
        .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
    let file_name = config.attach_cache_file_name.clone().or_else(|| {
        file_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
    });

    upload_cache_file(CacheFileUpload {
        allow_insecure_controller: config.allow_insecure_controller,
        content_type: &config.attach_cache_content_type,
        controller_url: &config.controller_url,
        duration_seconds: config.attach_cache_duration_seconds,
        file_name,
        file_path,
        job_id: None,
        recording_id,
        token,
    })
    .await
}

pub async fn run_next_recording_job(config: &AgentConfig) -> anyhow::Result<()> {
    config.validate_controller_transport()?;
    let token = config
        .controller_token
        .as_deref()
        .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
    let Some(job) = fetch_next_recording_job(config, token).await? else {
        info!(node_id = %config.node_id, "no queued recording job for node");
        return Ok(());
    };
    let job = claim_recording_job(config, token, &job.id).await?;
    write_job_state(config, &job, "running", None, None)?;
    info!(
        job_id = %job.id,
        node_id = %job.node_id,
        recording_id = %job.recording_id,
        "claimed recording job"
    );
    let channel_maps = if job.command.channel_map.is_some() {
        Vec::new()
    } else {
        match fetch_channel_map_assignments(config, token).await {
            Ok(assignments) => assignments,
            Err(error) => {
                let reason = error.to_string();

                warn!(error = %reason, "failed to fetch channel map assignments for recording job");
                append_job_health_event(
                    config,
                    token,
                    &job,
                    "agent.recording_job.channel_map_lookup_failed",
                    "warning",
                    json!({
                        "error": reason.as_str(),
                        "jobId": job.id.as_str(),
                        "recordingId": job.recording_id.as_str(),
                    }),
                )
                .await?;
                Vec::new()
            }
        }
    };
    let capture_plan = capture_plan_for_job(config, &job, &channel_maps);

    if let Some(channel_map) = &capture_plan.channel_map {
        info!(
            assignment_id = %channel_map.assignment_id,
            capture_channels = channel_map.source_channels,
            channel_mode = %channel_map.channel_mode,
            template_id = %channel_map.template_id,
            "applied channel map to recording job capture plan"
        );
        append_job_health_event(
            config,
            token,
            &job,
            "agent.recording_job.channel_map_applied",
            "info",
            json!({
                "assignmentId": channel_map.assignment_id.as_str(),
                "captureChannels": channel_map.source_channels,
                "channelMode": channel_map.channel_mode.as_str(),
                "configuredCaptureChannels": job.command.capture_channels,
                "jobId": job.id.as_str(),
                "recordingId": job.recording_id.as_str(),
                "targetId": channel_map.target_id.as_str(),
                "targetType": channel_map.target_type.as_str(),
                "templateId": channel_map.template_id.as_str(),
                "templateName": channel_map.template_name.as_str(),
            }),
        )
        .await?;
    }

    let mut capture = match spawn_capture_plan(&capture_plan) {
        Ok(capture) => capture,
        Err(error) => {
            let reason = error.to_string();

            let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.capture_start_failed",
                "critical",
                json!({
                    "command": capture_plan.command.as_str(),
                    "device": capture_plan.device.as_str(),
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                    "outputPath": capture_plan.output_path.display().to_string(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_job_state(config, &job, "failed", None, Some(&reason))?;

            return Err(error);
        }
    };
    let raw_output_path = loop {
        match capture.try_complete() {
            Ok(Some(output_path)) => {
                write_job_state(config, &job, "captured", Some(&output_path), None)?;
                break output_path;
            }
            Ok(None) => {
                if let Err(error) = capture.check_growth() {
                    let reason = error.to_string();

                    let _ = capture.stop();
                    let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
                    append_job_health_event(
                        config,
                        token,
                        &job,
                        "agent.recording_job.capture_output_stalled",
                        "critical",
                        json!({
                            "device": capture_plan.device.as_str(),
                            "error": reason.as_str(),
                            "jobId": job.id.as_str(),
                            "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                            "outputPath": capture_plan.output_path.display().to_string(),
                            "recordingId": job.recording_id.as_str(),
                        }),
                    )
                    .await?;
                    write_job_state(config, &job, "failed", None, Some(&reason))?;

                    return Err(error);
                }
            }
            Err(error) => {
                let reason = error.to_string();

                let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
                append_job_health_event(
                    config,
                    token,
                    &job,
                    "agent.recording_job.capture_failed",
                    "critical",
                    json!({
                        "device": capture_plan.device.as_str(),
                        "error": reason.as_str(),
                        "jobId": job.id.as_str(),
                        "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                        "outputPath": capture_plan.output_path.display().to_string(),
                        "recordingId": job.recording_id.as_str(),
                    }),
                )
                .await?;
                write_job_state(config, &job, "failed", None, Some(&reason))?;

                return Err(error);
            }
        }

        if let Err(error) = heartbeat_recording_job(config, token, &job.id).await {
            let refreshed = fetch_recording_job(config, token, &job.id).await.ok();

            if let Some(latest) = refreshed {
                if matches!(latest.status.as_str(), "stop_requested" | "cancelled") {
                    capture.stop()?;
                    mark_recording_job_cancelled(
                        config,
                        token,
                        &job.id,
                        "controller_stop_requested",
                    )
                    .await?;
                    write_job_state(
                        config,
                        &latest,
                        "cancelled",
                        None,
                        Some("controller_stop_requested"),
                    )?;
                    return Ok(());
                }

                if matches!(latest.status.as_str(), "failed" | "completed") {
                    capture.stop()?;
                    write_job_state(
                        config,
                        &latest,
                        latest.status.as_str(),
                        None,
                        latest.failure_reason.as_deref(),
                    )?;
                    return Ok(());
                }
            }

            let reason = error.to_string();
            capture.stop()?;
            let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.control_plane_failed",
                "warning",
                json!({
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_job_state(config, &job, "failed", None, Some(&reason))?;
            return Err(error);
        }

        let latest = fetch_recording_job(config, token, &job.id).await?;

        if matches!(latest.status.as_str(), "stop_requested" | "cancelled") {
            capture.stop()?;
            mark_recording_job_cancelled(config, token, &job.id, "controller_stop_requested")
                .await?;
            write_job_state(
                config,
                &latest,
                "cancelled",
                None,
                Some("controller_stop_requested"),
            )?;
            return Ok(());
        }

        if matches!(latest.status.as_str(), "failed" | "completed") {
            capture.stop()?;
            write_job_state(
                config,
                &latest,
                latest.status.as_str(),
                None,
                latest.failure_reason.as_deref(),
            )?;
            return Ok(());
        }

        tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
    };
    let output_path = match render_capture_output(&capture_plan, &raw_output_path) {
        Ok(rendered_path) => {
            if rendered_path != raw_output_path {
                append_job_health_event(
                    config,
                    token,
                    &job,
                    "agent.recording_job.output_rendered",
                    "info",
                    json!({
                        "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                        "jobId": job.id.as_str(),
                        "outputBitrateKbps": capture_plan.output_bitrate_kbps,
                        "outputCodec": capture_plan.output_codec.as_str(),
                        "outputVbr": capture_plan.output_vbr,
                        "rawOutputPath": raw_output_path.display().to_string(),
                        "recordingId": job.recording_id.as_str(),
                        "renderedOutputPath": rendered_path.display().to_string(),
                    }),
                )
                .await?;
                write_job_state(config, &job, "rendered", Some(&rendered_path), None)?;
            }

            rendered_path
        }
        Err(error) => {
            let reason = error.to_string();

            let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.output_render_failed",
                "critical",
                json!({
                    "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "outputBitrateKbps": capture_plan.output_bitrate_kbps,
                    "outputCodec": capture_plan.output_codec.as_str(),
                    "outputVbr": capture_plan.output_vbr,
                    "rawOutputPath": raw_output_path.display().to_string(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_job_state(
                config,
                &job,
                "failed",
                Some(&raw_output_path),
                Some(&reason),
            )?;

            return Err(error);
        }
    };

    let upload_result = upload_cache_file(CacheFileUpload {
        allow_insecure_controller: config.allow_insecure_controller,
        content_type: content_type_for_codec(job.command.output_codec.as_deref(), &output_path),
        controller_url: &config.controller_url,
        duration_seconds: Some(job.command.duration_seconds),
        file_name: Some(job.command.output_file_name.clone()),
        file_path: &output_path,
        job_id: Some(&job.id),
        recording_id: &job.recording_id,
        token,
    })
    .await;

    match upload_result {
        Ok(()) => {
            write_job_state(config, &job, "completed", Some(&output_path), None)?;
            Ok(())
        }
        Err(error) => {
            let reason = error.to_string();
            mark_recording_job_failed(config, token, &job.id, &reason).await?;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.cache_upload_failed",
                "warning",
                json!({
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "outputPath": output_path.display().to_string(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_job_state(config, &job, "failed", Some(&output_path), Some(&reason))?;
            Err(error)
        }
    }
}

fn content_type_for_codec(codec: Option<&str>, path: &std::path::Path) -> &'static str {
    match codec.map(str::to_ascii_lowercase).as_deref() {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => content_type_for_path(path),
    }
}

fn content_type_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

pub async fn upload_cache_file(input: CacheFileUpload<'_>) -> anyhow::Result<()> {
    crate::config::validate_controller_transport(
        input.controller_url,
        input.allow_insecure_controller,
    )?;
    let bytes = fs::read(input.file_path)
        .with_context(|| format!("read recording cache file {}", input.file_path.display()))?;

    if bytes.is_empty() {
        anyhow::bail!(
            "recording cache file is empty: {}",
            input.file_path.display()
        );
    }

    let url = recording_cache_url(input.controller_url, input.recording_id);
    let mut request = reqwest::Client::new()
        .put(&url)
        .bearer_auth(input.token)
        .header(CONTENT_TYPE, input.content_type)
        .body(bytes);

    if let Some(duration_seconds) = input.duration_seconds {
        request = request.header(
            HeaderName::from_static(DURATION_HEADER),
            HeaderValue::from_str(&duration_seconds.to_string()).context("duration header")?,
        );
    }

    if let Some(file_name) = input.file_name {
        request = request.header(
            HeaderName::from_static(FILE_NAME_HEADER),
            HeaderValue::from_str(&file_name).context("file name header")?,
        );
    }

    if let Some(job_id) = input.job_id {
        request = request.header(
            HeaderName::from_static(JOB_ID_HEADER),
            HeaderValue::from_str(job_id).context("job id header")?,
        );
    }

    let response = request
        .send()
        .await
        .context("send cache file to controller")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected cache file with {status}: {body}");
    }

    info!(
        recording_id = input.recording_id,
        url = url,
        "attached recording cache file to controller"
    );

    Ok(())
}

pub async fn post_meter_frame(
    config: &AgentConfig,
    token: &str,
    frame: &MeterFrame,
) -> anyhow::Result<()> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, "meter-frame");
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .json(frame)
        .send()
        .await
        .context("post meter frame to controller")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected meter frame with {status}: {body}");
    }

    Ok(())
}

pub async fn sync_health_event(
    config: &AgentConfig,
    token: &str,
    event: &AgentHealthEvent,
) -> anyhow::Result<()> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, "health-events");
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .json(event)
        .send()
        .await
        .context("sync health event to controller")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected health event with {status}: {body}");
    }

    Ok(())
}

async fn append_job_health_event(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    event_type: &str,
    severity: &str,
    details: serde_json::Value,
) -> anyhow::Result<()> {
    let event = health_log::append_health_event_with_targets(
        config,
        event_type,
        severity,
        details,
        Some(job.recording_id.clone()),
        None,
    )?;

    if let Err(error) = sync_health_event(config, token, &event).await {
        warn!(event_type, error = %error, "failed to sync recording job health event");
    }

    Ok(())
}

async fn fetch_next_recording_job(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<Option<ControllerRecordingJob>> {
    let url = format!(
        "{}/api/v1/nodes/{}/recording-jobs/next",
        config.controller_url.trim_end_matches('/'),
        config.node_id
    );
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("fetch next recording job")?;
    let status = response.status();

    if status.as_u16() == 204 {
        return Ok(None);
    }

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected next job request with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode next recording job")?;

    Ok(Some(envelope.data))
}

async fn claim_recording_job(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
) -> anyhow::Result<ControllerRecordingJob> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}/claim",
        config.controller_url.trim_end_matches('/'),
        job_id
    );
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .header(AGENT_ID_HEADER, config.node_id.as_str())
        .send()
        .await
        .context("claim recording job")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected job claim with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode claimed recording job")?;

    Ok(envelope.data)
}

async fn heartbeat_recording_job(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
) -> anyhow::Result<ControllerRecordingJob> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}/heartbeat",
        config.controller_url.trim_end_matches('/'),
        job_id
    );
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .header(AGENT_ID_HEADER, config.node_id.as_str())
        .send()
        .await
        .context("heartbeat recording job")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected job heartbeat with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode heartbeat recording job")?;

    Ok(envelope.data)
}

async fn fetch_recording_job(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
) -> anyhow::Result<ControllerRecordingJob> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}",
        config.controller_url.trim_end_matches('/'),
        job_id
    );
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("fetch recording job status")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected job status request with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode recording job status")?;

    Ok(envelope.data)
}

async fn mark_recording_job_cancelled(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
    reason: &str,
) -> anyhow::Result<()> {
    mark_recording_job_terminal(config, token, job_id, "cancelled", reason).await
}

async fn mark_recording_job_failed(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
    reason: &str,
) -> anyhow::Result<()> {
    mark_recording_job_terminal(config, token, job_id, "failed", reason).await
}

async fn mark_recording_job_terminal(
    config: &AgentConfig,
    token: &str,
    job_id: &str,
    terminal_state: &str,
    reason: &str,
) -> anyhow::Result<()> {
    let url = format!(
        "{}/api/v1/recording-jobs/{}/{}",
        config.controller_url.trim_end_matches('/'),
        job_id,
        terminal_state
    );
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .header("x-rakkr-reason", reason)
        .send()
        .await
        .with_context(|| format!("mark recording job {terminal_state}"))?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected job terminal update with {status}: {body}");
    }

    Ok(())
}

fn recording_cache_url(controller_url: &str, recording_id: &str) -> String {
    format!(
        "{}/api/v1/recordings/{}/cache-file",
        controller_url.trim_end_matches('/'),
        recording_id
    )
}

fn node_url(controller_url: &str, node_id: &str, suffix: &str) -> String {
    format!(
        "{}/api/v1/nodes/{}/{}",
        controller_url.trim_end_matches('/'),
        node_id,
        suffix.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_recording_cache_url_without_double_slashes() {
        assert_eq!(
            recording_cache_url("https://controller.local/", "rec_123"),
            "https://controller.local/api/v1/recordings/rec_123/cache-file"
        );
    }

    #[test]
    fn builds_node_url_without_double_slashes() {
        assert_eq!(
            node_url("https://controller.local/", "node_1", "/meter-frame"),
            "https://controller.local/api/v1/nodes/node_1/meter-frame"
        );
    }

    #[test]
    fn maps_encoded_recording_content_types() {
        assert_eq!(
            content_type_for_codec(Some("mp3"), std::path::Path::new("recording.wav")),
            "audio/mpeg"
        );
        assert_eq!(
            content_type_for_codec(None, std::path::Path::new("recording.flac")),
            "audio/flac"
        );
    }
}
