use serde_json::json;
use std::path::Path;
use tracing::warn;

use crate::config::AgentConfig;
use crate::controller::{
    CacheFileUpload, ControllerRecordingJob, sync_health_event, upload_cache_file,
};
use crate::health_log;
use crate::recorder_cache_retention::{
    ControllerRecorderCacheRetention, delete_recorder_cache_files, record_uploaded_cache_files,
};
use crate::recording_job_segments::RecoveredCaptureSegment;
use crate::state::{AgentJobState, AgentRecoveredCaptureSegment, write_job_state_snapshot};

pub(crate) struct UploadCheckpoint<'a> {
    pub content_type: &'a str,
    pub duration_seconds: Option<u64>,
    pub file_name: Option<&'a str>,
    pub output_path: &'a Path,
    pub raw_output_path: &'a Path,
    pub recorder_cache_retention: Option<ControllerRecorderCacheRetention>,
    pub recovered_segments: &'a [RecoveredCaptureSegment],
}

pub(crate) fn write_upload_checkpoint_state(
    config: &AgentConfig,
    job: &ControllerRecordingJob,
    status: &str,
    checkpoint: &UploadCheckpoint<'_>,
    reason: Option<&str>,
) -> anyhow::Result<()> {
    write_job_state_snapshot(
        config,
        AgentJobState {
            job_id: job.id.clone(),
            node_id: job.node_id.clone(),
            output_path: Some(checkpoint.output_path.display().to_string()),
            reason: reason.map(str::to_string),
            raw_output_path: Some(checkpoint.raw_output_path.display().to_string()),
            recording_id: job.recording_id.clone(),
            recorder_cache_retention: checkpoint.recorder_cache_retention.clone(),
            recovered_segments: checkpoint
                .recovered_segments
                .iter()
                .map(state_segment)
                .collect(),
            status: status.to_string(),
            updated_at: crate::telemetry::now_rfc3339(),
            upload_content_type: Some(checkpoint.content_type.to_string()),
            upload_duration_seconds: checkpoint.duration_seconds,
            upload_file_name: checkpoint.file_name.map(str::to_string),
            chunk_total: None,
            uploaded_chunk_count: None,
            pending_chunks: Vec::new(),
        },
    )
}

pub(crate) async fn apply_recovered_upload_retention(
    config: &AgentConfig,
    token: &str,
    state: &AgentJobState,
    retention: &ControllerRecorderCacheRetention,
    raw_output_path: &Path,
    output_path: &Path,
) -> anyhow::Result<()> {
    if !retention.delete_after_upload {
        let track_result = record_uploaded_cache_files(
            &config.recorder_cache_manifest_file,
            &state.recording_id,
            retention,
            raw_output_path,
            output_path,
        );

        match track_result {
            Ok(()) => {
                append_recovered_retention_event(
                    config,
                    token,
                    state,
                    "agent.recording_job.recorder_cache_tracked",
                    "info",
                    json!({
                        "jobId": state.job_id.as_str(),
                        "maxAgeDays": retention.max_age_days,
                        "maxBytes": retention.max_bytes,
                        "policyId": retention.policy_id.as_str(),
                        "recordingId": state.recording_id.as_str(),
                        "recoveredAfterRestart": true,
                    }),
                )
                .await?;
            }
            Err(error) => {
                append_recovered_retention_event(
                    config,
                    token,
                    state,
                    "agent.recording_job.recorder_cache_track_failed",
                    "warning",
                    json!({
                        "error": error.to_string(),
                        "jobId": state.job_id.as_str(),
                        "policyId": retention.policy_id.as_str(),
                        "recordingId": state.recording_id.as_str(),
                        "recoveredAfterRestart": true,
                    }),
                )
                .await?;
            }
        }

        return Ok(());
    }

    let cleanup = delete_recorder_cache_files(raw_output_path, output_path);

    if cleanup.errors.is_empty() {
        append_recovered_retention_event(
            config,
            token,
            state,
            "agent.recording_job.recorder_cache_deleted",
            "info",
            json!({
                "deletedPaths": cleanup.deleted_paths,
                "jobId": state.job_id.as_str(),
                "policyId": retention.policy_id.as_str(),
                "recordingId": state.recording_id.as_str(),
                "recoveredAfterRestart": true,
            }),
        )
        .await?;
    } else {
        append_recovered_retention_event(
            config,
            token,
            state,
            "agent.recording_job.recorder_cache_delete_failed",
            "warning",
            json!({
                "deletedPaths": cleanup.deleted_paths,
                "errors": cleanup.errors,
                "jobId": state.job_id.as_str(),
                "policyId": retention.policy_id.as_str(),
                "recordingId": state.recording_id.as_str(),
                "recoveredAfterRestart": true,
            }),
        )
        .await?;
    }

    Ok(())
}

async fn append_recovered_retention_event(
    config: &AgentConfig,
    token: &str,
    state: &AgentJobState,
    event_type: &str,
    severity: &str,
    details: serde_json::Value,
) -> anyhow::Result<()> {
    let event = health_log::append_health_event_with_targets(
        config,
        event_type,
        severity,
        details,
        Some(state.recording_id.clone()),
        None,
    )?;

    if let Err(error) = sync_health_event(config, token, &event).await {
        warn!(
            error = %error,
            job_id = %state.job_id,
            event_type = event_type,
            "failed to sync recovered retention health event"
        );
    }

    Ok(())
}

fn state_segment(segment: &RecoveredCaptureSegment) -> AgentRecoveredCaptureSegment {
    AgentRecoveredCaptureSegment {
        attempt: segment.attempt,
        bytes: segment.bytes,
        path: segment.path.display().to_string(),
        reason: segment.reason.clone(),
    }
}

pub(crate) struct RenditionUploadInputs<'a> {
    pub config: &'a AgentConfig,
    pub token: &'a str,
    pub job: &'a ControllerRecordingJob,
    pub capture_plan: &'a crate::capture::CapturePlan,
    pub content_type: &'a str,
    pub duration_seconds: u64,
    pub file_name: &'a str,
    pub output_path: &'a Path,
    pub raw_output_path: &'a Path,
    /// 1-based chunk index for chunked recordings; `None` for whole recordings.
    pub chunk_index: Option<u32>,
    /// Total chunk count, sent only on the FINAL chunk's primary upload.
    pub chunk_total: Option<u32>,
}

/// Render the best-effort enhanced rendition and upload the recording's renditions:
/// the enhanced file as the primary (`rendition=enhanced`) plus the raw render as a
/// supplementary master (`rendition=raw`) when keepRaw, falling back to a single
/// legacy upload of the raw render when no enhanced rendition is produced. Returns
/// the primary upload result so the caller drives the job lifecycle.
pub(crate) async fn upload_recording_renditions(
    inputs: RenditionUploadInputs<'_>,
) -> anyhow::Result<()> {
    let RenditionUploadInputs {
        config,
        token,
        job,
        capture_plan,
        content_type,
        duration_seconds,
        file_name,
        output_path,
        raw_output_path,
        chunk_index,
        chunk_total,
    } = inputs;

    let enhanced_path =
        match crate::enhanced_render::render_enhanced_output(capture_plan, raw_output_path) {
            Ok(path) => path,
            Err(error) => {
                append_job_upload_warning(
                    config,
                    token,
                    job,
                    "agent.recording_job.enhancement_failed",
                    error.to_string(),
                )
                .await;
                None
            }
        };
    let keep_raw = capture_plan
        .enhancement
        .as_ref()
        .is_none_or(|enhancement| enhancement.keep_raw);

    // Primary: enhanced when available (rendition=enhanced), otherwise the raw
    // render as the legacy primary.
    let primary_path = enhanced_path.as_deref().unwrap_or(output_path);
    let result = upload_cache_file(CacheFileUpload {
        allow_insecure_controller: config.allow_insecure_controller,
        content_type,
        controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
        controller_url: &config.controller_url,
        duration_seconds: Some(duration_seconds),
        file_name: Some(file_name.to_string()),
        file_path: primary_path,
        job_id: Some(&job.id),
        recording_id: &job.recording_id,
        rendition: enhanced_path.as_ref().map(|_| "enhanced"),
        chunk_index,
        // chunkTotal rides the primary (job-completing) upload of the final chunk.
        chunk_total,
        token,
    })
    .await;

    // Supplementary raw master so the player/monitor toggle has both renditions.
    let raw_outcome = if result.is_ok() && enhanced_path.is_some() && keep_raw {
        let raw_upload = upload_cache_file(CacheFileUpload {
            allow_insecure_controller: config.allow_insecure_controller,
            content_type,
            controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
            controller_url: &config.controller_url,
            duration_seconds: Some(duration_seconds),
            file_name: Some(file_name.to_string()),
            file_path: output_path,
            job_id: Some(&job.id),
            recording_id: &job.recording_id,
            rendition: Some("raw"),
            chunk_index,
            // The supplementary raw upload never carries chunkTotal; only the
            // primary completes the chunked recording.
            chunk_total: None,
            token,
        })
        .await;

        match raw_upload {
            Ok(()) => RawUploadOutcome::Succeeded,
            Err(error) => {
                append_job_upload_warning(
                    config,
                    token,
                    job,
                    "agent.recording_job.raw_rendition_upload_failed",
                    error.to_string(),
                )
                .await;
                RawUploadOutcome::Failed(error)
            }
        }
    } else {
        // keepRaw off, or no enhanced rendition was produced (the raw render is
        // then the primary) — no separate raw master is required.
        RawUploadOutcome::NotAttempted
    };

    resolve_rendition_upload(result, raw_outcome)
}

/// The outcome of the supplementary raw-master upload.
enum RawUploadOutcome {
    /// keepRaw is off, or there is no separate raw upload (raw was the primary).
    NotAttempted,
    Succeeded,
    Failed(anyhow::Error),
}

/// Combine the primary and supplementary-raw upload outcomes into the result the
/// caller drives the job lifecycle with.
///
/// A **required** raw master (`keepRaw`) that failed to upload fails the whole
/// rendition upload. The caller then keeps the job `upload_pending`, does **not**
/// run recorder-cache retention, and retries — so the only local copy of the raw
/// is never deleted before the controller has it. Previously a failed raw upload
/// was swallowed and the primary `Ok` returned, letting the job complete and
/// retention delete the raw: "raw is always preserved" was violated.
fn resolve_rendition_upload(
    primary: anyhow::Result<()>,
    raw: RawUploadOutcome,
) -> anyhow::Result<()> {
    // Primary (enhanced, or the legacy raw-as-primary) failure dominates.
    primary?;

    match raw {
        RawUploadOutcome::NotAttempted | RawUploadOutcome::Succeeded => Ok(()),
        RawUploadOutcome::Failed(error) => Err(error),
    }
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

async fn append_job_upload_warning(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    event_type: &str,
    error: String,
) {
    let _ = append_job_health_event(
        config,
        token,
        job,
        event_type,
        "warning",
        json!({
            "error": error,
            "jobId": job.id.as_str(),
            "recordingId": job.recording_id.as_str(),
        }),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_raw_upload_failure_fails_the_whole_upload() {
        // Regression for the raw-master data-loss path: a failed supplementary
        // raw upload must fail the rendition upload so the caller keeps the job
        // upload_pending and never lets retention delete the only local raw.
        // Pre-fix this returned the primary's Ok and the raw was silently lost.
        let result =
            resolve_rendition_upload(Ok(()), RawUploadOutcome::Failed(anyhow::anyhow!("blip")));

        assert!(
            result.is_err(),
            "a required raw upload failure must fail the upload"
        );
    }

    #[test]
    fn succeeded_or_absent_raw_keeps_the_primary_ok() {
        assert!(resolve_rendition_upload(Ok(()), RawUploadOutcome::Succeeded).is_ok());
        assert!(resolve_rendition_upload(Ok(()), RawUploadOutcome::NotAttempted).is_ok());
    }

    #[test]
    fn primary_failure_dominates_regardless_of_raw() {
        assert!(
            resolve_rendition_upload(Err(anyhow::anyhow!("primary")), RawUploadOutcome::Succeeded)
                .is_err()
        );
        assert!(
            resolve_rendition_upload(
                Err(anyhow::anyhow!("primary")),
                RawUploadOutcome::NotAttempted,
            )
            .is_err()
        );
    }
}
