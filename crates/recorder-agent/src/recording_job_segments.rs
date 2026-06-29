use anyhow::Context;
use serde_json::json;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::capture::{CaptureChild, CapturePlan};
use crate::config::AgentConfig;
use crate::controller::ControllerRecordingJob;
use crate::recording_job_upload::append_job_health_event;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RecoveredCaptureSegment {
    pub attempt: u8,
    pub bytes: u64,
    pub path: PathBuf,
    pub reason: String,
}

pub(crate) struct RuntimeCaptureRecovery {
    pub capture: CaptureChild,
    pub segment: Option<RecoveredCaptureSegment>,
}

pub(crate) fn preserve_recovered_capture_segment(
    capture_plan: &CapturePlan,
    attempt: u8,
    reason: &str,
) -> Option<RecoveredCaptureSegment> {
    let metadata = fs::metadata(&capture_plan.output_path).ok()?;

    if metadata.len() < capture_plan.min_output_bytes {
        return None;
    }

    let segment_path = recovered_capture_segment_path(&capture_plan.output_path, attempt);
    let _ = fs::remove_file(&segment_path);

    if fs::rename(&capture_plan.output_path, &segment_path).is_err() {
        return None;
    }

    Some(RecoveredCaptureSegment {
        attempt,
        bytes: metadata.len(),
        path: segment_path,
        reason: reason.to_string(),
    })
}

pub(crate) async fn stitch_recovered_capture_segments(
    config: &AgentConfig,
    token: &str,
    job: &ControllerRecordingJob,
    capture_plan: &CapturePlan,
    segments: &[RecoveredCaptureSegment],
    final_capture_path: &Path,
) -> anyhow::Result<PathBuf> {
    if segments.is_empty() {
        return Ok(final_capture_path.to_path_buf());
    }

    let stitched_output_path = recovered_capture_output_path(&capture_plan.output_path);
    let concat_list_path = recovered_capture_concat_list_path(&capture_plan.output_path);
    let inputs = segments
        .iter()
        .map(|segment| segment.path.clone())
        .chain(std::iter::once(final_capture_path.to_path_buf()))
        .collect::<Vec<_>>();

    fs::write(&concat_list_path, concat_demuxer_list(&inputs))
        .with_context(|| format!("write capture concat list {}", concat_list_path.display()))?;

    let output = Command::new(&capture_plan.render_command)
        .args(concat_command_args(
            &concat_list_path,
            &stitched_output_path,
        ))
        .output()
        .with_context(|| {
            format!(
                "run capture recovery concat command {}",
                capture_plan.render_command
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        append_job_health_event(
            config,
            token,
            job,
            "agent.recording_job.capture_segments_stitch_failed",
            "warning",
            json!({
                "error": stderr,
                "finalCapturePath": final_capture_path.display().to_string(),
                "jobId": job.id.as_str(),
                "recordingId": job.recording_id.as_str(),
                "segmentCount": segments.len(),
                "segmentPaths": segments.iter().map(|segment| segment.path.display().to_string()).collect::<Vec<_>>(),
            }),
        )
        .await?;
        let _ = fs::remove_file(&concat_list_path);

        return Ok(final_capture_path.to_path_buf());
    }

    let stitched_bytes = fs::metadata(&stitched_output_path)
        .ok()
        .map(|metadata| metadata.len());
    let segment_bytes = segments.iter().map(|segment| segment.bytes).sum::<u64>();
    append_job_health_event(
        config,
        token,
        job,
        "agent.recording_job.capture_segments_stitched",
        "info",
        json!({
            "attempts": segments.iter().map(|segment| segment.attempt).collect::<Vec<_>>(),
            "finalCapturePath": final_capture_path.display().to_string(),
            "gapCount": segments.len(),
            "jobId": job.id.as_str(),
            "recordingId": job.recording_id.as_str(),
            "segmentBytes": segment_bytes,
            "segmentCount": segments.len(),
            "segmentPaths": segments.iter().map(|segment| segment.path.display().to_string()).collect::<Vec<_>>(),
            "stitchedBytes": stitched_bytes,
            "stitchedOutputPath": stitched_output_path.display().to_string(),
        }),
    )
    .await?;

    let _ = fs::remove_file(&concat_list_path);
    for input in inputs {
        if input != stitched_output_path {
            let _ = fs::remove_file(input);
        }
    }

    Ok(stitched_output_path)
}

fn recovered_capture_segment_path(output_path: &Path, attempt: u8) -> PathBuf {
    sibling_path_with_suffix(output_path, &format!("recovery-attempt-{attempt}"), "wav")
}

fn recovered_capture_output_path(output_path: &Path) -> PathBuf {
    sibling_path_with_suffix(output_path, "recovered", "wav")
}

fn recovered_capture_concat_list_path(output_path: &Path) -> PathBuf {
    sibling_path_with_suffix(output_path, "recovered-concat", "txt")
}

fn sibling_path_with_suffix(output_path: &Path, suffix: &str, extension: &str) -> PathBuf {
    let stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("capture");
    let file_name = format!("{stem}.{suffix}.{extension}");

    output_path.parent().map_or_else(
        || PathBuf::from(file_name.as_str()),
        |parent| parent.join(file_name.as_str()),
    )
}

fn concat_command_args(concat_list_path: &Path, stitched_output_path: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-y"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-f"),
        OsString::from("concat"),
        OsString::from("-safe"),
        OsString::from("0"),
        OsString::from("-i"),
        concat_list_path.as_os_str().to_os_string(),
        OsString::from("-c"),
        OsString::from("copy"),
        stitched_output_path.as_os_str().to_os_string(),
    ]
}

fn concat_demuxer_list(paths: &[PathBuf]) -> String {
    let mut list = String::new();

    for path in paths {
        let normalized = path
            .canonicalize()
            .unwrap_or_else(|_| path.clone())
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        list.push_str("file '");
        list.push_str(&normalized);
        list.push_str("'\n");
    }

    list
}
