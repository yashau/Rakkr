use serde_json::json;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tracing::warn;

use crate::capture::{CaptureChild, CapturePlan};
use crate::config::AgentConfig;
use crate::controller::{mark_recording_job_failed, sync_health_event};
use crate::health_log;
use crate::state::AgentRecoveredCaptureSegment;

/// Reason recorded when recovered capture segments cannot be stitched into one
/// recording. The job is failed (never silent-completed) and the segment files are
/// preserved on disk for manual recovery.
pub(crate) const STITCH_FAILED_REASON: &str = "capture_segments_stitch_failed";

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

/// The minimal context needed to stitch recovered segments, whether that happens
/// during graceful completion (from a live `CapturePlan` + job) or at startup
/// recovery (reconstructed from the persisted job state, where no `CapturePlan`
/// or controller job is in hand).
pub(crate) struct StitchContext<'a> {
    pub config: &'a AgentConfig,
    pub token: &'a str,
    pub recording_id: &'a str,
    pub job_id: &'a str,
    /// The ffmpeg-compatible render command used for the concat.
    pub render_command: &'a str,
    /// Base capture path; the stitched/concat sibling files are derived from it.
    pub output_path: &'a Path,
}

/// Result of trying to merge recovered pre-loss segments with the final capture.
#[derive(Debug)]
pub(crate) enum StitchOutcome {
    /// No recovered segments — the final capture already is the whole recording.
    NoSegments,
    /// All segments were concatenated into `stitched`; the inputs were deleted.
    Stitched(PathBuf),
    /// The concat could not be produced. Every listed file is preserved on disk so
    /// no audio is lost and the recording must not be silent-completed.
    Failed { preserved: Vec<PathBuf> },
}

/// Rebuild a runtime `RecoveredCaptureSegment` from its persisted form so restart
/// recovery can stitch the segments an interrupted capture preserved.
pub(crate) fn runtime_segment(segment: &AgentRecoveredCaptureSegment) -> RecoveredCaptureSegment {
    RecoveredCaptureSegment {
        attempt: segment.attempt,
        bytes: segment.bytes,
        path: PathBuf::from(&segment.path),
        reason: segment.reason.clone(),
    }
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

/// Concatenate the recovered pre-loss segments with the final capture into one
/// recording. On success the inputs are deleted and `Stitched` is returned; on any
/// failure (spawn error, non-zero ffmpeg exit, or an unwritable concat list) the
/// inputs are left on disk and `Failed` is returned so the caller preserves the
/// audio and never reports the recording as cleanly complete.
pub(crate) async fn stitch_recovered_capture_segments(
    ctx: &StitchContext<'_>,
    segments: &[RecoveredCaptureSegment],
    final_capture_path: &Path,
) -> anyhow::Result<StitchOutcome> {
    if segments.is_empty() {
        return Ok(StitchOutcome::NoSegments);
    }

    let stitched_output_path = recovered_capture_output_path(ctx.output_path);
    let concat_list_path = recovered_capture_concat_list_path(ctx.output_path);
    let inputs = segments
        .iter()
        .map(|segment| segment.path.clone())
        .chain(std::iter::once(final_capture_path.to_path_buf()))
        .collect::<Vec<_>>();

    if let Err(error) = fs::write(&concat_list_path, concat_demuxer_list(&inputs)) {
        // The concat list itself could not be written; preserve the inputs rather
        // than proceed as if the recording were whole.
        warn!(
            error = %error,
            job_id = %ctx.job_id,
            "failed to write capture recovery concat list"
        );

        return Ok(StitchOutcome::Failed { preserved: inputs });
    }

    if !run_capture_concat(ctx.render_command, &concat_list_path, &stitched_output_path) {
        append_segment_health_event(
            ctx,
            "agent.recording_job.capture_segments_stitch_failed",
            "warning",
            json!({
                "finalCapturePath": final_capture_path.display().to_string(),
                "jobId": ctx.job_id,
                "recordingId": ctx.recording_id,
                "segmentCount": segments.len(),
                "segmentPaths": segments
                    .iter()
                    .map(|segment| segment.path.display().to_string())
                    .collect::<Vec<_>>(),
            }),
        )
        .await?;
        let _ = fs::remove_file(&concat_list_path);

        return Ok(StitchOutcome::Failed { preserved: inputs });
    }

    let stitched_bytes = fs::metadata(&stitched_output_path)
        .ok()
        .map(|metadata| metadata.len());
    let segment_bytes = segments.iter().map(|segment| segment.bytes).sum::<u64>();
    append_segment_health_event(
        ctx,
        "agent.recording_job.capture_segments_stitched",
        "info",
        json!({
            "attempts": segments.iter().map(|segment| segment.attempt).collect::<Vec<_>>(),
            "finalCapturePath": final_capture_path.display().to_string(),
            "gapCount": segments.len(),
            "jobId": ctx.job_id,
            "recordingId": ctx.recording_id,
            "segmentBytes": segment_bytes,
            "segmentCount": segments.len(),
            "segmentPaths": segments.iter().map(|segment| segment.path.display().to_string()).collect::<Vec<_>>(),
            "stitchedBytes": stitched_bytes,
            "stitchedOutputPath": stitched_output_path.display().to_string(),
        }),
    )
    .await?;

    let _ = fs::remove_file(&concat_list_path);
    for input in &inputs {
        if input != &stitched_output_path {
            let _ = fs::remove_file(input);
        }
    }

    Ok(StitchOutcome::Stitched(stitched_output_path))
}

/// Run the ffmpeg concat-demuxer copy. Returns `true` only on a clean exit; a spawn
/// failure or a non-zero status is treated as "could not stitch" (never a silent
/// success), so the caller preserves the inputs.
fn run_capture_concat(
    render_command: &str,
    concat_list_path: &Path,
    stitched_output_path: &Path,
) -> bool {
    match Command::new(render_command)
        .args(concat_command_args(concat_list_path, stitched_output_path))
        .output()
    {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(
                command = render_command,
                stderr = %stderr.trim(),
                "capture recovery concat command failed"
            );

            false
        }
        Err(error) => {
            warn!(
                command = render_command,
                error = %error,
                "capture recovery concat command could not start"
            );

            false
        }
    }
}

/// Mark the recording failed and emit a CRITICAL health event listing the preserved
/// segment files. A recording whose pre-loss audio could not be stitched is never
/// silent-completed, and the audio stays recoverable from the node.
pub(crate) async fn report_unrecoverable_capture_segments(
    ctx: &StitchContext<'_>,
    preserved: &[PathBuf],
) -> anyhow::Result<()> {
    append_segment_health_event(
        ctx,
        "agent.recording_job.capture_segments_unrecoverable",
        "critical",
        json!({
            "jobId": ctx.job_id,
            "preservedBytes": preserved
                .iter()
                .map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
                .collect::<Vec<_>>(),
            "preservedPaths": preserved
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>(),
            "reason": STITCH_FAILED_REASON,
            "recordingId": ctx.recording_id,
        }),
    )
    .await?;

    if let Err(error) =
        mark_recording_job_failed(ctx.config, ctx.token, ctx.job_id, STITCH_FAILED_REASON).await
    {
        warn!(
            error = %error,
            job_id = %ctx.job_id,
            "failed to mark job failed after unstitchable capture segments"
        );
    }

    Ok(())
}

/// What restart recovery should upload for an interrupted single-file capture.
pub(crate) enum RestartStitchPlan {
    /// Upload `upload_path` (the stitched recording when segments were merged, else
    /// the final segment); `raw_for_retention` is the raw master retention acts on.
    Upload {
        upload_path: PathBuf,
        raw_for_retention: PathBuf,
        stitched: bool,
    },
    /// The preserved segments could not be stitched; they are kept on disk and a
    /// critical event was emitted + the job failed. The caller writes terminal state.
    Failed,
}

/// Decide (and perform) the restart-recovery upload: stitch the preserved pre-loss
/// segments with the final segment when their files are still on disk (RS1), else
/// fall back to uploading the final segment as-is. Only the graceful stitch consumes
/// the segments, so a `rendered`/`upload_pending` restart (files already gone) skips
/// stitching. On an unstitchable failure it preserves the inputs, fails the job, and
/// returns `Failed`.
pub(crate) async fn plan_restart_stitch(
    ctx: &StitchContext<'_>,
    segments: &[RecoveredCaptureSegment],
    raw_output_path: Option<&Path>,
) -> anyhow::Result<RestartStitchPlan> {
    let output_path = ctx.output_path.to_path_buf();
    let should_stitch =
        !segments.is_empty() && segments.iter().all(|segment| fs::metadata(&segment.path).is_ok());

    if !should_stitch {
        let raw = raw_output_path
            .map(Path::to_path_buf)
            .unwrap_or_else(|| output_path.clone());

        return Ok(RestartStitchPlan::Upload {
            upload_path: output_path,
            raw_for_retention: raw,
            stitched: false,
        });
    }

    match stitch_recovered_capture_segments(ctx, segments, &output_path).await? {
        StitchOutcome::NoSegments => Ok(RestartStitchPlan::Upload {
            upload_path: output_path.clone(),
            raw_for_retention: output_path,
            stitched: false,
        }),
        StitchOutcome::Stitched(stitched_path) => Ok(RestartStitchPlan::Upload {
            upload_path: stitched_path.clone(),
            raw_for_retention: stitched_path,
            stitched: true,
        }),
        StitchOutcome::Failed { preserved } => {
            report_unrecoverable_capture_segments(ctx, &preserved).await?;

            Ok(RestartStitchPlan::Failed)
        }
    }
}

async fn append_segment_health_event(
    ctx: &StitchContext<'_>,
    event_type: &str,
    severity: &str,
    details: serde_json::Value,
) -> anyhow::Result<()> {
    let event = health_log::append_health_event_with_targets(
        ctx.config,
        event_type,
        severity,
        details,
        Some(ctx.recording_id.to_string()),
        None,
    )?;

    if let Err(error) = sync_health_event(ctx.config, ctx.token, &event).await {
        warn!(
            event_type,
            error = %error,
            "failed to sync capture segment health event"
        );
    }

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(name: &str) -> PathBuf {
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        PathBuf::from("target").join(format!("rakkr-stitch-{name}-{counter}"))
    }

    fn test_config(state_file: &Path) -> AgentConfig {
        AgentConfig::parse_from([
            "test",
            "--agent-state-file",
            state_file.to_string_lossy().as_ref(),
        ])
    }

    fn segment(path: &Path, attempt: u8, bytes: u64) -> RecoveredCaptureSegment {
        RecoveredCaptureSegment {
            attempt,
            bytes,
            path: path.to_path_buf(),
            reason: "device_lost".to_string(),
        }
    }

    #[tokio::test]
    #[cfg_attr(miri, ignore)] // touches the real filesystem
    async fn empty_segments_leave_the_final_capture_untouched() {
        let root = temp_root("empty");
        fs::create_dir_all(&root).expect("create root");
        let final_path = root.join("rec.wav");
        fs::write(&final_path, b"final").expect("write final");
        let state_file = root.join("state.json");
        let config = test_config(&state_file);
        let ctx = StitchContext {
            config: &config,
            token: "t",
            recording_id: "rec",
            job_id: "job",
            render_command: "rakkr-nonexistent-ffmpeg",
            output_path: &final_path,
        };

        let outcome = stitch_recovered_capture_segments(&ctx, &[], &final_path)
            .await
            .expect("stitch");

        assert!(matches!(outcome, StitchOutcome::NoSegments));
        assert!(final_path.exists(), "final capture must be untouched");

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[cfg_attr(miri, ignore)] // spawns a (missing) concat command
    async fn unstitchable_segments_are_preserved_not_silently_completed() {
        // Regression for GH-1/RS1: on a concat failure the agent used to return the
        // final segment alone and complete the recording, silently dropping the
        // pre-loss segments and leaking their files. It must instead preserve every
        // input and signal failure so the caller never reports clean success.
        let root = temp_root("unstitchable");
        fs::create_dir_all(&root).expect("create root");
        let seg_path = root.join("rec.recovery-attempt-1.wav");
        let final_path = root.join("rec.wav");
        fs::write(&seg_path, b"pre-loss audio").expect("write segment");
        fs::write(&final_path, b"final audio").expect("write final");
        let state_file = root.join("state.json");
        let config = test_config(&state_file);
        let ctx = StitchContext {
            config: &config,
            token: "t",
            recording_id: "rec",
            job_id: "job",
            // A command that cannot start stands in for a failed ffmpeg concat.
            render_command: "rakkr-nonexistent-ffmpeg",
            output_path: &final_path,
        };

        let outcome =
            stitch_recovered_capture_segments(&ctx, &[segment(&seg_path, 1, 14)], &final_path)
                .await
                .expect("stitch");

        match outcome {
            StitchOutcome::Failed { preserved } => {
                assert!(
                    preserved.contains(&seg_path),
                    "the pre-loss segment must be preserved"
                );
                assert!(
                    preserved.contains(&final_path),
                    "the final capture must be preserved"
                );
            }
            other => panic!("expected Failed, got {other:?}"),
        }

        assert!(seg_path.exists(), "pre-loss segment must not be deleted");
        assert!(final_path.exists(), "final capture must not be deleted");

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[cfg_attr(miri, ignore)] // requires a real ffmpeg on PATH
    async fn stitches_valid_wav_segments_into_one_recording() {
        // Hardware/integration proof (needs ffmpeg): two real WAV segments plus the
        // final capture concatenate into a single recording whose duration is the
        // sum, and the inputs are consumed. Skips cleanly when ffmpeg is absent.
        if which_ffmpeg().is_none() {
            eprintln!("skipping: ffmpeg not on PATH");
            return;
        }

        let root = temp_root("valid");
        fs::create_dir_all(&root).expect("create root");
        let seg1 = root.join("rec.recovery-attempt-1.wav");
        let seg2 = root.join("rec.recovery-attempt-2.wav");
        let final_path = root.join("rec.wav");
        make_sine_wav(&seg1, 1);
        make_sine_wav(&seg2, 1);
        make_sine_wav(&final_path, 1);
        let state_file = root.join("state.json");
        let config = test_config(&state_file);
        let ctx = StitchContext {
            config: &config,
            token: "t",
            recording_id: "rec",
            job_id: "job",
            render_command: "ffmpeg",
            output_path: &final_path,
        };

        let outcome = stitch_recovered_capture_segments(
            &ctx,
            &[segment(&seg1, 1, 0), segment(&seg2, 2, 0)],
            &final_path,
        )
        .await
        .expect("stitch");

        match outcome {
            StitchOutcome::Stitched(path) => {
                assert!(path.exists(), "stitched output must exist");
                let seconds = wav_duration_seconds(&path);
                assert!(
                    (seconds - 3.0).abs() < 0.3,
                    "stitched duration {seconds} should be ~3s (sum of segments)"
                );
                assert!(!seg1.exists(), "consumed segment must be deleted");
                assert!(!seg2.exists(), "consumed segment must be deleted");
                assert!(!final_path.exists(), "consumed final must be deleted");
            }
            other => panic!("expected Stitched, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&root);
    }

    fn which_ffmpeg() -> Option<()> {
        Command::new("ffmpeg")
            .arg("-version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|_| ())
    }

    fn make_sine_wav(path: &Path, seconds: u32) {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency=440:duration={seconds}"),
                "-c:a",
                "pcm_s16le",
                path.to_string_lossy().as_ref(),
            ])
            .status()
            .expect("run ffmpeg to make fixture");
        assert!(status.success(), "ffmpeg fixture generation failed");
    }

    fn wav_duration_seconds(path: &Path) -> f64 {
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path.to_string_lossy().as_ref(),
            ])
            .output()
            .expect("run ffprobe");
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<f64>()
            .expect("parse duration")
    }
}
