use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::Serialize;
use tracing::info;

use crate::capture_naming::{safe_file_name, safe_file_stem};
use crate::command_template::{CommandTemplateValues, command_template_args};
use crate::config::{AgentConfig, CaptureBackend};
use crate::controller::ControllerRecordingEnhancement;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureChannelMapEntry {
    pub included: bool,
    pub label: String,
    pub output_channel_index: Option<u16>,
    pub source_channel_index: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureChannelMap {
    pub assignment_id: String,
    pub channel_mode: String,
    pub entries: Vec<CaptureChannelMapEntry>,
    pub source_channels: u16,
    pub target_id: String,
    pub target_type: String,
    pub template_id: String,
    pub template_name: String,
}

#[derive(Clone)]
pub struct CapturePlan {
    pub args_template: Option<String>,
    pub backend: CaptureBackend,
    pub channel_map: Option<CaptureChannelMap>,
    pub channels: u16,
    pub command: String,
    pub device: String,
    pub enhancement: Option<ControllerRecordingEnhancement>,
    pub final_output_path: PathBuf,
    pub format: String,
    pub growth_grace_seconds: u64,
    pub min_output_bytes: u64,
    pub output_bitrate_kbps: Option<u32>,
    pub output_codec: String,
    pub output_path: PathBuf,
    pub output_vbr: bool,
    pub render_command: String,
    pub sample_rate: u32,
    pub seconds: u64,
    pub stalled_seconds: u64,
}

impl CapturePlan {
    /// Derive a per-chunk capture plan for a closed segment file. `output_path`
    /// points at the closed chunk wav (`<dir>/<stem>.chunk-NNNN.wav`); the
    /// `final_output_path` gets a per-chunk-unique stem so the render and enhanced
    /// intermediates (derived from that stem) never clobber or race across chunks.
    pub(crate) fn chunk_plan(
        &self,
        dir: &Path,
        stem: &str,
        index: u32,
        chunk_wav: &Path,
    ) -> CapturePlan {
        let chunk_stem = format!("{stem}.chunk-{index:04}");
        let final_extension = match self.output_codec.as_str() {
            "flac" => "flac",
            "mp3" => "mp3",
            _ => "wav",
        };
        // A channel-map render reads `output_path` (the closed chunk wav) and
        // writes `final_output_path`. For the wav codec those paths would collide
        // (`{stem}.chunk-NNNN.wav` both), so ffmpeg would read and write the same
        // file in place. Give the rendered output a distinct stem in that case,
        // mirroring the raw.wav split in capture_plan_for_job. (Non-wav codecs
        // already differ by extension; wav without a channel map is a passthrough,
        // so no render runs and sharing the path is fine.)
        let final_output_path = if final_extension == "wav" && self.channel_map.is_some() {
            dir.join(format!("{chunk_stem}.rendered.wav"))
        } else {
            dir.join(format!("{chunk_stem}.{final_extension}"))
        };

        CapturePlan {
            final_output_path,
            output_path: chunk_wav.to_path_buf(),
            ..self.clone()
        }
    }
}

pub fn capture_plan_from_config(config: &AgentConfig) -> anyhow::Result<CapturePlan> {
    let final_output_path = capture_output_path(config)?;
    let output_codec =
        capture_output_codec(config.capture_output_codec.as_deref(), &final_output_path);
    let output_path = if output_codec == "wav" {
        final_output_path.clone()
    } else {
        raw_capture_path(&final_output_path)
    };
    let output_bitrate_kbps = config
        .capture_output_bitrate_kbps
        .or_else(|| (output_codec == "mp3").then_some(128));
    let output_vbr = config.capture_output_vbr && output_codec == "mp3";

    Ok(CapturePlan {
        args_template: config.capture_args_template.clone(),
        backend: config.capture_backend,
        channel_map: None,
        channels: config.capture_channels,
        command: config
            .effective_capture_command(config.capture_backend)
            .to_string(),
        device: config.capture_device.clone(),
        enhancement: None,
        final_output_path,
        format: config.capture_format.clone(),
        growth_grace_seconds: config.capture_growth_grace_seconds,
        min_output_bytes: config.capture_min_output_bytes,
        output_bitrate_kbps,
        output_codec,
        output_path,
        output_vbr,
        render_command: config.channel_render_command.clone(),
        sample_rate: config.capture_sample_rate,
        seconds: config.capture_seconds,
        stalled_seconds: config.capture_stalled_seconds,
    })
}

pub fn capture_output_path(config: &AgentConfig) -> anyhow::Result<PathBuf> {
    if let Some(path) = &config.capture_output {
        return Ok(
            match default_capture_extension(config.capture_output_codec.as_deref()) {
                "flac" => path.with_extension("flac"),
                "mp3" => path.with_extension("mp3"),
                _ => path.clone(),
            },
        );
    }

    let recording_id = config
        .capture_recording_id
        .as_deref()
        .context("missing --capture-recording-id")?;

    Ok(PathBuf::from("data")
        .join("recordings")
        .join("local-captures")
        .join(format!(
            "rakkr-capture-{}.{}",
            safe_file_stem(recording_id),
            default_capture_extension(config.capture_output_codec.as_deref())
        )))
}

fn capture_output_codec(codec: Option<&str>, output_path: &Path) -> String {
    codec
        .map(str::to_ascii_lowercase)
        .filter(|value| supported_output_codec(value))
        .or_else(|| {
            output_path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
        })
        .filter(|value| supported_output_codec(value))
        .unwrap_or_else(|| "wav".to_string())
}

fn default_capture_extension(codec: Option<&str>) -> &'static str {
    codec
        .map(str::to_ascii_lowercase)
        .filter(|value| supported_output_codec(value))
        .map_or("wav", |value| match value.as_str() {
            "flac" => "flac",
            "mp3" => "mp3",
            _ => "wav",
        })
}

fn supported_output_codec(codec: &str) -> bool {
    matches!(codec, "flac" | "mp3" | "wav")
}

fn raw_capture_path(final_output_path: &Path) -> PathBuf {
    let stem = final_output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("recording");
    let file_name = format!("{stem}.raw.wav");

    final_output_path.parent().map_or_else(
        || PathBuf::from(file_name.as_str()),
        |parent| parent.join(file_name.as_str()),
    )
}

pub fn local_capture_path(file_name: &str) -> PathBuf {
    PathBuf::from("data")
        .join("recordings")
        .join("local-captures")
        .join(safe_file_name(file_name))
}

pub fn capture_command_args(plan: &CapturePlan, output_path: &str) -> anyhow::Result<Vec<String>> {
    if let Some(template) = &plan.args_template {
        return command_template_args(
            template,
            &CommandTemplateValues {
                channels: plan.channels,
                device: &plan.device,
                format: &plan.format,
                output: output_path,
                sample_rate: plan.sample_rate,
                seconds: plan.seconds,
            },
        )
        .map_err(|error| error.context("capture args template"));
    }

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
            "-d".to_string(),
            plan.seconds.to_string(),
            output_path.to_string(),
        ]),
        CaptureBackend::Jack => {
            let mut args = vec![
                "--channels".to_string(),
                plan.channels.to_string(),
                "--duration".to_string(),
                plan.seconds.to_string(),
                "--format".to_string(),
                "wav".to_string(),
                "--disable-console".to_string(),
            ];

            args.extend(jack_capture_port_args(&plan.device));
            args.push(output_path.to_string());

            Ok(args)
        }
        CaptureBackend::Pipewire => Ok(vec![
            "--record".to_string(),
            "--target".to_string(),
            plan.device.clone(),
            "--rate".to_string(),
            plan.sample_rate.to_string(),
            "--channels".to_string(),
            plan.channels.to_string(),
            "--format".to_string(),
            pipewire_sample_format(&plan.format).to_string(),
            "--sample-count".to_string(),
            pipewire_sample_count(plan.sample_rate, plan.seconds).to_string(),
            "--container".to_string(),
            "wav".to_string(),
            output_path.to_string(),
        ]),
    }
}

fn jack_capture_port_args(device: &str) -> Vec<String> {
    if device == "default" {
        Vec::new()
    } else {
        vec!["--port".to_string(), device.to_string()]
    }
}

pub fn run_capture_plan(plan: &CapturePlan) -> anyhow::Result<PathBuf> {
    spawn_capture_plan(plan)?.wait()
}

pub fn spawn_capture_plan(plan: &CapturePlan) -> anyhow::Result<CaptureChild> {
    if plan.seconds == 0 {
        anyhow::bail!("capture duration must be greater than zero");
    }

    if plan.channels == 0 {
        anyhow::bail!("capture channel count must be greater than zero");
    }

    let output_path = &plan.output_path;

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create capture output directory {}", parent.display()))?;
    }

    let output_text = output_path.to_string_lossy().to_string();
    let args = capture_command_args(plan, &output_text)?;
    let child = Command::new(&plan.command)
        .args(&args)
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("run capture command {}", plan.command))?;

    Ok(CaptureChild {
        child,
        command: plan.command.clone(),
        min_output_bytes: plan.min_output_bytes,
        monitor: CaptureGrowthMonitor::new(
            plan.growth_grace_seconds,
            plan.stalled_seconds,
            Instant::now(),
        ),
        output_path: output_path.clone(),
    })
}

pub fn estimated_capture_bytes(plan: &CapturePlan) -> u64 {
    const WAV_HEADER_SAFETY_BYTES: u64 = 4096;

    u64::from(plan.sample_rate)
        .saturating_mul(u64::from(plan.channels))
        .saturating_mul(sample_format_bytes(&plan.format))
        .saturating_mul(plan.seconds)
        .saturating_add(WAV_HEADER_SAFETY_BYTES)
}

/// Effective duration to size a chunked job's disk preflight on: at most one open
/// chunk plus its raw + rendered (+ enhanced) working copies coexist on disk, so a
/// few chunk lengths of headroom — not the whole recording duration — is required.
pub fn chunk_disk_estimate_seconds(chunk_seconds: u64) -> u64 {
    const CHUNK_WORKING_COPY_FACTOR: u64 = 4;

    chunk_seconds
        .max(1)
        .saturating_mul(CHUNK_WORKING_COPY_FACTOR)
}

pub(crate) fn sample_format_bytes(format: &str) -> u64 {
    match format {
        "S8" | "U8" => 1,
        "S24_LE" | "S24_BE" | "U24_LE" | "U24_BE" => 3,
        "S32_LE" | "S32_BE" | "U32_LE" | "U32_BE" | "FLOAT_LE" | "FLOAT_BE" => 4,
        _ => 2,
    }
}

pub struct CaptureChild {
    child: Child,
    command: String,
    min_output_bytes: u64,
    monitor: CaptureGrowthMonitor,
    output_path: PathBuf,
}

impl CaptureChild {
    pub fn try_complete(&mut self) -> anyhow::Result<Option<PathBuf>> {
        let Some(status) = self
            .child
            .try_wait()
            .with_context(|| format!("poll capture command {}", self.command))?
        else {
            return Ok(None);
        };

        if !status.success() {
            anyhow::bail!("{}", self.failure_message(status));
        }

        verify_capture_output(&self.output_path, self.min_output_bytes)?;

        Ok(Some(self.output_path.clone()))
    }

    pub fn check_growth(&mut self) -> Result<CaptureGrowthSnapshot, CaptureGrowthError> {
        let size_bytes = fs::metadata(&self.output_path)
            .ok()
            .map(|metadata| metadata.len());

        self.monitor.observe(size_bytes, Instant::now())
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.child
            .kill()
            .with_context(|| format!("stop capture command {}", self.command))?;
        let _ = self.child.wait();

        Ok(())
    }

    fn wait(mut self) -> anyhow::Result<PathBuf> {
        let status = self
            .child
            .wait()
            .with_context(|| format!("wait for capture command {}", self.command))?;

        if !status.success() {
            anyhow::bail!("{}", self.failure_message(status));
        }

        verify_capture_output(&self.output_path, self.min_output_bytes)?;

        Ok(self.output_path)
    }

    fn failure_message(&mut self, status: ExitStatus) -> String {
        let stderr = self.capture_stderr();

        if stderr.is_empty() {
            return format!(
                "capture command {} failed with status {status}",
                self.command
            );
        }

        format!(
            "capture command {} failed with status {status}: {stderr}",
            self.command
        )
    }

    fn capture_stderr(&mut self) -> String {
        let Some(mut stderr) = self.child.stderr.take() else {
            return String::new();
        };
        let mut output = String::new();
        let _ = stderr.read_to_string(&mut output);

        output.trim().to_string()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureGrowthSnapshot {
    pub age_seconds: u64,
    pub last_growth_seconds_ago: u64,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CaptureGrowthError {
    snapshot: CaptureGrowthSnapshot,
}

impl CaptureGrowthError {
    pub fn snapshot(&self) -> &CaptureGrowthSnapshot {
        &self.snapshot
    }
}

impl fmt::Display for CaptureGrowthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "capture output stalled: size={:?} age={}s unchanged={}s",
            self.snapshot.size_bytes,
            self.snapshot.age_seconds,
            self.snapshot.last_growth_seconds_ago
        )
    }
}

impl std::error::Error for CaptureGrowthError {}

#[derive(Debug)]
pub(crate) struct CaptureGrowthMonitor {
    grace_period: Duration,
    last_growth_at: Instant,
    last_size_bytes: Option<u64>,
    stalled_period: Duration,
    started_at: Instant,
}

impl CaptureGrowthMonitor {
    pub(crate) fn new(grace_seconds: u64, stalled_seconds: u64, started_at: Instant) -> Self {
        Self {
            grace_period: Duration::from_secs(grace_seconds),
            last_growth_at: started_at,
            last_size_bytes: None,
            stalled_period: Duration::from_secs(stalled_seconds.max(1)),
            started_at,
        }
    }

    pub(crate) fn observe(
        &mut self,
        size_bytes: Option<u64>,
        now: Instant,
    ) -> Result<CaptureGrowthSnapshot, CaptureGrowthError> {
        if let Some(size) = size_bytes
            && size > self.last_size_bytes.unwrap_or(0)
        {
            self.last_size_bytes = Some(size);
            self.last_growth_at = now;
        }

        let age = now.duration_since(self.started_at);
        let last_growth_age = now.duration_since(self.last_growth_at);
        let snapshot = CaptureGrowthSnapshot {
            age_seconds: age.as_secs(),
            last_growth_seconds_ago: last_growth_age.as_secs(),
            size_bytes,
        };

        if age <= self.grace_period {
            return Ok(snapshot);
        }

        if last_growth_age >= self.stalled_period {
            return Err(CaptureGrowthError { snapshot });
        }

        Ok(snapshot)
    }
}

fn verify_capture_output(output_path: &Path, min_output_bytes: u64) -> anyhow::Result<()> {
    let metadata = fs::metadata(output_path)
        .with_context(|| format!("inspect capture output {}", output_path.display()))?;

    if metadata.len() < min_output_bytes {
        validate_capture_output_size(output_path, metadata.len(), min_output_bytes)?;
    }

    info!(
        output = %output_path.display(),
        size = metadata.len(),
        "recording capture job completed"
    );

    Ok(())
}

fn validate_capture_output_size(
    output_path: &Path,
    size_bytes: u64,
    min_output_bytes: u64,
) -> anyhow::Result<()> {
    if size_bytes < min_output_bytes {
        anyhow::bail!(
            "capture output is too small: {} has {} bytes, expected at least {}",
            output_path.display(),
            size_bytes,
            min_output_bytes
        );
    }

    Ok(())
}

pub fn pipewire_sample_count(sample_rate: u32, seconds: u64) -> u64 {
    u64::from(sample_rate) * seconds.max(1)
}

pub fn pipewire_sample_format(format: &str) -> &str {
    match format.to_ascii_uppercase().as_str() {
        "S16_LE" => "s16",
        "S24_LE" => "s24",
        "S32_LE" => "s32",
        "FLOAT_LE" | "F32_LE" => "f32",
        _ => "s16",
    }
}

#[cfg(test)]
#[path = "capture/tests.rs"]
mod tests;
