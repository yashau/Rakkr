use serde_json::json;
use std::path::Path;
use tracing::warn;

use crate::config::AgentConfig;
use crate::controller::{ControllerRecordingJob, sync_health_event};
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
