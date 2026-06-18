use anyhow::Context;
use reqwest::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use serde::Deserialize;
use std::fs;
use std::time::Duration;
use tracing::info;

use crate::capture::{CapturePlan, local_capture_path, spawn_capture_plan};
use crate::config::AgentConfig;
use crate::health_log::AgentHealthEvent;
use crate::state::write_job_state;
use crate::telemetry::MeterFrame;

const DURATION_HEADER: &str = "x-rakkr-duration-seconds";
const FILE_NAME_HEADER: &str = "x-rakkr-file-name";
const AGENT_ID_HEADER: &str = "x-rakkr-agent-id";
const JOB_ID_HEADER: &str = "x-rakkr-recording-job-id";

pub struct CacheFileUpload<'a> {
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
    pub capture_sample_rate: u32,
    pub duration_seconds: u64,
    pub output_file_name: String,
}

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
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
    let mut capture = spawn_capture_plan(&CapturePlan {
        channels: job.command.capture_channels,
        command: config.capture_command.clone(),
        device: job.command.capture_device.clone(),
        format: job.command.capture_format.clone(),
        output_path: local_capture_path(&job.command.output_file_name),
        sample_rate: job.command.capture_sample_rate,
        seconds: job.command.duration_seconds,
    })?;
    let output_path = loop {
        if let Some(output_path) = capture.try_complete()? {
            write_job_state(config, &job, "captured", Some(&output_path), None)?;
            break output_path;
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

    let upload_result = upload_cache_file(CacheFileUpload {
        content_type: "audio/wav",
        controller_url: &config.controller_url,
        duration_seconds: Some(job.command.duration_seconds),
        file_name: output_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string),
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
            write_job_state(config, &job, "failed", Some(&output_path), Some(&reason))?;
            Err(error)
        }
    }
}

pub async fn upload_cache_file(input: CacheFileUpload<'_>) -> anyhow::Result<()> {
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
}
