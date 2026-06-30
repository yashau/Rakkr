//! Chunked recording job loop.
//!
//! Mirrors the single-file capture loop in `controller.rs`, but the job records
//! ONE gapless capture (see `chunked_capture`) and emits fixed-length chunk files.
//! As each chunk closes it is rendered (raw + enhanced) and uploaded to the
//! controller immediately via the cache-file PUT tagged with its chunk index. The
//! job stays open (heartbeating) until the configured duration elapses (wall-clock)
//! or the controller requests a stop; the trailing partial is flushed on a graceful
//! finish and discarded on a hard stop/cancel.
//!
//! There is ONE recording + ONE job owning N chunks. `chunkTotal` is sent only on
//! the FINAL chunk's primary upload, signalling completion to the controller.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use tracing::warn;

use crate::cache_content_type::content_type_for_codec;
use crate::capture::CapturePlan;
use crate::channel_map::render_capture_output;
use crate::chunked_capture::{ChunkPlan, ClosedChunk, spawn_chunked_capture};
use crate::config::AgentConfig;
use crate::controller::{
    ControllerRecordingJob, fetch_recording_job, heartbeat_recording_job,
    mark_recording_job_cancelled, mark_recording_job_failed,
};
use crate::recording_job_upload::{
    RenditionUploadInputs, append_job_health_event, upload_recording_renditions,
};
use crate::state::{AgentJobState, AgentPendingChunk, write_job_state_snapshot};

const CHUNK_UPLOAD_RETRY_ATTEMPTS: u8 = 3;

/// One chunk that has been rendered locally and is awaiting (or has completed) its
/// controller upload, tracked so leftover pending work survives a restart.
struct PendingChunk {
    index: u32,
    output_path: std::path::PathBuf,
    raw_output_path: std::path::PathBuf,
}

/// Disk-preflight plan for a job: chunked jobs are sized to a few chunk lengths
/// (a gapless pipe holds at most one open chunk plus working copies on disk at a
/// time), single-file jobs keep their full-duration plan.
pub(crate) fn chunked_disk_plan(
    capture_plan: &CapturePlan,
    chunked_plan: Option<&ChunkPlan>,
) -> CapturePlan {
    let mut plan = capture_plan.clone();

    if let Some(chunk_plan) = chunked_plan {
        plan.seconds = crate::capture::chunk_disk_estimate_seconds(chunk_plan.chunk_seconds);
    }

    plan
}

/// Note when a chunk length was requested but the job took the single-file path
/// (shared capture group, or JACK backend which has no clean stdout PCM stream), so
/// operators can see why chunking did not engage. No-op when chunking was not asked.
pub(crate) async fn report_chunked_fallback(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    chunk_seconds: Option<u64>,
    has_secondaries: bool,
) -> anyhow::Result<()> {
    if chunk_seconds.is_none_or(|seconds| seconds == 0) {
        return Ok(());
    }

    let reason = if has_secondaries {
        "shared_capture_group"
    } else if capture_plan.backend == crate::config::CaptureBackend::Jack {
        "jack_backend_unsupported"
    } else {
        return Ok(());
    };

    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.chunked_fallback",
        "info",
        json!({
            "jobId": job.id.as_str(),
            "reason": reason,
            "recordingId": job.recording_id.as_str(),
        }),
    )
    .await
}

/// Run a chunked recording job. Returns `Ok(())` on every terminal outcome the
/// agent owns (completed / partial / cancelled); only unrecoverable control-plane
/// or spawn errors bubble up so the worker logs them like the single-file path.
pub(crate) async fn run_chunked_recording_job(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    chunk_plan: &ChunkPlan,
) -> anyhow::Result<()> {
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.chunked_started",
        "info",
        json!({
            "chunkSeconds": chunk_plan.chunk_seconds,
            "device": capture_plan.device.as_str(),
            "durationSeconds": job.command.duration_seconds,
            "jobId": job.id.as_str(),
            "recordingId": job.recording_id.as_str(),
        }),
    )
    .await?;

    let mut capture = match spawn_chunked_capture(capture_plan, chunk_plan) {
        Ok(capture) => capture,
        Err(error) => {
            let reason = error.to_string();

            let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
            append_job_health_event(
                config,
                token,
                job,
                "agent.recording_job.capture_start_failed",
                "critical",
                json!({
                    "chunkSeconds": chunk_plan.chunk_seconds,
                    "command": capture_plan.command.as_str(),
                    "device": capture_plan.device.as_str(),
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
            write_chunked_job_state(config, job, "failed", 0, &[], Some(&reason), None)?;

            return Err(error);
        }
    };

    let started_at = Instant::now();
    let duration = Duration::from_secs(job.command.duration_seconds.max(1));
    let mut uploaded_chunks = 0_u32;
    let mut pending: Vec<PendingChunk> = Vec::new();
    let mut control_plane_sync_failed = false;

    write_chunked_job_state(
        config,
        job,
        "running",
        uploaded_chunks,
        &pending,
        None,
        None,
    )?;

    loop {
        // 1) Finalize + upload every chunk that has closed since the last poll.
        for closed in capture.poll_closed_chunks() {
            finalize_and_upload_chunk(
                config,
                token,
                job,
                capture_plan,
                chunk_plan,
                &closed,
                None,
                &mut uploaded_chunks,
                &mut pending,
            )
            .await?;
        }

        // 2) Heartbeat secondaries first (best effort) then the primary, mirroring
        //    the single-file loop's lease-keeping order.
        if let Err(error) = heartbeat_recording_job(config, token, &job.id).await {
            control_plane_sync_failed = report_chunked_sync_failure(
                config,
                token,
                job,
                error.to_string(),
                control_plane_sync_failed,
            )
            .await?;
        } else if control_plane_sync_failed {
            control_plane_sync_failed = false;
            append_job_health_event(
                config,
                token,
                job,
                "agent.recording_job.control_plane_recovered",
                "info",
                json!({
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
        }

        // 3) Growth/stall + device-loss watch on the open segment. A gapless pipe
        //    cannot be transparently restarted, so this is terminal at the boundary;
        //    chunks already uploaded are safe and the job completes as `partial`.
        if let Some(reason) = chunked_failure_reason(&mut capture) {
            let _ = capture.stop();

            return finish_partial_after_failure(
                config,
                token,
                job,
                chunk_plan,
                &reason,
                uploaded_chunks,
                &pending,
            )
            .await;
        }

        // 4) Controller-driven stop/cancel discards the open partial.
        match fetch_recording_job(config, token, &job.id).await {
            Ok(latest) if matches!(latest.status.as_str(), "stop_requested" | "cancelled") => {
                let _ = capture.stop();
                mark_recording_job_cancelled(config, token, &job.id, "controller_stop_requested")
                    .await?;
                write_chunked_job_state(
                    config,
                    job,
                    "cancelled",
                    uploaded_chunks,
                    &[],
                    Some("controller_stop_requested"),
                    None,
                )?;
                append_job_health_event(
                    config,
                    token,
                    job,
                    "agent.recording_job.chunked_cancelled",
                    "warning",
                    json!({
                        "jobId": job.id.as_str(),
                        "recordingId": job.recording_id.as_str(),
                        "uploadedChunkCount": uploaded_chunks,
                    }),
                )
                .await?;

                return Ok(());
            }
            Ok(latest) if matches!(latest.status.as_str(), "failed" | "completed") => {
                // Controller already terminal: flush what we have and finish.
                return finish_chunked_capture(
                    config,
                    token,
                    job,
                    capture_plan,
                    chunk_plan,
                    &mut capture,
                    &mut uploaded_chunks,
                    &mut pending,
                )
                .await;
            }
            Ok(_) => {}
            Err(error) => {
                control_plane_sync_failed = report_chunked_sync_failure(
                    config,
                    token,
                    job,
                    error.to_string(),
                    control_plane_sync_failed,
                )
                .await?;
            }
        }

        // 5) Natural duration elapse (wall-clock) -> graceful finish flushes the
        //    trailing partial chunk.
        if started_at.elapsed() >= duration {
            return finish_chunked_capture(
                config,
                token,
                job,
                capture_plan,
                chunk_plan,
                &mut capture,
                &mut uploaded_chunks,
                &mut pending,
            )
            .await;
        }

        tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
    }
}

/// Gracefully flush the capture, upload the trailing chunk(s) (tagging the final
/// upload with `chunkTotal`), emit the completion health event, and write the
/// terminal job state.
#[allow(clippy::too_many_arguments)]
async fn finish_chunked_capture(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    chunk_plan: &ChunkPlan,
    capture: &mut crate::chunked_capture::ChunkedCapture,
    uploaded_chunks: &mut u32,
    pending: &mut Vec<PendingChunk>,
) -> anyhow::Result<()> {
    let trailing = match capture.finish() {
        Ok(trailing) => trailing,
        Err(error) => {
            let reason = error.to_string();

            // The segmenter drain failed; chunks already uploaded are still safe.
            return finish_partial_after_failure(
                config,
                token,
                job,
                chunk_plan,
                &reason,
                *uploaded_chunks,
                pending,
            )
            .await;
        }
    };

    let total_chunks = trailing
        .iter()
        .map(|chunk| chunk.index + 1)
        .max()
        .unwrap_or(*uploaded_chunks);

    for (offset, closed) in trailing.iter().enumerate() {
        // chunkTotal rides only the FINAL chunk's primary upload.
        let chunk_total = if offset + 1 == trailing.len() {
            Some(total_chunks)
        } else {
            None
        };

        finalize_and_upload_chunk(
            config,
            token,
            job,
            capture_plan,
            chunk_plan,
            closed,
            chunk_total,
            uploaded_chunks,
            pending,
        )
        .await?;
    }

    if !pending.is_empty() {
        // Some chunk uploads exhausted their retries; keep the recording as a
        // partial with the leftover chunks persisted for restart recovery.
        let reason = "chunk_upload_retries_exhausted";

        write_chunked_job_state(
            config,
            job,
            "partial",
            *uploaded_chunks,
            pending,
            Some(reason),
            Some(total_chunks),
        )?;
        append_job_health_event(
            config,
            token,
            job,
            "agent.recording_job.chunked_partial",
            "warning",
            json!({
                "chunkTotal": total_chunks,
                "jobId": job.id.as_str(),
                "pendingChunkCount": pending.len(),
                "reason": reason,
                "recordingId": job.recording_id.as_str(),
                "uploadedChunkCount": *uploaded_chunks,
            }),
        )
        .await?;

        return Ok(());
    }

    write_chunked_job_state(
        config,
        job,
        "completed",
        *uploaded_chunks,
        &[],
        None,
        Some(total_chunks),
    )?;
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.chunked_completed",
        "info",
        json!({
            "chunkSeconds": chunk_plan.chunk_seconds,
            "chunkTotal": total_chunks,
            "jobId": job.id.as_str(),
            "recordingId": job.recording_id.as_str(),
            "uploadedChunkCount": *uploaded_chunks,
        }),
    )
    .await?;

    Ok(())
}

/// Render and upload a single closed chunk (raw + enhanced) with bounded retries.
/// On a successful primary upload the chunk's local working files are deleted
/// (per-chunk retention). On retry exhaustion a warning is emitted and the chunk is
/// persisted as pending — capture KEEPS running, mirroring the "control-plane sync
/// failed but capture continues" philosophy.
#[allow(clippy::too_many_arguments)]
async fn finalize_and_upload_chunk(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    chunk_plan: &ChunkPlan,
    closed: &ClosedChunk,
    chunk_total: Option<u32>,
    uploaded_chunks: &mut u32,
    pending: &mut Vec<PendingChunk>,
) -> anyhow::Result<()> {
    let chunk_capture_plan = capture_plan.chunk_plan(
        &chunk_plan.dir,
        &chunk_plan.stem,
        closed.index,
        &closed.path,
    );

    // Render the per-chunk output (channel-map/codec) from the closed segment.
    let output_path = match render_capture_output(&chunk_capture_plan, &closed.path) {
        Ok(path) => path,
        Err(error) => {
            let reason = error.to_string();

            append_job_health_event(
                config,
                token,
                job,
                "agent.recording_job.chunk_render_failed",
                "warning",
                json!({
                    "chunkIndex": closed.index,
                    "error": reason.as_str(),
                    "jobId": job.id.as_str(),
                    "rawOutputPath": closed.path.display().to_string(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;

            return Ok(());
        }
    };
    let content_type = content_type_for_codec(job.command.output_codec.as_deref(), &output_path);
    let file_name = chunk_upload_file_name(&job.command.output_file_name, closed.index);

    let mut attempt = 0_u8;
    let upload_result = loop {
        attempt += 1;
        let result = upload_recording_renditions(RenditionUploadInputs {
            capture_plan: &chunk_capture_plan,
            config,
            content_type,
            duration_seconds: closed.seconds,
            file_name: &file_name,
            job,
            output_path: &output_path,
            raw_output_path: &closed.path,
            chunk_index: Some(closed.index),
            chunk_total,
            token,
        })
        .await;

        match result {
            Ok(()) => break Ok(()),
            Err(error) if attempt < CHUNK_UPLOAD_RETRY_ATTEMPTS => {
                warn!(
                    error = %error,
                    chunk_index = closed.index,
                    job_id = %job.id,
                    "chunk upload failed; retrying"
                );
                tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
            }
            Err(error) => break Err(error),
        }
    };

    match upload_result {
        Ok(()) => {
            *uploaded_chunks += 1;
            // Per-chunk retention: drop the local working files now the controller
            // has the chunk.
            delete_chunk_working_files(&closed.path, &output_path);
            append_job_health_event(
                config,
                token,
                job,
                "agent.recording_job.chunk_uploaded",
                "info",
                json!({
                    "chunkIndex": closed.index,
                    "chunkSeconds": closed.seconds,
                    "chunkTotal": chunk_total,
                    "fileName": file_name.as_str(),
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                    "uploadedChunkCount": *uploaded_chunks,
                }),
            )
            .await?;
        }
        Err(error) => {
            warn!(
                error = %error,
                chunk_index = closed.index,
                job_id = %job.id,
                "chunk upload exhausted retries; keeping capture running"
            );
            pending.push(PendingChunk {
                index: closed.index,
                output_path,
                raw_output_path: closed.path.clone(),
            });
            append_job_health_event(
                config,
                token,
                job,
                "agent.recording_job.chunk_upload_failed",
                "warning",
                json!({
                    "attempts": CHUNK_UPLOAD_RETRY_ATTEMPTS,
                    "chunkIndex": closed.index,
                    "error": error.to_string(),
                    "jobId": job.id.as_str(),
                    "recordingId": job.recording_id.as_str(),
                }),
            )
            .await?;
        }
    }

    write_chunked_job_state(
        config,
        job,
        "running",
        *uploaded_chunks,
        pending,
        None,
        chunk_total,
    )?;

    Ok(())
}

/// Detect a terminal capture failure on the open segment: a stalled/disconnected
/// device (growth monitor) or the source process exiting abnormally. Returns the
/// failure reason, or `None` while capture is healthy.
fn chunked_failure_reason(capture: &mut crate::chunked_capture::ChunkedCapture) -> Option<String> {
    if let Err(error) = capture.check_growth() {
        return Some(error.to_string());
    }

    match capture.source_exited() {
        Ok(Some(false)) => Some("capture source process exited unexpectedly".to_string()),
        _ => None,
    }
}

/// Complete a chunked recording as `partial` after a terminal capture failure:
/// already-uploaded chunks are safe, so this records the partial outcome instead of
/// routing through the single-file stitch recovery (a gapless pipe cannot be
/// transparently restarted). Fails only when zero chunks were uploaded.
async fn finish_partial_after_failure(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    chunk_plan: &ChunkPlan,
    reason: &str,
    uploaded_chunks: u32,
    pending: &[PendingChunk],
) -> anyhow::Result<()> {
    if uploaded_chunks == 0 && pending.is_empty() {
        let _ = mark_recording_job_failed(config, token, &job.id, reason).await;
        write_chunked_job_state(config, job, "failed", 0, &[], Some(reason), None)?;
        append_job_health_event(
            config,
            token,
            job,
            "agent.recording_job.capture_failed",
            "critical",
            json!({
                "chunkSeconds": chunk_plan.chunk_seconds,
                "error": reason,
                "jobId": job.id.as_str(),
                "recordingId": job.recording_id.as_str(),
                "uploadedChunkCount": 0,
            }),
        )
        .await?;

        return Err(anyhow::anyhow!(reason.to_string()));
    }

    write_chunked_job_state(
        config,
        job,
        "partial",
        uploaded_chunks,
        pending,
        Some(reason),
        None,
    )?;
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.chunked_partial",
        "warning",
        json!({
            "chunkSeconds": chunk_plan.chunk_seconds,
            "error": reason,
            "jobId": job.id.as_str(),
            "pendingChunkCount": pending.len(),
            "recordingId": job.recording_id.as_str(),
            "uploadedChunkCount": uploaded_chunks,
        }),
    )
    .await?;

    Ok(())
}

async fn report_chunked_sync_failure(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    reason: String,
    already_reported: bool,
) -> anyhow::Result<bool> {
    if already_reported {
        warn!(
            error = %reason,
            job_id = %job.id,
            "chunked recording control plane sync still failing"
        );
        return Ok(true);
    }

    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.control_plane_failed",
        "warning",
        json!({
            "error": reason.as_str(),
            "jobId": job.id.as_str(),
            "recordingId": job.recording_id.as_str(),
        }),
    )
    .await?;
    warn!(
        error = %reason,
        job_id = %job.id,
        "chunked recording control plane sync failed; capture will continue"
    );

    Ok(true)
}

fn delete_chunk_working_files(raw_output_path: &Path, output_path: &Path) {
    let _ = fs::remove_file(raw_output_path);

    if output_path != raw_output_path {
        let _ = fs::remove_file(output_path);
    }
}

/// Build the per-chunk upload file name, inserting `.chunk-NNNN` before the
/// extension so the controller can keep chunk files distinct
/// (`rec_42.wav` -> `rec_42.chunk-0003.wav`).
pub(crate) fn chunk_upload_file_name(output_file_name: &str, index: u32) -> String {
    let path = Path::new(output_file_name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("wav");
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording");

    format!("{stem}.chunk-{index:04}.{extension}")
}

#[allow(clippy::too_many_arguments)]
fn write_chunked_job_state(
    config: &AgentConfig,
    job: &ControllerRecordingJob,
    status: &str,
    uploaded_chunks: u32,
    pending: &[PendingChunk],
    reason: Option<&str>,
    chunk_total: Option<u32>,
) -> anyhow::Result<()> {
    write_job_state_snapshot(
        config,
        AgentJobState {
            job_id: job.id.clone(),
            node_id: job.node_id.clone(),
            output_path: None,
            reason: reason.map(str::to_string),
            raw_output_path: None,
            recording_id: job.recording_id.clone(),
            recorder_cache_retention: job.command.recorder_cache_retention.clone(),
            recovered_segments: Vec::new(),
            status: status.to_string(),
            updated_at: crate::telemetry::now_rfc3339(),
            upload_content_type: None,
            upload_duration_seconds: None,
            upload_file_name: None,
            chunk_total,
            uploaded_chunk_count: Some(uploaded_chunks),
            pending_chunks: pending.iter().map(state_pending_chunk).collect(),
        },
    )
}

fn state_pending_chunk(chunk: &PendingChunk) -> AgentPendingChunk {
    AgentPendingChunk {
        index: chunk.index,
        output_path: chunk.output_path.display().to_string(),
        raw_output_path: chunk.raw_output_path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_chunk_upload_file_name_with_zero_padded_index() {
        assert_eq!(
            chunk_upload_file_name("rec_42.wav", 0),
            "rec_42.chunk-0000.wav"
        );
        assert_eq!(
            chunk_upload_file_name("rec_42.wav", 3),
            "rec_42.chunk-0003.wav"
        );
        assert_eq!(
            chunk_upload_file_name("meeting.flac", 12),
            "meeting.chunk-0012.flac"
        );
    }

    #[test]
    fn chunk_upload_file_name_falls_back_for_extensionless_names() {
        assert_eq!(
            chunk_upload_file_name("recording", 1),
            "recording.chunk-0001.wav"
        );
    }
}
