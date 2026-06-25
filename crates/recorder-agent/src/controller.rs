mod types;

use anyhow::Context;
use reqwest::header::{CONTENT_TYPE, DATE, HeaderName, HeaderValue};
use serde_json::json;
use std::fs;
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc2822};
use tracing::{info, warn};

use crate::cache_content_type::content_type_for_codec;
use crate::capture::CaptureChild;
use crate::channel_map::{capture_plan_for_job, channel_map_details, render_capture_output};
use crate::config::AgentConfig;
use crate::controller_http::{controller_http_client, controller_http_client_with_ca};
use crate::health_log::{self, AgentHealthEvent};
use crate::inventory::NodeInventory;
use crate::recording_job_recovery::{
    apply_recorder_cache_retention, capture_disk_space_shortfall, ensure_capture_disk_space,
    recover_runtime_capture_device_loss, refresh_capture_device_from_inventory,
    report_capture_command_failure, report_capture_disk_space_shortfall,
    report_control_plane_sync_failure, spawn_capture_plan_with_recovery,
    write_recoverable_job_state,
};
use crate::recording_job_segments::stitch_recovered_capture_segments;
use crate::state::write_job_state;
use crate::telemetry::MeterFrame;
use types::DataEnvelope;
pub use types::{
    CacheFileUpload, ControllerCaptureCommand, ControllerChannelMapBundle,
    ControllerChannelMapEntry, ControllerRecordingJob, ControllerRecordingJobChannelMap,
};
#[cfg(test)]
pub use types::{ControllerChannelMapAssignment, ControllerChannelMapTemplate};

const DURATION_HEADER: &str = "x-rakkr-duration-seconds";
const FILE_NAME_HEADER: &str = "x-rakkr-file-name";
const AGENT_ID_HEADER: &str = "x-rakkr-agent-id";
const JOB_ID_HEADER: &str = "x-rakkr-recording-job-id";

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
    let response = controller_http_client(config)?
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
        controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
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
    let Some(job) = (match claim_next_recording_job(config, token).await {
        Ok(job) => job,
        Err(error) => {
            let reason = error.to_string();
            let event = health_log::append_health_event(
                config,
                "agent.recording_job.claim_next_failed",
                "warning",
                json!({ "error": reason.as_str(), "nodeId": config.node_id.as_str() }),
            )?;
            if let Err(sync_error) = sync_health_event(config, token, &event).await {
                warn!(error = %sync_error, "failed to sync claim-next health event");
            }

            return Err(error);
        }
    }) else {
        info!(node_id = %config.node_id, "no queued recording job for node");
        return Ok(());
    };
    write_job_state(config, &job, "running", None, None)?;
    info!(
        job_id = %job.id,
        node_id = %job.node_id,
        recording_id = %job.recording_id,
        track_group_id = ?job.command.track_group_id,
        track_index = ?job.command.track_index,
        track_total = ?job.command.track_total,
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
    let mut capture_plan = capture_plan_for_job(config, &job, &channel_maps);
    refresh_capture_device_from_inventory(config, token, &job, &mut capture_plan).await?;

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
                "entryCount": channel_map.entries.len(),
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

    if let Err(error) = ensure_capture_disk_space(config, token, &job, &capture_plan).await {
        write_job_state(config, &job, "failed", None, Some(&error.to_string()))?;

        return Err(error);
    }

    write_recoverable_job_state(
        config,
        &job,
        "running",
        Some(&capture_plan.output_path),
        None,
        &[],
    )?;

    let mut capture =
        match spawn_capture_plan_with_recovery(config, token, &job, &capture_plan).await {
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
    let mut control_plane_sync_failed = false;
    let mut capture_attempt = 1_u8;
    let mut recovered_segments = Vec::new();
    let raw_output_path = loop {
        match capture.try_complete() {
            Ok(Some(output_path)) => {
                write_recoverable_job_state(
                    config,
                    &job,
                    "captured",
                    Some(&output_path),
                    None,
                    &recovered_segments,
                )?;
                break output_path;
            }
            Ok(None) => match capture.check_growth() {
                Ok(growth) => {
                    if let Some(disk_usage) = crate::system_health::disk_usage(
                        &config.system_health_df_command,
                        &config.system_health_disk_path,
                    ) && let Some(shortfall) =
                        capture_disk_space_shortfall(&capture_plan, &growth, disk_usage)
                    {
                        let reason = shortfall.reason();

                        let _ = capture.stop();
                        report_capture_disk_space_shortfall(
                            config,
                            token,
                            &job,
                            &capture_plan,
                            &growth,
                            &shortfall,
                        )
                        .await?;
                        write_job_state(config, &job, "failed", None, Some(&reason))?;

                        return Err(anyhow::anyhow!(reason));
                    }
                }
                Err(error) => {
                    let reason = error.to_string();
                    let growth = error.snapshot();

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
                                "growthAgeSeconds": growth.age_seconds,
                                "growthGraceSeconds": capture_plan.growth_grace_seconds,
                                "lastGrowthSecondsAgo": growth.last_growth_seconds_ago,
                                "jobId": job.id.as_str(),
                                "channelMap": capture_plan.channel_map.as_ref().map(channel_map_details),
                                "outputPath": capture_plan.output_path.display().to_string(),
                                "recordingId": job.recording_id.as_str(),
                                "sizeBytes": growth.size_bytes,
                                "stalledSeconds": capture_plan.stalled_seconds,
                            }),
                        )
                        .await?;
                    write_job_state(config, &job, "failed", None, Some(&reason))?;

                    return Err(error.into());
                }
            },
            Err(error) => {
                match recover_runtime_capture_device_loss(
                    config,
                    token,
                    &job,
                    &mut capture_plan,
                    &error,
                    capture_attempt,
                )
                .await
                {
                    Ok(Some(recovered_capture)) => {
                        capture_attempt += 1;
                        if let Some(segment) = recovered_capture.segment {
                            recovered_segments.push(segment);
                        }
                        capture = recovered_capture.capture;
                        write_recoverable_job_state(
                            config,
                            &job,
                            "running",
                            Some(&capture_plan.output_path),
                            None,
                            &recovered_segments,
                        )?;
                        continue;
                    }
                    Ok(None) => {
                        let reason = error.to_string();

                        report_capture_command_failure(config, token, &job, &capture_plan, &error)
                            .await?;
                        write_job_state(config, &job, "failed", None, Some(&reason))?;

                        return Err(error);
                    }
                    Err(recovery_error) => {
                        let reason = recovery_error.to_string();

                        report_capture_command_failure(
                            config,
                            token,
                            &job,
                            &capture_plan,
                            &recovery_error,
                        )
                        .await?;
                        write_job_state(config, &job, "failed", None, Some(&reason))?;

                        return Err(recovery_error);
                    }
                }
            }
        }

        if let Err(error) = heartbeat_recording_job(config, token, &job.id).await {
            control_plane_sync_failed = report_control_plane_sync_failure(
                config,
                token,
                &job,
                "agent.recording_job.control_plane_failed",
                error.to_string(),
                control_plane_sync_failed,
            )
            .await?;

            if let Ok(latest) = fetch_recording_job(config, token, &job.id).await
                && handle_terminal_controller_job(config, token, &job, &latest, &mut capture)
                    .await?
            {
                return Ok(());
            }

            tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
            continue;
        }

        if control_plane_sync_failed {
            control_plane_sync_failed = false;
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.control_plane_recovered",
                "info",
                json!({
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
        }

        let latest = match fetch_recording_job(config, token, &job.id).await {
            Ok(latest) => latest,
            Err(error) => {
                control_plane_sync_failed = report_control_plane_sync_failure(
                    config,
                    token,
                    &job,
                    "agent.recording_job.status_poll_failed",
                    error.to_string(),
                    control_plane_sync_failed,
                )
                .await?;

                tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
                continue;
            }
        };

        if handle_terminal_controller_job(config, token, &job, &latest, &mut capture).await? {
            return Ok(());
        }

        tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
    };
    let raw_output_path = stitch_recovered_capture_segments(
        config,
        token,
        &job,
        &capture_plan,
        &recovered_segments,
        &raw_output_path,
    )
    .await?;
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
            let raw_output_bytes = fs::metadata(&raw_output_path)
                .ok()
                .map(|metadata| metadata.len());

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
                    "rawOutputBytes": raw_output_bytes,
                    "recordingId": job.recording_id.as_str(),
                    "renderCommand": capture_plan.render_command.as_str(),
                    "renderedOutputPath": capture_plan.final_output_path.display().to_string(),
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

    let upload_content_type =
        content_type_for_codec(job.command.output_codec.as_deref(), &output_path);
    let upload_file_name = job.command.output_file_name.clone();
    let upload_output_bytes = fs::metadata(&output_path)
        .ok()
        .map(|metadata| metadata.len());
    let upload_result = upload_cache_file(CacheFileUpload {
        allow_insecure_controller: config.allow_insecure_controller,
        content_type: upload_content_type,
        controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
        controller_url: &config.controller_url,
        duration_seconds: Some(job.command.duration_seconds),
        file_name: Some(upload_file_name.clone()),
        file_path: &output_path,
        job_id: Some(&job.id),
        recording_id: &job.recording_id,
        token,
    })
    .await;

    match upload_result {
        Ok(()) => {
            apply_recorder_cache_retention(config, token, &job, &raw_output_path, &output_path)
                .await?;
            write_job_state(config, &job, "completed", Some(&output_path), None)?;
            Ok(())
        }
        Err(error) => {
            let reason = error.to_string();
            append_job_health_event(
                config,
                token,
                &job,
                "agent.recording_job.cache_upload_failed",
                "warning",
                json!({
                    "contentType": upload_content_type,
                    "durationSeconds": job.command.duration_seconds,
                    "error": reason.as_str(),
                    "fileName": upload_file_name.as_str(),
                    "jobId": job.id.as_str(),
                    "outputBitrateKbps": capture_plan.output_bitrate_kbps,
                    "outputBytes": upload_output_bytes,
                    "outputCodec": capture_plan.output_codec.as_str(),
                    "outputPath": output_path.display().to_string(),
                    "outputVbr": capture_plan.output_vbr,
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_job_state(
                config,
                &job,
                "upload_pending",
                Some(&output_path),
                Some(&reason),
            )?;
            Err(error)
        }
    }
}

async fn handle_terminal_controller_job(
    config: &AgentConfig,
    token: &str,
    claimed_job: &ControllerRecordingJob,
    latest: &ControllerRecordingJob,
    capture: &mut CaptureChild,
) -> anyhow::Result<bool> {
    if matches!(latest.status.as_str(), "stop_requested" | "cancelled") {
        capture.stop()?;
        mark_recording_job_cancelled(config, token, &claimed_job.id, "controller_stop_requested")
            .await?;
        write_job_state(
            config,
            latest,
            "cancelled",
            None,
            Some("controller_stop_requested"),
        )?;
        return Ok(true);
    }

    if matches!(latest.status.as_str(), "failed" | "completed") {
        capture.stop()?;
        write_job_state(
            config,
            latest,
            latest.status.as_str(),
            None,
            latest.failure_reason.as_deref(),
        )?;
        return Ok(true);
    }

    Ok(false)
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
    let mut request = controller_http_client_with_ca(input.controller_ca_cert_path)?
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
    let response = controller_http_client(config)?
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

pub async fn post_node_heartbeat(
    config: &AgentConfig,
    token: &str,
    inventory: &NodeInventory,
) -> anyhow::Result<Option<i64>> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, "heartbeat");
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .json(inventory)
        .send()
        .await
        .context("post node heartbeat to controller")?;
    let status = response.status();
    let clock_skew_seconds = response
        .headers()
        .get(DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(controller_clock_skew_seconds);

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected node heartbeat with {status}: {body}");
    }

    Ok(clock_skew_seconds)
}

pub async fn sync_health_event(
    config: &AgentConfig,
    token: &str,
    event: &AgentHealthEvent,
) -> anyhow::Result<()> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, "health-events");
    let response = controller_http_client(config)?
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

pub(crate) async fn append_job_health_event(
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

async fn claim_next_recording_job(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<Option<ControllerRecordingJob>> {
    let url = format!(
        "{}/api/v1/nodes/{}/recording-jobs/claim-next",
        config.controller_url.trim_end_matches('/'),
        config.node_id
    );
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .header(AGENT_ID_HEADER, config.node_id.as_str())
        .send()
        .await
        .context("claim next recording job")?;
    let status = response.status();

    if status.as_u16() == 204 {
        return Ok(None);
    }

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected next job claim with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerRecordingJob>>()
        .await
        .context("decode claimed next recording job")?;

    Ok(Some(envelope.data))
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
    let response = controller_http_client(config)?
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
    let response = controller_http_client(config)?
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

pub(crate) async fn mark_recording_job_failed(
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
    let response = controller_http_client(config)?
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

fn controller_clock_skew_seconds(date_header: &str) -> Option<i64> {
    controller_clock_skew_seconds_at(date_header, OffsetDateTime::now_utc())
}

fn controller_clock_skew_seconds_at(date_header: &str, now: OffsetDateTime) -> Option<i64> {
    let controller_time = OffsetDateTime::parse(date_header, &Rfc2822).ok()?;
    let skew = controller_time - now;

    Some(skew.whole_seconds())
}

pub(crate) fn node_url(controller_url: &str, node_id: &str, suffix: &str) -> String {
    format!(
        "{}/api/v1/nodes/{}/{}",
        controller_url.trim_end_matches('/'),
        node_id,
        suffix.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests;
