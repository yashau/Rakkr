use anyhow::Context;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::warn;

use crate::cache_content_type::content_type_for_codec;
use crate::capture::{
    CaptureChild, CaptureGrowthSnapshot, CapturePlan, estimated_capture_bytes, spawn_capture_plan,
};
use crate::channel_map::channel_map_details;
use crate::config::{AgentConfig, CaptureBackend};
use crate::controller::{
    CacheFileUpload, ControllerRecordingJob, append_job_health_event, mark_recording_job_failed,
    sync_health_event, upload_cache_file,
};
use crate::health_log;
use crate::recorder_cache_retention::{delete_recorder_cache_files, record_uploaded_cache_files};
use crate::recording_job_segments::{
    RecoveredCaptureSegment, RuntimeCaptureRecovery, preserve_recovered_capture_segment,
};
use crate::state::{
    AgentJobState, AgentRecoveredCaptureSegment, read_job_state, write_job_state_snapshot,
};
use crate::system_health;

const RUNTIME_CAPTURE_RETRY_ATTEMPTS: u8 = 3;

pub(crate) async fn reconcile_previous_recording_job(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<()> {
    let Some(state) = read_job_state(config)? else {
        return Ok(());
    };

    if state.is_terminal() {
        return Ok(());
    }

    if let Some(output_path) = recoverable_restart_output_path(&state) {
        let output_bytes = fs::metadata(&output_path)
            .ok()
            .map(|metadata| metadata.len());
        let details = json!({
            "jobId": state.job_id.as_str(),
            "nodeId": state.node_id.as_str(),
            "outputBytes": output_bytes,
            "outputPath": output_path.display().to_string(),
            "previousStatus": state.status.as_str(),
            "recoveredSegmentCount": state.recovered_segments.len(),
            "recoveredSegments": state.recovered_segments.iter().map(|segment| {
                json!({
                    "attempt": segment.attempt,
                    "bytes": segment.bytes,
                    "path": segment.path.as_str(),
                })
            }).collect::<Vec<_>>(),
            "recordingId": state.recording_id.as_str(),
            "stateUpdatedAt": state.updated_at.as_str(),
            "willUpload": true,
        });
        let event = health_log::append_health_event_with_targets(
            config,
            "agent.recording_job.recovered_after_restart",
            "warning",
            details,
            Some(state.recording_id.clone()),
            None,
        )?;

        if let Err(error) = sync_health_event(config, token, &event).await {
            warn!(
                error = %error,
                job_id = %state.job_id,
                "failed to sync recovered-after-restart health event"
            );
        }

        upload_cache_file(CacheFileUpload {
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
            token,
        })
        .await
        .with_context(|| {
            format!(
                "upload recovered recording cache file for interrupted job {}",
                state.job_id
            )
        })?;

        write_job_state_snapshot(
            config,
            AgentJobState {
                reason: None,
                status: "completed".to_string(),
                updated_at: crate::telemetry::now_rfc3339(),
                ..state
            },
        )?;
        return Ok(());
    }

    let output_bytes = state
        .output_path
        .as_deref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len());
    let reason = "agent_restarted_during_recording";
    let details = json!({
        "jobId": state.job_id.as_str(),
        "nodeId": state.node_id.as_str(),
        "outputBytes": output_bytes,
        "outputPath": state.output_path.as_deref(),
        "previousStatus": state.status.as_str(),
        "recordingId": state.recording_id.as_str(),
        "stateUpdatedAt": state.updated_at.as_str(),
    });
    let event = health_log::append_health_event_with_targets(
        config,
        "agent.recording_job.recovered_after_restart",
        "warning",
        details,
        Some(state.recording_id.clone()),
        None,
    )?;

    if let Err(error) = sync_health_event(config, token, &event).await {
        warn!(
            error = %error,
            job_id = %state.job_id,
            "failed to sync recovered-after-restart health event"
        );
    }

    mark_recording_job_failed(config, token, &state.job_id, reason)
        .await
        .with_context(|| {
            format!(
                "mark interrupted recording job {} failed during startup recovery",
                state.job_id
            )
        })?;

    write_job_state_snapshot(
        config,
        AgentJobState {
            reason: Some(reason.to_string()),
            status: "failed".to_string(),
            updated_at: crate::telemetry::now_rfc3339(),
            ..state
        },
    )
}

fn recoverable_restart_output_path(state: &AgentJobState) -> Option<PathBuf> {
    if !matches!(
        state.status.as_str(),
        "running" | "captured" | "rendered" | "upload_pending"
    ) {
        return None;
    }

    let output_path = state.output_path.as_deref().map(PathBuf::from)?;

    fs::metadata(&output_path)
        .ok()
        .filter(|metadata| metadata.len() > 0)
        .map(|_| output_path)
}

pub(crate) fn write_recoverable_job_state(
    config: &AgentConfig,
    job: &ControllerRecordingJob,
    status: &str,
    output_path: Option<&Path>,
    reason: Option<&str>,
    recovered_segments: &[RecoveredCaptureSegment],
) -> anyhow::Result<()> {
    write_job_state_snapshot(
        config,
        AgentJobState {
            job_id: job.id.clone(),
            node_id: job.node_id.clone(),
            output_path: output_path.map(|path| path.display().to_string()),
            reason: reason.map(str::to_string),
            recording_id: job.recording_id.clone(),
            recovered_segments: recovered_segments.iter().map(state_segment).collect(),
            status: status.to_string(),
            updated_at: crate::telemetry::now_rfc3339(),
        },
    )
}

pub(crate) async fn refresh_capture_device_from_inventory(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &mut CapturePlan,
) -> anyhow::Result<()> {
    let Some(capture_interface_id) = job.command.capture_interface_id.as_deref() else {
        return Ok(());
    };

    if capture_plan.backend != CaptureBackend::Alsa {
        return Ok(());
    }

    let inventory = crate::inventory::collect(config);
    let Some(audio_interface) = inventory
        .interfaces
        .iter()
        .find(|candidate| candidate.id == capture_interface_id)
    else {
        return Ok(());
    };
    let Some(system_ref) = audio_interface.system_ref.as_deref() else {
        return Ok(());
    };
    let refreshed_device = system_ref.strip_prefix("alsa:").unwrap_or(system_ref);

    if !is_alsa_capture_device_ref(refreshed_device) || refreshed_device == capture_plan.device {
        return Ok(());
    }

    let previous_device = std::mem::replace(&mut capture_plan.device, refreshed_device.to_string());

    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.capture_device_refreshed",
        "info",
        json!({
            "captureInterfaceId": capture_interface_id,
            "jobId": job.id.as_str(),
            "previousDevice": previous_device,
            "recordingId": job.recording_id.as_str(),
            "refreshedDevice": refreshed_device,
        }),
    )
    .await
}

pub(crate) async fn report_control_plane_sync_failure(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    event_type: &str,
    reason: String,
    already_reported: bool,
) -> anyhow::Result<bool> {
    if already_reported {
        warn!(
            error = %reason,
            job_id = %job.id,
            "recording job control plane sync still failing"
        );
        return Ok(true);
    }

    append_job_health_event(
        config,
        token,
        job,
        event_type,
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
        "recording job control plane sync failed; capture will continue"
    );

    Ok(true)
}

pub(crate) async fn ensure_capture_disk_space(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
) -> anyhow::Result<()> {
    let Some(disk_usage) = system_health::disk_usage(
        &config.system_health_df_command,
        &config.system_health_disk_path,
    ) else {
        return Ok(());
    };
    let required_bytes = estimated_capture_bytes(capture_plan);

    if disk_usage.free_bytes >= required_bytes {
        return Ok(());
    }

    let reason = "insufficient_capture_disk_space";
    let _ = mark_recording_job_failed(config, token, &job.id, reason).await;
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.disk_space_insufficient",
        "critical",
        json!({
            "freeBytes": disk_usage.free_bytes,
            "jobId": job.id.as_str(),
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
            "requiredBytes": required_bytes,
            "systemHealthDiskPath": config.system_health_disk_path.display().to_string(),
            "totalBytes": disk_usage.total_bytes,
            "usedPercent": disk_usage.used_percent,
        }),
    )
    .await?;

    anyhow::bail!(
        "{reason}: required {required_bytes} bytes but only {} bytes free at {}",
        disk_usage.free_bytes,
        config.system_health_disk_path.display()
    );
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CaptureDiskSpaceShortfall {
    pub estimated_capture_bytes: u64,
    pub free_bytes: u64,
    pub remaining_bytes: u64,
    pub written_bytes: u64,
}

impl CaptureDiskSpaceShortfall {
    pub(crate) fn reason(&self) -> String {
        format!(
            "capture_disk_space_exhausted: required {} remaining bytes but only {} bytes free",
            self.remaining_bytes, self.free_bytes
        )
    }
}

pub(crate) fn capture_disk_space_shortfall(
    capture_plan: &CapturePlan,
    growth: &CaptureGrowthSnapshot,
    disk_usage: system_health::DiskUsage,
) -> Option<CaptureDiskSpaceShortfall> {
    let estimated_capture_bytes = estimated_capture_bytes(capture_plan);
    let written_bytes = growth.size_bytes.unwrap_or(0);
    let remaining_bytes = estimated_capture_bytes.saturating_sub(written_bytes);

    if remaining_bytes == 0 || disk_usage.free_bytes >= remaining_bytes {
        return None;
    }

    Some(CaptureDiskSpaceShortfall {
        estimated_capture_bytes,
        free_bytes: disk_usage.free_bytes,
        remaining_bytes,
        written_bytes,
    })
}

pub(crate) async fn report_capture_disk_space_shortfall(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    growth: &CaptureGrowthSnapshot,
    shortfall: &CaptureDiskSpaceShortfall,
) -> anyhow::Result<()> {
    let reason = shortfall.reason();

    let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.disk_space_exhausted",
        "critical",
        json!({
            "estimatedCaptureBytes": shortfall.estimated_capture_bytes,
            "freeBytes": shortfall.free_bytes,
            "growthAgeSeconds": growth.age_seconds,
            "jobId": job.id.as_str(),
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
            "remainingBytes": shortfall.remaining_bytes,
            "systemHealthDiskPath": config.system_health_disk_path.display().to_string(),
            "writtenBytes": shortfall.written_bytes,
        }),
    )
    .await
}

pub(crate) fn is_capture_device_lost(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();

    message.contains("input/output error")
        || message.contains("no such device")
        || message.contains("device disconnected")
        || message.contains("device removed")
        || message.contains("cannot find card")
        || message.contains("unknown pcm")
        || message.contains("broken pipe")
}

pub(crate) async fn report_capture_device_lost(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    reason: &str,
) -> anyhow::Result<()> {
    let _ = mark_recording_job_failed(config, token, &job.id, reason).await;
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.capture_device_lost",
        "critical",
        json!({
            "backend": format!("{:?}", capture_plan.backend).to_ascii_lowercase(),
            "device": capture_plan.device.as_str(),
            "error": reason,
            "jobId": job.id.as_str(),
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
        }),
    )
    .await
}

pub(crate) async fn report_capture_command_failure(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    error: &anyhow::Error,
) -> anyhow::Result<()> {
    let reason = error.to_string();

    if is_capture_device_lost(error) {
        return report_capture_device_lost(config, token, job, capture_plan, &reason).await;
    }

    let _ = mark_recording_job_failed(config, token, &job.id, &reason).await;
    append_job_health_event(
        config,
        token,
        job,
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
    .await
}

pub(crate) async fn apply_recorder_cache_retention(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    raw_output_path: &Path,
    output_path: &Path,
) -> anyhow::Result<()> {
    let Some(retention) = &job.command.recorder_cache_retention else {
        return Ok(());
    };

    if !retention.delete_after_upload {
        let track_result = record_uploaded_cache_files(
            &config.recorder_cache_manifest_file,
            &job.recording_id,
            retention,
            raw_output_path,
            output_path,
        );

        match track_result {
            Ok(()) => {
                append_job_health_event(
                    config,
                    token,
                    job,
                    "agent.recording_job.recorder_cache_tracked",
                    "info",
                    json!({
                        "jobId": job.id.as_str(),
                        "maxAgeDays": retention.max_age_days,
                        "maxBytes": retention.max_bytes,
                        "policyId": retention.policy_id.as_str(),
                        "recordingId": job.recording_id.as_str(),
                    }),
                )
                .await?;
            }
            Err(error) => {
                append_job_health_event(
                    config,
                    token,
                    job,
                    "agent.recording_job.recorder_cache_track_failed",
                    "warning",
                    json!({
                        "error": error.to_string(),
                        "jobId": job.id.as_str(),
                        "policyId": retention.policy_id.as_str(),
                        "recordingId": job.recording_id.as_str(),
                    }),
                )
                .await?;
            }
        }

        return Ok(());
    }

    let cleanup = delete_recorder_cache_files(raw_output_path, output_path);

    if cleanup.errors.is_empty() {
        append_job_health_event(
            config,
            token,
            job,
            "agent.recording_job.recorder_cache_deleted",
            "info",
            json!({
                "deletedPaths": cleanup.deleted_paths,
                "jobId": job.id.as_str(),
                "policyId": retention.policy_id.as_str(),
                "recordingId": job.recording_id.as_str(),
            }),
        )
        .await?;
    } else {
        append_job_health_event(
            config,
            token,
            job,
            "agent.recording_job.recorder_cache_delete_failed",
            "warning",
            json!({
                "deletedPaths": cleanup.deleted_paths,
                "errors": cleanup.errors,
                "jobId": job.id.as_str(),
                "policyId": retention.policy_id.as_str(),
                "recordingId": job.recording_id.as_str(),
            }),
        )
        .await?;
    }

    Ok(())
}

pub(crate) async fn recover_runtime_capture_device_loss(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &mut CapturePlan,
    error: &anyhow::Error,
    attempt: u8,
) -> anyhow::Result<Option<RuntimeCaptureRecovery>> {
    if !is_capture_device_lost(error) || attempt >= RUNTIME_CAPTURE_RETRY_ATTEMPTS {
        return Ok(None);
    }

    let reason = error.to_string();
    let segment = preserve_recovered_capture_segment(capture_plan, attempt, &reason);
    let output_bytes = segment.as_ref().map(|segment| segment.bytes).or_else(|| {
        fs::metadata(&capture_plan.output_path)
            .ok()
            .map(|metadata| metadata.len())
    });
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.capture_device_lost",
        "warning",
        json!({
            "attempt": attempt,
            "backend": format!("{:?}", capture_plan.backend).to_ascii_lowercase(),
            "device": capture_plan.device.as_str(),
            "error": reason.as_str(),
            "jobId": job.id.as_str(),
            "nextAttempt": attempt + 1,
            "outputBytes": output_bytes,
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
            "retryAttempts": RUNTIME_CAPTURE_RETRY_ATTEMPTS,
            "segmentPath": segment.as_ref().map(|segment| segment.path.display().to_string()),
            "willRetry": true,
        }),
    )
    .await?;

    let _ = fs::remove_file(&capture_plan.output_path);
    refresh_capture_device_from_inventory(config, token, job, capture_plan).await?;
    tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
    let capture = spawn_capture_plan_with_recovery(config, token, job, capture_plan).await?;

    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.capture_runtime_restarted",
        "info",
        json!({
            "attempt": attempt + 1,
            "device": capture_plan.device.as_str(),
            "jobId": job.id.as_str(),
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
        }),
    )
    .await?;

    Ok(Some(RuntimeCaptureRecovery { capture, segment }))
}

pub(crate) async fn spawn_capture_plan_with_recovery(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
) -> anyhow::Result<CaptureChild> {
    let attempts = 3;

    for attempt in 1..=attempts {
        match spawn_capture_plan(capture_plan) {
            Ok(capture) => {
                if attempt > 1 {
                    append_job_health_event(
                        config,
                        token,
                        job,
                        "agent.recording_job.capture_device_recovered",
                        "info",
                        json!({
                            "attempt": attempt,
                            "device": capture_plan.device.as_str(),
                            "jobId": job.id.as_str(),
                            "recordingId": job.recording_id.as_str(),
                        }),
                    )
                    .await?;
                }

                return Ok(capture);
            }
            Err(error) if attempt < attempts && is_capture_device_unavailable(&error) => {
                append_job_health_event(
                    config,
                    token,
                    job,
                    "agent.recording_job.capture_device_unavailable",
                    "warning",
                    json!({
                        "attempt": attempt,
                        "device": capture_plan.device.as_str(),
                        "error": error.to_string(),
                        "jobId": job.id.as_str(),
                        "recordingId": job.recording_id.as_str(),
                        "retryAttempts": attempts,
                    }),
                )
                .await?;
                tokio::time::sleep(Duration::from_secs(config.job_poll_seconds.max(1))).await;
            }
            Err(error) => return Err(error),
        }
    }

    unreachable!("capture spawn retry loop should return on final attempt")
}

fn is_capture_device_unavailable(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();

    message.contains("no such device")
        || message.contains("cannot find card")
        || message.contains("unknown pcm")
        || message.contains("device or resource busy")
}

fn is_alsa_capture_device_ref(value: &str) -> bool {
    value.starts_with("hw:") || value.starts_with("plughw:")
}

fn state_segment(segment: &RecoveredCaptureSegment) -> AgentRecoveredCaptureSegment {
    AgentRecoveredCaptureSegment {
        attempt: segment.attempt,
        bytes: segment.bytes,
        path: segment.path.display().to_string(),
        reason: segment.reason.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn classifies_capture_device_unavailable_errors() {
        assert!(is_capture_device_unavailable(&anyhow::anyhow!(
            "run capture command arecord: Unknown PCM hw:9,9"
        )));
        assert!(!is_capture_device_unavailable(&anyhow::anyhow!(
            "run capture command arecord: permission denied"
        )));
    }

    #[test]
    fn classifies_mid_capture_device_lost_errors() {
        assert!(is_capture_device_lost(&anyhow::anyhow!(
            "capture command arecord failed with status exit code: 1: arecord: pcm_read: Input/output error"
        )));
        assert!(is_capture_device_lost(&anyhow::anyhow!(
            "capture command pw-record failed with status exit code: 1: Broken pipe"
        )));
        assert!(!is_capture_device_lost(&anyhow::anyhow!(
            "capture command fake failed with status exit code: 43: simulated capture failure"
        )));
    }

    #[test]
    fn classifies_alsa_capture_device_refs() {
        assert!(is_alsa_capture_device_ref("hw:CARD=XUSB,DEV=0"));
        assert!(is_alsa_capture_device_ref("plughw:2,0"));
        assert!(!is_alsa_capture_device_ref("usb-1-1"));
        assert!(!is_alsa_capture_device_ref("jack:system:capture_1"));
    }

    #[test]
    fn detects_inflight_capture_disk_shortfall() {
        let plan = capture_plan();
        let growth = CaptureGrowthSnapshot {
            age_seconds: 4,
            last_growth_seconds_ago: 1,
            size_bytes: Some(100_000),
        };
        let disk_usage = system_health::DiskUsage {
            free_bytes: 1_000,
            free_percent: 1.0,
            total_bytes: 10_000,
            used_percent: 99.0,
        };

        let shortfall =
            capture_disk_space_shortfall(&plan, &growth, disk_usage).expect("shortfall");

        assert_eq!(shortfall.estimated_capture_bytes, 1_924_096);
        assert_eq!(shortfall.written_bytes, 100_000);
        assert_eq!(shortfall.remaining_bytes, 1_824_096);
        assert!(shortfall.reason().contains("capture_disk_space_exhausted"));
    }

    #[test]
    fn ignores_inflight_capture_when_remaining_space_is_available() {
        let plan = capture_plan();
        let growth = CaptureGrowthSnapshot {
            age_seconds: 4,
            last_growth_seconds_ago: 1,
            size_bytes: Some(1_900_000),
        };
        let disk_usage = system_health::DiskUsage {
            free_bytes: 30_000,
            free_percent: 30.0,
            total_bytes: 100_000,
            used_percent: 70.0,
        };

        assert!(capture_disk_space_shortfall(&plan, &growth, disk_usage).is_none());
    }

    fn capture_plan() -> CapturePlan {
        CapturePlan {
            args_template: None,
            backend: CaptureBackend::Alsa,
            channel_map: None,
            channels: 2,
            command: "arecord".to_string(),
            device: "hw:CARD=XUSB,DEV=0".to_string(),
            final_output_path: PathBuf::from("capture.wav"),
            format: "S16_LE".to_string(),
            growth_grace_seconds: 1,
            min_output_bytes: 128,
            output_bitrate_kbps: None,
            output_codec: "wav".to_string(),
            output_path: PathBuf::from("capture.wav"),
            output_vbr: false,
            render_command: "ffmpeg".to_string(),
            sample_rate: 48_000,
            seconds: 10,
            stalled_seconds: 30,
        }
    }
}
