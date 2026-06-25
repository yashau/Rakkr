use serde_json::json;

use crate::capture::{CaptureGrowthSnapshot, CapturePlan, estimated_capture_bytes};
use crate::config::AgentConfig;
use crate::controller::{
    ControllerRecordingJob, append_job_health_event, mark_recording_job_failed,
};
use crate::{node_config, recorder_cache_retention, system_health};

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

    if recover_capture_disk_space(config, token, job, capture_plan, disk_usage, required_bytes)
        .await?
    {
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

async fn recover_capture_disk_space(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    initial_disk_usage: system_health::DiskUsage,
    required_bytes: u64,
) -> anyhow::Result<bool> {
    let node_config = match node_config::fetch_node_config(config, token).await {
        Ok(node_config) => node_config,
        Err(error) => {
            append_job_health_event(
                config,
                token,
                job,
                "agent.recording_job.disk_space_cleanup_skipped",
                "warning",
                json!({
                    "error": error.to_string(),
                    "freeBytes": initial_disk_usage.free_bytes,
                    "jobId": job.id.as_str(),
                    "outputPath": capture_plan.output_path.display().to_string(),
                    "recordingId": job.recording_id.as_str(),
                    "requiredBytes": required_bytes,
                    "systemHealthDiskPath": config.system_health_disk_path.display().to_string(),
                }),
            )
            .await?;

            return Ok(false);
        }
    };

    if node_config.recorder_cache_policies.is_empty() {
        return Ok(false);
    }

    let sweep = recorder_cache_retention::run_recorder_cache_sweep(
        &config.recorder_cache_manifest_file,
        &node_config.recorder_cache_policies,
        Some(recorder_cache_retention::RecorderCacheDiskUsage {
            free_bytes: initial_disk_usage.free_bytes,
            free_percent: initial_disk_usage.free_percent,
            total_bytes: initial_disk_usage.total_bytes,
        }),
        std::time::SystemTime::now(),
    )?;

    if sweep.deleted == 0 && sweep.errors == 0 {
        return Ok(false);
    }

    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.disk_space_cleanup_attempted",
        if sweep.errors > 0 { "warning" } else { "info" },
        json!({
            "deleted": sweep.deleted,
            "errors": sweep.errors,
            "freeBytes": initial_disk_usage.free_bytes,
            "items": sweep.items,
            "jobId": job.id.as_str(),
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
            "requiredBytes": required_bytes,
            "scanned": sweep.scanned,
            "systemHealthDiskPath": config.system_health_disk_path.display().to_string(),
        }),
    )
    .await?;

    let Some(recovered_disk_usage) = system_health::disk_usage(
        &config.system_health_df_command,
        &config.system_health_disk_path,
    ) else {
        return Ok(false);
    };

    if recovered_disk_usage.free_bytes < required_bytes {
        return Ok(false);
    }

    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.disk_space_recovered",
        "info",
        json!({
            "freeBytes": recovered_disk_usage.free_bytes,
            "initialFreeBytes": initial_disk_usage.free_bytes,
            "jobId": job.id.as_str(),
            "outputPath": capture_plan.output_path.display().to_string(),
            "recordingId": job.recording_id.as_str(),
            "requiredBytes": required_bytes,
            "systemHealthDiskPath": config.system_health_disk_path.display().to_string(),
        }),
    )
    .await?;

    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CaptureBackend;
    use std::path::PathBuf;

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
