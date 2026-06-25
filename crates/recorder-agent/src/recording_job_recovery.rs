use anyhow::Context;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tracing::warn;

use crate::cache_content_type::content_type_for_codec;
use crate::capture::{CaptureChild, CapturePlan, estimated_capture_bytes, spawn_capture_plan};
use crate::config::{AgentConfig, CaptureBackend};
use crate::controller::{
    CacheFileUpload, ControllerRecordingJob, append_job_health_event, mark_recording_job_failed,
    sync_health_event, upload_cache_file,
};
use crate::health_log;
use crate::state::{AgentJobState, read_job_state, write_job_state_snapshot};
use crate::system_health;

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

    if matches!(state.status.as_str(), "rendered" | "upload_pending")
        && let Some(output_path) = state.output_path.as_deref().map(PathBuf::from)
        && fs::metadata(&output_path)
            .ok()
            .is_some_and(|metadata| metadata.len() > 0)
    {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn classifies_alsa_capture_device_refs() {
        assert!(is_alsa_capture_device_ref("hw:CARD=XUSB,DEV=0"));
        assert!(is_alsa_capture_device_ref("plughw:2,0"));
        assert!(!is_alsa_capture_device_ref("usb-1-1"));
        assert!(!is_alsa_capture_device_ref("jack:system:capture_1"));
    }
}
