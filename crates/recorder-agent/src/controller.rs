mod cache_upload;
mod capture_group;
mod job_runner;
mod types;
use crate::cache_content_type::content_type_for_codec;
use crate::capture::CaptureChild;
use crate::channel_map::{capture_plan_for_job, channel_map_details, render_capture_output};
use crate::chunked_capture;
use crate::config::AgentConfig;
use crate::controller_http::controller_http_client;
use crate::health_log::{self, AgentHealthEvent};
use crate::inventory::NodeInventory;
use crate::recording_job_chunked;
use crate::recording_job_disk::{
    RuntimeCaptureDiskRecoveryEvidence, capture_disk_space_shortfall, ensure_capture_disk_space,
    recover_runtime_capture_disk_space, report_capture_disk_space_shortfall,
};
use crate::recording_job_recovery::{
    apply_recorder_cache_retention, recover_runtime_capture_device_loss,
    refresh_capture_device_from_inventory, report_capture_command_failure,
    report_control_plane_sync_failure, spawn_capture_plan_with_recovery,
    write_recoverable_job_state,
};
use crate::recording_job_segments::{
    STITCH_FAILED_REASON, StitchContext, StitchOutcome, report_unrecoverable_capture_segments,
    stitch_recovered_capture_segments,
};
use crate::recording_job_upload::{
    RenditionUploadInputs, UploadCheckpoint, append_job_health_event, upload_recording_renditions,
    write_upload_checkpoint_state,
};
use crate::state::write_job_state;
use crate::telemetry::MeterFrame;
use anyhow::Context;
pub use cache_upload::upload_cache_file;
use capture_group::{
    claim_next_recording_group, finalize_secondary_members, session_capture_channels,
};
pub use job_runner::run_next_recording_job;
use reqwest::header::DATE;
use serde_json::json;
use std::fs;
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc2822};
use tracing::{info, warn};
use types::DataEnvelope;
pub use types::{
    CacheFileUpload, ControllerCaptureCommand, ControllerChannelMapBundle,
    ControllerChannelMapEntry, ControllerRecordingEnhancement, ControllerRecordingJob,
    ControllerRecordingJobChannelMap,
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
        rendition: None,
        chunk_index: None,
        chunk_total: None,
        token,
    })
    .await
}

// Shared POST to a node-scoped controller endpoint. Validates transport, posts
// the JSON body, and bails on a non-success status (the `label` keeps the
// failure messages that health evidence + smokes assert on). Returns the
// validated response so callers can read headers (e.g. heartbeat clock skew).
async fn post_node_endpoint<T: serde::Serialize + ?Sized>(
    config: &AgentConfig,
    token: &str,
    suffix: &str,
    body: &T,
    label: &str,
) -> anyhow::Result<reqwest::Response> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, suffix);
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .with_context(|| format!("post {label} to controller"))?;
    let status = response.status();

    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected {label} with {status}: {detail}");
    }

    Ok(response)
}

pub async fn post_meter_frame(
    config: &AgentConfig,
    token: &str,
    frame: &MeterFrame,
) -> anyhow::Result<()> {
    post_node_endpoint(config, token, "meter-frame", frame, "meter frame").await?;

    Ok(())
}

pub async fn post_node_heartbeat(
    config: &AgentConfig,
    token: &str,
    inventory: &NodeInventory,
) -> anyhow::Result<Option<i64>> {
    let response =
        post_node_endpoint(config, token, "heartbeat", inventory, "node heartbeat").await?;

    Ok(response
        .headers()
        .get(DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(controller_clock_skew_seconds))
}

pub async fn post_node_inventory(
    config: &AgentConfig,
    token: &str,
    inventory: &NodeInventory,
) -> anyhow::Result<()> {
    post_node_endpoint(config, token, "inventory", inventory, "node inventory").await?;

    Ok(())
}

pub async fn sync_health_event(
    config: &AgentConfig,
    token: &str,
    event: &AgentHealthEvent,
) -> anyhow::Result<()> {
    post_node_endpoint(config, token, "health-events", event, "health event").await?;

    Ok(())
}

pub(crate) async fn heartbeat_recording_job(
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

pub(crate) async fn fetch_recording_job(
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

pub(crate) async fn mark_recording_job_cancelled(
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
