use anyhow::Context;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use tracing::warn;

use crate::cache_content_type::content_type_for_codec;
use crate::config::AgentConfig;
use crate::controller::{
    CacheFileUpload, mark_recording_job_failed, sync_health_event, upload_cache_file,
};
use crate::health_log;
use crate::recording_job_recovery_chunk_total::recovered_chunk_total;
use crate::state::{AgentJobState, write_job_state_snapshot};

pub(super) fn is_chunked_job_state(state: &AgentJobState) -> bool {
    state.chunk_total.is_some()
        || state.uploaded_chunk_count.is_some()
        || !state.pending_chunks.is_empty()
}

/// Restart recovery for a chunked recording: re-upload each locally-persisted but
/// unuploaded chunk, then complete (or fail only when zero chunks ever uploaded and
/// none can be recovered). Already-uploaded chunks are safe and never re-sent.
pub(super) async fn reconcile_previous_chunked_recording_job(
    config: &AgentConfig,
    token: &str,
    state: AgentJobState,
) -> anyhow::Result<()> {
    let mut uploaded = state.uploaded_chunk_count.unwrap_or(0);
    let chunk_total = recovered_chunk_total(&state);
    let mut remaining: Vec<crate::state::AgentPendingChunk> = Vec::new();

    let event = health_log::append_health_event_with_targets(
        config,
        "agent.recording_job.recovered_after_restart",
        "warning",
        json!({
            "chunkTotal": chunk_total,
            "chunked": true,
            "jobId": state.job_id.as_str(),
            "nodeId": state.node_id.as_str(),
            "pendingChunkCount": state.pending_chunks.len(),
            "previousStatus": state.status.as_str(),
            "recordingId": state.recording_id.as_str(),
            "stateUpdatedAt": state.updated_at.as_str(),
            "uploadedChunkCount": uploaded,
        }),
        Some(state.recording_id.clone()),
        None,
    )?;

    if let Err(error) = sync_health_event(config, token, &event).await {
        warn!(
            error = %error,
            job_id = %state.job_id,
            "failed to sync chunked recovered-after-restart health event"
        );
    }

    for chunk in &state.pending_chunks {
        let output_path = PathBuf::from(&chunk.output_path);

        if fs::metadata(&output_path).is_err() {
            // Working file is gone (already cleaned or never written); skip it.
            continue;
        }

        // Capture already ended before this recovery, so the total is final and
        // known. Stamp it on EVERY recovered chunk upload rather than an
        // index-equality match: when the pending chunks are the low indices (an
        // early chunk failed while later ones uploaded), no pending index equals
        // the total, so an `index + 1 == total` marker never fired and the
        // controller never finalized. Sending it on each upload is idempotent
        // (setRecordingChunkTotal + finalize) and guarantees delivery.
        let chunk_total_marker = chunk_total;
        let upload = upload_cache_file(CacheFileUpload {
            allow_insecure_controller: config.allow_insecure_controller,
            content_type: content_type_for_codec(None, &output_path),
            controller_ca_cert_path: config.controller_ca_cert_path.as_deref(),
            controller_url: &config.controller_url,
            duration_seconds: None,
            file_name: output_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string),
            file_path: &output_path,
            job_id: Some(&state.job_id),
            recording_id: &state.recording_id,
            rendition: None,
            chunk_index: Some(chunk.index),
            chunk_total: chunk_total_marker,
            token,
        })
        .await;

        match upload {
            Ok(()) => {
                uploaded += 1;
                let _ = fs::remove_file(&output_path);
                let _ = fs::remove_file(PathBuf::from(&chunk.raw_output_path));
            }
            Err(error) => {
                warn!(
                    error = %error,
                    chunk_index = chunk.index,
                    job_id = %state.job_id,
                    "failed to re-upload recovered chunk"
                );
                remaining.push(chunk.clone());
            }
        }
    }

    if uploaded == 0 && remaining.is_empty() {
        let reason = "agent_restarted_during_chunked_recording";

        mark_recording_job_failed(config, token, &state.job_id, reason)
            .await
            .with_context(|| {
                format!(
                    "mark interrupted chunked recording job {} failed during startup recovery",
                    state.job_id
                )
            })?;
        write_job_state_snapshot(
            config,
            AgentJobState {
                pending_chunks: Vec::new(),
                reason: Some(reason.to_string()),
                status: "failed".to_string(),
                updated_at: crate::telemetry::now_rfc3339(),
                uploaded_chunk_count: Some(0),
                ..state
            },
        )?;

        return Ok(());
    }

    let status = if remaining.is_empty() {
        "completed"
    } else {
        "partial"
    };

    write_job_state_snapshot(
        config,
        AgentJobState {
            pending_chunks: remaining,
            reason: None,
            status: status.to_string(),
            updated_at: crate::telemetry::now_rfc3339(),
            uploaded_chunk_count: Some(uploaded),
            ..state
        },
    )?;

    Ok(())
}
