//! Gapless chunked capture.
//!
//! ONE source process holds the PCM device open for the whole recording and pipes
//! raw PCM into a SINGLE ffmpeg segmenter that cuts on the input timeline, so no
//! samples drop at chunk boundaries (re-spawning a capture per chunk would drop
//! samples on reopen and is rejected). ffmpeg writes `<dir>/<stem>.chunk-NNNN.wav`
//! with monotonically increasing 0-based indices; the highest index on disk is the
//! still-open segment, every lower index is a closed chunk.
//!
//! Graceful finish terminates the SOURCE first (EOF on the pipe -> ffmpeg drains,
//! closes the trailing partial segment and exits 0); a hard stop kills both and
//! discards the open partial.

use std::path::{Path, PathBuf};

use crate::capture::CapturePlan;
#[cfg(any(unix, test))]
use crate::capture::sample_format_bytes;
use crate::config::CaptureBackend;

#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::process::Child;
#[cfg(unix)]
use std::time::Instant;

#[cfg(unix)]
use anyhow::Context;

/// Per-recording chunk layout: the segment length plus the working directory and
/// file stem the segmenter writes its `<stem>.chunk-NNNN.wav` files under.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChunkPlan {
    pub chunk_seconds: u64,
    pub dir: PathBuf,
    pub stem: String,
}

/// A chunk segment whose file has been fully written (closed) by ffmpeg.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClosedChunk {
    pub index: u32,
    pub path: PathBuf,
    pub seconds: u64,
}

/// Decide whether a job should record in gapless chunks. Returns `None` when no
/// chunk length is configured (`None`/0) or the backend is JACK (no clean stdout
/// PCM stream — the caller falls back to the single-file path and logs it).
pub(crate) fn chunk_plan_for(plan: &CapturePlan, chunk_seconds: Option<u64>) -> Option<ChunkPlan> {
    let chunk_seconds = chunk_seconds.filter(|seconds| *seconds > 0)?;

    if plan.backend == CaptureBackend::Jack {
        return None;
    }

    let dir = plan
        .final_output_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let stem = plan
        .final_output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording")
        .to_string();

    Some(ChunkPlan {
        chunk_seconds,
        dir,
        stem,
    })
}

/// The closed-chunk wav path the segmenter writes for `index` (0-based), matching
/// the ffmpeg `-segment` output template `<stem>.chunk-%04d.wav`. Only used by the
/// Unix capture path (and unit tests); the non-Unix stub never reaches it.
#[cfg(any(unix, test))]
pub(crate) fn chunk_segment_path(plan: &ChunkPlan, index: u32) -> PathBuf {
    plan.dir.join(format!("{}.chunk-{index:04}.wav", plan.stem))
}

/// Parse the 0-based segment index out of a `<stem>.chunk-NNNN.wav` file name.
#[cfg(any(unix, test))]
pub(crate) fn chunk_index_from_file_name(stem: &str, file_name: &str) -> Option<u32> {
    let rest = file_name.strip_prefix(stem)?.strip_prefix(".chunk-")?;
    let digits = rest.strip_suffix(".wav")?;

    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    digits.parse::<u32>().ok()
}

/// Whole seconds of PCM audio represented by `bytes` of raw samples at the given
/// rate/channels/format. WAV headers are tiny relative to a chunk so they are not
/// subtracted; this is only used to label the trailing partial chunk.
#[cfg(any(unix, test))]
pub(crate) fn partial_chunk_seconds(bytes: u64, rate: u32, channels: u16, format: &str) -> u64 {
    let bytes_per_second = u64::from(rate)
        .saturating_mul(u64::from(channels))
        .saturating_mul(sample_format_bytes(format));

    if bytes_per_second == 0 {
        return 0;
    }

    bytes / bytes_per_second
}

#[cfg(unix)]
pub(crate) use unix_impl::{ChunkedCapture, spawn_chunked_capture};

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use std::process::{Command, Stdio};

    use crate::capture::{
        CaptureGrowthError, CaptureGrowthMonitor, CaptureGrowthSnapshot, capture_command_args,
    };

    /// A running gapless chunked capture: the source process holds the device open
    /// and pipes raw PCM to the segmenter, which cuts the input timeline into chunk
    /// files. `next_index` is the lowest segment index not yet emitted to the caller.
    pub(crate) struct ChunkedCapture {
        plan: ChunkPlan,
        source: Child,
        source_command: String,
        segmenter: Child,
        next_index: u32,
        monitor: CaptureGrowthMonitor,
        last_open_index: u32,
        rate: u32,
        channels: u16,
        format: String,
        finished: bool,
    }

    /// Spawn the source capture process (raw PCM to stdout) piped into a single
    /// ffmpeg segmenter that writes `<stem>.chunk-NNNN.wav` on the input timeline.
    pub(crate) fn spawn_chunked_capture(
        plan: &CapturePlan,
        chunk_plan: &ChunkPlan,
    ) -> anyhow::Result<ChunkedCapture> {
        if plan.channels == 0 {
            anyhow::bail!("capture channel count must be greater than zero");
        }
        if chunk_plan.chunk_seconds == 0 {
            anyhow::bail!("chunk length must be greater than zero");
        }

        fs::create_dir_all(&chunk_plan.dir).with_context(|| {
            format!("create chunk output directory {}", chunk_plan.dir.display())
        })?;

        let source_args = source_command_args(plan)?;
        let mut source = Command::new(&plan.command)
            .args(&source_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("run chunked capture source command {}", plan.command))?;
        let source_stdout = source
            .stdout
            .take()
            .context("capture source process did not expose stdout")?;

        let segmenter_args = segmenter_command_args(plan, chunk_plan);
        let segmenter = Command::new(&plan.render_command)
            .args(&segmenter_args)
            .stdin(Stdio::from(source_stdout))
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                let _ = source.kill();
                let _ = source.wait();
                anyhow::Error::from(error).context(format!(
                    "run chunk segmenter command {}",
                    plan.render_command
                ))
            })?;

        Ok(ChunkedCapture {
            plan: chunk_plan.clone(),
            source,
            source_command: plan.command.clone(),
            segmenter,
            next_index: 0,
            monitor: CaptureGrowthMonitor::new(
                plan.growth_grace_seconds,
                plan.stalled_seconds,
                Instant::now(),
            ),
            last_open_index: 0,
            rate: plan.sample_rate,
            channels: plan.channels,
            format: plan.format.clone(),
            finished: false,
        })
    }

    impl ChunkedCapture {
        /// Emit every chunk that has closed since the last poll. ffmpeg writes
        /// segment files in order, so the highest index present on disk is still
        /// open; every lower index at or above `next_index` is closed and returned.
        pub(crate) fn poll_closed_chunks(&mut self) -> Vec<ClosedChunk> {
            let highest = self.highest_existing_index();
            let Some(highest) = highest else {
                return Vec::new();
            };

            self.last_open_index = highest;
            let mut closed = Vec::new();

            // Everything strictly below the open (highest) index is fully written.
            while self.next_index < highest {
                let index = self.next_index;
                let path = chunk_segment_path(&self.plan, index);

                if path.exists() {
                    closed.push(ClosedChunk {
                        index,
                        path,
                        seconds: self.plan.chunk_seconds,
                    });
                }

                self.next_index += 1;
            }

            closed
        }

        /// Track growth of the currently open segment so a stalled/disconnected
        /// device is detected the same way the single-file path does.
        pub(crate) fn check_growth(&mut self) -> Result<CaptureGrowthSnapshot, CaptureGrowthError> {
            let open_path = chunk_segment_path(&self.plan, self.last_open_index);
            let size_bytes = fs::metadata(&open_path).ok().map(|metadata| metadata.len());

            self.monitor.observe(size_bytes, Instant::now())
        }

        /// Has the source capture process exited on its own (e.g. device loss or a
        /// fixed-duration source)? Used to detect mid-capture failures.
        pub(crate) fn source_exited(&mut self) -> anyhow::Result<Option<bool>> {
            match self
                .source
                .try_wait()
                .with_context(|| format!("poll chunk capture source {}", self.source_command))?
            {
                Some(status) => Ok(Some(status.success())),
                None => Ok(None),
            }
        }

        /// Gracefully flush the trailing partial: terminate the SOURCE so the pipe
        /// hits EOF, let the segmenter drain and close the last segment, then return
        /// every remaining closed chunk (including that trailing partial).
        pub(crate) fn finish(&mut self) -> anyhow::Result<Vec<ClosedChunk>> {
            if self.finished {
                return Ok(Vec::new());
            }
            self.finished = true;

            // Closing the source stops the PCM stream; the kernel closes its stdout
            // on exit, so the segmenter's stdin hits EOF and ffmpeg finalizes the
            // trailing WAV segment. arecord writes headerless `-t raw` PCM, so all
            // WAV finalization lives in ffmpeg and is unaffected by how the source ends.
            let _ = self.source.kill();
            let _ = self.source.wait();

            // Drain the segmenter: EOF on stdin makes ffmpeg close the final segment
            // and exit. Capture stderr for a useful failure message.
            let segmenter_status = self
                .segmenter
                .wait()
                .with_context(|| "wait for chunk segmenter to drain")?;

            if !segmenter_status.success() {
                let stderr = read_child_stderr(&mut self.segmenter);

                anyhow::bail!("chunk segmenter failed with status {segmenter_status}: {stderr}");
            }

            // After the segmenter exits, the previously-open highest index is now a
            // closed (trailing partial) chunk. Emit all remaining indices.
            let highest = self.highest_existing_index();
            let mut closed = Vec::new();

            if let Some(highest) = highest {
                while self.next_index <= highest {
                    let index = self.next_index;
                    let path = chunk_segment_path(&self.plan, index);

                    if path.exists() {
                        let seconds = if index == highest {
                            self.partial_seconds(&path)
                        } else {
                            self.plan.chunk_seconds
                        };

                        closed.push(ClosedChunk {
                            index,
                            path,
                            seconds,
                        });
                    }

                    self.next_index += 1;
                }
            }

            Ok(closed)
        }

        /// Hard stop: kill both processes and discard the open partial. Used for a
        /// controller stop/cancel where the trailing partial is intentionally dropped.
        pub(crate) fn stop(&mut self) -> anyhow::Result<()> {
            self.finished = true;
            let _ = self.source.kill();
            let _ = self.source.wait();
            let _ = self.segmenter.kill();
            let _ = self.segmenter.wait();

            Ok(())
        }

        fn highest_existing_index(&self) -> Option<u32> {
            let entries = fs::read_dir(&self.plan.dir).ok()?;

            entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let file_name = entry.file_name();
                    let file_name = file_name.to_str()?;

                    chunk_index_from_file_name(&self.plan.stem, file_name)
                })
                .max()
        }

        fn partial_seconds(&self, path: &Path) -> u64 {
            let bytes = fs::metadata(path).ok().map(|metadata| metadata.len());

            partial_chunk_seconds(bytes.unwrap_or(0), self.rate, self.channels, &self.format)
        }
    }

    /// Drop a still-running capture by killing both processes (best effort).
    impl Drop for ChunkedCapture {
        fn drop(&mut self) {
            if !self.finished {
                let _ = self.source.kill();
                let _ = self.segmenter.kill();
            }
        }
    }

    fn read_child_stderr(child: &mut Child) -> String {
        use std::io::Read;

        let Some(mut stderr) = child.stderr.take() else {
            return String::new();
        };
        let mut output = String::new();
        let _ = stderr.read_to_string(&mut output);

        output.trim().to_string()
    }

    /// Source-process args that write raw PCM to stdout for the whole recording
    /// (no fixed duration: the controller/wall-clock drives the stop). Reuses the
    /// single-file arg builder with `output_path = "-"` so templates still apply,
    /// then strips the ALSA `-d <seconds>` duration so capture runs open-ended.
    fn source_command_args(plan: &CapturePlan) -> anyhow::Result<Vec<String>> {
        match plan.backend {
            CaptureBackend::Alsa => Ok(vec![
                "-D".to_string(),
                plan.device.clone(),
                "-f".to_string(),
                plan.format.clone(),
                "-r".to_string(),
                plan.sample_rate.to_string(),
                "-c".to_string(),
                plan.channels.to_string(),
                "-t".to_string(),
                "raw".to_string(),
                "-".to_string(),
            ]),
            CaptureBackend::Pipewire => Ok(vec![
                "--record".to_string(),
                "--target".to_string(),
                plan.device.clone(),
                "--rate".to_string(),
                plan.sample_rate.to_string(),
                "--channels".to_string(),
                plan.channels.to_string(),
                "--format".to_string(),
                crate::capture::pipewire_sample_format(&plan.format).to_string(),
                "-".to_string(),
            ]),
            // JACK is excluded by `chunk_plan_for`; keep the single-file builder as a
            // defensive fallback so this stays total.
            CaptureBackend::Jack => capture_command_args(plan, "-"),
        }
    }

    /// ffmpeg segmenter args: read raw PCM from stdin, cut fixed-length WAV segments
    /// on the input timeline with reset timestamps, write `<stem>.chunk-NNNN.wav`.
    fn segmenter_command_args(plan: &CapturePlan, chunk_plan: &ChunkPlan) -> Vec<String> {
        let template = chunk_plan
            .dir
            .join(format!("{}.chunk-%04d.wav", chunk_plan.stem))
            .to_string_lossy()
            .to_string();

        vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            ffmpeg_pcm_format(&plan.format).to_string(),
            "-ar".to_string(),
            plan.sample_rate.to_string(),
            "-ac".to_string(),
            plan.channels.to_string(),
            "-i".to_string(),
            "pipe:0".to_string(),
            "-f".to_string(),
            "segment".to_string(),
            "-segment_time".to_string(),
            chunk_plan.chunk_seconds.to_string(),
            "-reset_timestamps".to_string(),
            "1".to_string(),
            "-segment_format".to_string(),
            "wav".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            template,
        ]
    }

    /// Map an ALSA/agent sample format to the matching ffmpeg raw PCM demuxer name.
    fn ffmpeg_pcm_format(format: &str) -> &'static str {
        match format.to_ascii_uppercase().as_str() {
            "S8" => "s8",
            "U8" => "u8",
            "S24_LE" | "S24_3LE" => "s24le",
            "S24_BE" | "S24_3BE" => "s24be",
            "S32_LE" => "s32le",
            "S32_BE" => "s32be",
            "FLOAT_LE" | "F32_LE" => "f32le",
            "FLOAT_BE" | "F32_BE" => "f32be",
            "S16_BE" => "s16be",
            _ => "s16le",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_alsa_formats_to_ffmpeg_pcm_demuxers() {
            assert_eq!(ffmpeg_pcm_format("S16_LE"), "s16le");
            assert_eq!(ffmpeg_pcm_format("S32_LE"), "s32le");
            assert_eq!(ffmpeg_pcm_format("FLOAT_LE"), "f32le");
            assert_eq!(ffmpeg_pcm_format("unknown"), "s16le");
        }
    }
}

/// On non-Unix platforms the gapless source pipe + EOF-driven flush is not
/// supported; the crate still compiles so the agent builds on Windows for dev.
/// `spawn_chunked_capture` always errors here, so these methods are never reached
/// at runtime — they exist only so the orchestration module type-checks.
#[cfg(not(unix))]
pub(crate) struct ChunkedCapture;

#[cfg(not(unix))]
impl ChunkedCapture {
    pub(crate) fn poll_closed_chunks(&mut self) -> Vec<ClosedChunk> {
        Vec::new()
    }

    pub(crate) fn check_growth(
        &mut self,
    ) -> Result<crate::capture::CaptureGrowthSnapshot, crate::capture::CaptureGrowthError> {
        Ok(crate::capture::CaptureGrowthSnapshot {
            age_seconds: 0,
            last_growth_seconds_ago: 0,
            size_bytes: None,
        })
    }

    pub(crate) fn source_exited(&mut self) -> anyhow::Result<Option<bool>> {
        Ok(None)
    }

    pub(crate) fn finish(&mut self) -> anyhow::Result<Vec<ClosedChunk>> {
        Ok(Vec::new())
    }

    pub(crate) fn stop(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[cfg(not(unix))]
pub(crate) fn spawn_chunked_capture(
    _plan: &CapturePlan,
    _chunk_plan: &ChunkPlan,
) -> anyhow::Result<ChunkedCapture> {
    anyhow::bail!("chunked capture is unsupported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn plan_with(backend: CaptureBackend) -> CapturePlan {
        CapturePlan {
            args_template: None,
            backend,
            channel_map: None,
            channels: 2,
            command: "arecord".to_string(),
            device: "hw:1,0".to_string(),
            enhancement: None,
            final_output_path: PathBuf::from("data/recordings/local-captures/rec_42.wav"),
            format: "S16_LE".to_string(),
            growth_grace_seconds: 10,
            min_output_bytes: 128,
            output_bitrate_kbps: None,
            output_codec: "wav".to_string(),
            output_path: PathBuf::from("data/recordings/local-captures/rec_42.wav"),
            output_vbr: false,
            render_command: "ffmpeg".to_string(),
            sample_rate: 48_000,
            seconds: 25,
            stalled_seconds: 30,
        }
    }

    #[test]
    fn chunk_plan_gated_off_when_unset_or_zero() {
        let plan = plan_with(CaptureBackend::Alsa);

        assert!(chunk_plan_for(&plan, None).is_none());
        assert!(chunk_plan_for(&plan, Some(0)).is_none());
    }

    #[test]
    fn chunk_plan_gated_off_for_jack_backend() {
        let plan = plan_with(CaptureBackend::Jack);

        assert!(chunk_plan_for(&plan, Some(5)).is_none());
    }

    #[test]
    fn chunk_plan_derives_dir_and_stem_for_supported_backends() {
        let chunk_plan =
            chunk_plan_for(&plan_with(CaptureBackend::Alsa), Some(5)).expect("chunk plan");

        assert_eq!(chunk_plan.chunk_seconds, 5);
        assert_eq!(chunk_plan.stem, "rec_42");
        assert_eq!(
            chunk_plan.dir,
            PathBuf::from("data/recordings/local-captures")
        );

        let pipewire_plan =
            chunk_plan_for(&plan_with(CaptureBackend::Pipewire), Some(10)).expect("chunk plan");
        assert_eq!(pipewire_plan.chunk_seconds, 10);
    }

    #[test]
    fn builds_zero_padded_chunk_segment_path() {
        let chunk_plan =
            chunk_plan_for(&plan_with(CaptureBackend::Alsa), Some(5)).expect("chunk plan");

        assert!(chunk_segment_path(&chunk_plan, 7).ends_with("rec_42.chunk-0007.wav"));
        assert!(chunk_segment_path(&chunk_plan, 1234).ends_with("rec_42.chunk-1234.wav"));
    }

    #[test]
    fn parses_chunk_index_from_file_name() {
        assert_eq!(
            chunk_index_from_file_name("rec_42", "rec_42.chunk-0000.wav"),
            Some(0)
        );
        assert_eq!(
            chunk_index_from_file_name("rec_42", "rec_42.chunk-0007.wav"),
            Some(7)
        );
        assert_eq!(
            chunk_index_from_file_name("rec_42", "rec_42.chunk-1234.wav"),
            Some(1234)
        );
        // Other stems, other suffixes, and the enhanced/raw intermediates must not
        // be mistaken for closed chunks.
        assert_eq!(
            chunk_index_from_file_name("rec_42", "other.chunk-0000.wav"),
            None
        );
        assert_eq!(
            chunk_index_from_file_name("rec_42", "rec_42.chunk-0000.enhanced.wav"),
            None
        );
        assert_eq!(
            chunk_index_from_file_name("rec_42", "rec_42.chunk-00xx.wav"),
            None
        );
        assert_eq!(chunk_index_from_file_name("rec_42", "rec_42.wav"), None);
    }

    #[test]
    fn computes_partial_chunk_seconds_from_byte_count() {
        // 48 kHz stereo S16 = 192000 bytes/sec; 3.5s of audio rounds down to 3s.
        let bytes = 192_000 * 3 + 96_000;

        assert_eq!(partial_chunk_seconds(bytes, 48_000, 2, "S16_LE"), 3);
        // S32 doubles the per-sample width, so the same byte count is half as long.
        assert_eq!(partial_chunk_seconds(192_000 * 4, 48_000, 2, "S32_LE"), 2);
        assert_eq!(partial_chunk_seconds(0, 48_000, 2, "S16_LE"), 0);
    }
}
