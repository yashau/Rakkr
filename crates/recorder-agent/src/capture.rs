use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::Serialize;
use tracing::info;

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

fn safe_file_stem(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();

    if cleaned.is_empty() {
        "recording".to_string()
    } else {
        cleaned
    }
}

pub fn safe_file_name(value: &str) -> String {
    let base_name = value.rsplit(['/', '\\']).next().unwrap_or(value);
    let cleaned = base_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "recording.wav".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AgentConfig {
        AgentConfig {
            agent_health_log_file: PathBuf::from("health-events.jsonl"),
            agent_health_log_max_bytes: 1_048_576,
            agent_health_log_retained_files: 3,
            agent_health_log_store: crate::config::AgentHealthLogStore::Jsonl,
            agent_health_sqlite_file: PathBuf::from("health-events.sqlite3"),
            allow_insecure_controller: false,
            alias: "Node".to_string(),
            attach_cache_content_type: "audio/mpeg".to_string(),
            attach_cache_duration_seconds: None,
            attach_cache_file: None,
            attach_cache_file_name: None,
            attach_cache_recording_id: None,
            agent_state_file: PathBuf::from("state.json"),
            capture_args_template: None,
            capture_backend: crate::config::CaptureBackend::Alsa,
            capture_channels: 1,
            channel_render_command: "ffmpeg".to_string(),
            capture_command: "arecord".to_string(),
            capture_device: "hw:2,0".to_string(),
            capture_format: "S16_LE".to_string(),
            capture_growth_grace_seconds: 10,
            capture_min_output_bytes: 128,
            capture_output: Some(PathBuf::from("/tmp/rec.wav")),
            capture_output_bitrate_kbps: None,
            capture_output_codec: None,
            capture_output_vbr: true,
            capture_recording_id: Some("rec_123".to_string()),
            capture_sample_rate: 48_000,
            capture_seconds: 15,
            capture_chunk_seconds: None,
            capture_stalled_seconds: 30,
            controller_ca_cert_path: None,
            controller_token: Some("token".to_string()),
            bootstrap: false,
            bootstrap_token: None,
            bootstrap_authorized_keys_path: PathBuf::from(
                "/var/lib/rakkr/agent/.ssh/authorized_keys",
            ),
            bootstrap_env_file: PathBuf::from("/etc/rakkr/recorder-agent.env"),
            ssh_keygen_command: "ssh-keygen".to_string(),
            controller_url: "http://localhost:8787".to_string(),
            heartbeat_seconds: 5,
            inventory_arecord_command: "arecord".to_string(),
            inventory_proc_asound_pcm_path: PathBuf::from("/proc/asound/pcm"),
            job_poll_seconds: 2,
            meter_backend: crate::config::MeterBackend::Alsa,
            meter_args_template: None,
            meter_clip_dbfs: -1.0,
            meter_flatline_dbfs: -120.0,
            meter_low_signal_dbfs: -55.0,
            meter_sample_seconds: 1,
            monitor_chunk_sync_enabled: true,
            max_concurrent_recordings: 1,
            node_id: "node".to_string(),
            print_channel_map_assignments: false,
            print_inventory: false,
            print_meter_frame: false,
            recorder_cache_manifest_file: PathBuf::from("recorder-cache-manifest.json"),
            run_next_job: false,
            room: "Room".to_string(),
            site: "Site".to_string(),
            system_health_disk_critical_percent: 95.0,
            system_health_df_command: "df".to_string(),
            system_health_disk_path: PathBuf::from("."),
            system_health_disk_warning_percent: 85.0,
            system_health_enabled: true,
            system_health_load_critical_per_core: 4.0,
            system_health_load_warning_per_core: 2.0,
            system_health_loadavg_path: PathBuf::from("/proc/loadavg"),
        }
    }

    #[test]
    fn builds_arecord_capture_args() {
        assert_eq!(
            capture_command_args(
                &capture_plan_from_config(&config()).unwrap(),
                "/tmp/rec.wav"
            )
            .unwrap(),
            vec![
                "-D",
                "hw:2,0",
                "-f",
                "S16_LE",
                "-r",
                "48000",
                "-c",
                "1",
                "-d",
                "15",
                "/tmp/rec.wav",
            ]
        );
    }

    #[test]
    fn builds_templated_capture_args() {
        let mut config = config();

        config.capture_args_template = Some(
            "--target {device} --rate {sample_rate} --channels {channels} --format {format} --duration {seconds} --file {output}"
                .to_string(),
        );

        assert_eq!(
            capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav")
                .unwrap(),
            vec![
                "--target",
                "hw:2,0",
                "--rate",
                "48000",
                "--channels",
                "1",
                "--format",
                "S16_LE",
                "--duration",
                "15",
                "--file",
                "/tmp/rec.wav",
            ]
        );
    }

    #[test]
    fn builds_pipewire_capture_args() {
        let mut config = config();
        config.capture_backend = crate::config::CaptureBackend::Pipewire;
        config.capture_device = "alsa_input.usb-recorder".to_string();
        config.capture_format = "S16_LE".to_string();
        config.capture_sample_rate = 48_000;
        config.capture_seconds = 2;
        config.capture_channels = 2;

        assert_eq!(
            capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav")
                .unwrap(),
            vec![
                "--record",
                "--target",
                "alsa_input.usb-recorder",
                "--rate",
                "48000",
                "--channels",
                "2",
                "--format",
                "s16",
                "--sample-count",
                "96000",
                "--container",
                "wav",
                "/tmp/rec.wav",
            ]
        );
    }

    #[test]
    fn builds_jack_capture_args() {
        let mut config = config();
        config.capture_backend = crate::config::CaptureBackend::Jack;
        config.capture_device = "system:capture_1".to_string();
        config.capture_seconds = 2;
        config.capture_channels = 2;

        assert_eq!(
            capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav")
                .unwrap(),
            vec![
                "--channels",
                "2",
                "--duration",
                "2",
                "--format",
                "wav",
                "--disable-console",
                "--port",
                "system:capture_1",
                "/tmp/rec.wav",
            ]
        );
    }

    #[test]
    fn chunk_disk_estimate_uses_working_copy_headroom() {
        // Four chunk-lengths of headroom for the open chunk + raw/rendered/enhanced
        // working copies, and at least one second even for a zero input.
        assert_eq!(chunk_disk_estimate_seconds(5), 20);
        assert_eq!(chunk_disk_estimate_seconds(0), 4);
    }

    #[test]
    fn chunk_plan_clone_gives_per_chunk_unique_final_stem() {
        let plan = capture_plan_from_config(&config()).unwrap();
        let dir = Path::new("/tmp/chunks");
        let chunk_wav = dir.join("rec.chunk-0003.wav");
        let chunk_plan = plan.chunk_plan(dir, "rec", 3, &chunk_wav);

        assert_eq!(chunk_plan.output_path, chunk_wav);
        assert!(chunk_plan.final_output_path.ends_with("rec.chunk-0003.wav"));
        // The clone preserves capture parameters.
        assert_eq!(chunk_plan.sample_rate, plan.sample_rate);
        assert_eq!(chunk_plan.channels, plan.channels);
    }

    #[test]
    fn chunk_plan_channel_mapped_wav_renders_to_a_distinct_path() {
        let mut plan = capture_plan_from_config(&config()).unwrap();
        plan.channel_map = Some(CaptureChannelMap {
            assignment_id: "assignment".to_string(),
            channel_mode: "mono".to_string(),
            entries: Vec::new(),
            source_channels: 1,
            target_id: "target".to_string(),
            target_type: "node".to_string(),
            template_id: "template".to_string(),
            template_name: "Template".to_string(),
        });
        let dir = Path::new("/tmp/chunks");
        let chunk_wav = dir.join("rec.chunk-0003.wav");
        let chunk_plan = plan.chunk_plan(dir, "rec", 3, &chunk_wav);

        // Pre-fix final_output_path == output_path == chunk_wav, so a wav
        // channel-map render read and wrote the same file in place.
        assert_eq!(chunk_plan.output_path, chunk_wav);
        assert_ne!(chunk_plan.final_output_path, chunk_wav);
        assert!(
            chunk_plan
                .final_output_path
                .ends_with("rec.chunk-0003.rendered.wav")
        );
    }

    #[test]
    fn estimates_capture_bytes_from_format_rate_channels_and_duration() {
        let mut config = config();
        config.capture_channels = 2;
        config.capture_format = "S32_LE".to_string();
        config.capture_sample_rate = 48_000;
        config.capture_seconds = 10;
        let plan = capture_plan_from_config(&config).expect("plan");

        assert_eq!(estimated_capture_bytes(&plan), 3_844_096);
    }

    #[test]
    fn keeps_quoted_capture_template_segments_as_single_args() {
        let mut config = config();

        config.capture_args_template =
            Some("--property media.name='Rakkr Capture' {output_path}".to_string());

        assert_eq!(
            capture_command_args(
                &capture_plan_from_config(&config).unwrap(),
                "/tmp/recording with spaces.wav"
            )
            .unwrap(),
            vec![
                "--property",
                "media.name=Rakkr Capture",
                "/tmp/recording with spaces.wav",
            ]
        );
    }

    #[test]
    fn rejects_invalid_capture_args_template() {
        let mut config = config();

        config.capture_args_template = Some("--target 'unterminated".to_string());
        let error =
            capture_command_args(&capture_plan_from_config(&config).unwrap(), "/tmp/rec.wav")
                .expect_err("unterminated quote should fail");

        assert!(error.to_string().contains("capture args template"));
    }

    #[test]
    fn sanitizes_default_capture_output_name() {
        let mut config = config();

        config.capture_output = None;
        config.capture_recording_id = Some("rec/with spaces".to_string());

        assert!(
            capture_output_path(&config)
                .unwrap()
                .ends_with("rakkr-capture-rec_with_spaces.wav")
        );
    }

    #[test]
    fn direct_capture_defaults_to_wav_without_render_step() {
        let mut config = config();

        config.capture_output = None;
        config.capture_recording_id = Some("rec_default".to_string());
        let plan = capture_plan_from_config(&config).expect("plan");

        assert!(plan.output_path.ends_with("rakkr-capture-rec_default.wav"));
        assert_eq!(plan.output_path, plan.final_output_path);
        assert_eq!(plan.output_codec, "wav");
        assert_eq!(plan.output_bitrate_kbps, None);
        assert!(!plan.output_vbr);
    }

    #[test]
    fn direct_mp3_capture_uses_raw_wav_and_profile_encoding_defaults() {
        let mut config = config();

        config.capture_output = None;
        config.capture_output_codec = Some("mp3".to_string());
        config.capture_recording_id = Some("rec_mp3".to_string());
        let plan = capture_plan_from_config(&config).expect("plan");

        assert!(
            plan.final_output_path
                .ends_with("rakkr-capture-rec_mp3.mp3")
        );
        assert!(plan.output_path.ends_with("rakkr-capture-rec_mp3.raw.wav"));
        assert_eq!(plan.output_codec, "mp3");
        assert_eq!(plan.output_bitrate_kbps, Some(128));
        assert!(plan.output_vbr);
    }

    #[test]
    fn direct_capture_codec_can_follow_output_extension() {
        let mut config = config();

        config.capture_output = Some(PathBuf::from("/tmp/meeting.flac"));
        let plan = capture_plan_from_config(&config).expect("plan");

        assert!(plan.final_output_path.ends_with("meeting.flac"));
        assert!(plan.output_path.ends_with("meeting.raw.wav"));
        assert_eq!(plan.output_codec, "flac");
    }

    #[test]
    fn direct_capture_explicit_codec_normalizes_final_extension() {
        let mut config = config();

        config.capture_output = Some(PathBuf::from("/tmp/meeting.wav"));
        config.capture_output_codec = Some("mp3".to_string());
        let plan = capture_plan_from_config(&config).expect("plan");

        assert!(plan.final_output_path.ends_with("meeting.mp3"));
        assert!(plan.output_path.ends_with("meeting.raw.wav"));
        assert_eq!(plan.output_codec, "mp3");
    }

    #[test]
    fn local_capture_path_preserves_safe_extension() {
        assert!(
            local_capture_path("../rec with spaces.mp3")
                .ends_with(Path::new("rec_with_spaces.mp3"))
        );
    }

    #[test]
    fn rejects_too_small_capture_output() {
        let error = validate_capture_output_size(&PathBuf::from("small.wav"), 44, 128)
            .expect_err("small file should fail");

        assert!(error.to_string().contains("too small"));
    }

    #[test]
    fn detects_stalled_capture_output_after_grace_period() {
        let started_at = Instant::now();
        let mut monitor = CaptureGrowthMonitor::new(5, 10, started_at);

        monitor
            .observe(None, started_at + Duration::from_secs(6))
            .expect("inside stalled period");
        let error = monitor
            .observe(None, started_at + Duration::from_secs(16))
            .expect_err("missing output should stall");

        assert!(error.to_string().contains("capture output stalled"));
        assert_eq!(
            error.snapshot(),
            &CaptureGrowthSnapshot {
                age_seconds: 16,
                last_growth_seconds_ago: 16,
                size_bytes: None,
            },
        );
    }
}
