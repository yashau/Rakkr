use std::path::PathBuf;

use anyhow::{Context, bail};
use clap::{Parser, ValueEnum};
use reqwest::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum MeterBackend {
    Alsa,
    Synthetic,
}

impl MeterBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alsa => "alsa",
            Self::Synthetic => "synthetic",
        }
    }
}

#[derive(Clone, Debug, Parser)]
#[command(author, version, about = "Rakkr recorder node agent")]
pub struct AgentConfig {
    #[arg(
        long,
        env = "RAKKR_CONTROLLER_URL",
        default_value = "http://localhost:8787"
    )]
    pub controller_url: String,

    #[arg(long, env = "RAKKR_ALLOW_INSECURE_CONTROLLER", default_value_t = false)]
    pub allow_insecure_controller: bool,

    #[arg(long, env = "RAKKR_NODE_ID", default_value = "node_local_dev")]
    pub node_id: String,

    #[arg(long, env = "RAKKR_NODE_ALIAS", default_value = "Local Recorder Node")]
    pub alias: String,

    #[arg(long, env = "RAKKR_NODE_SITE", default_value = "Unassigned Site")]
    pub site: String,

    #[arg(long, env = "RAKKR_NODE_ROOM", default_value = "Unassigned Room")]
    pub room: String,

    #[arg(long, env = "RAKKR_HEARTBEAT_SECONDS", default_value_t = 5)]
    pub heartbeat_seconds: u64,

    #[arg(long, default_value_t = false)]
    pub print_inventory: bool,

    #[arg(long, default_value_t = false)]
    pub print_meter_frame: bool,

    #[arg(
        long,
        env = "RAKKR_PRINT_CHANNEL_MAP_ASSIGNMENTS",
        default_value_t = false
    )]
    pub print_channel_map_assignments: bool,

    #[arg(long, env = "RAKKR_CONTROLLER_TOKEN")]
    pub controller_token: Option<String>,

    #[arg(long, env = "RAKKR_ATTACH_CACHE_RECORDING_ID")]
    pub attach_cache_recording_id: Option<String>,

    #[arg(long, env = "RAKKR_ATTACH_CACHE_FILE")]
    pub attach_cache_file: Option<PathBuf>,

    #[arg(
        long,
        env = "RAKKR_ATTACH_CACHE_CONTENT_TYPE",
        default_value = "audio/mpeg"
    )]
    pub attach_cache_content_type: String,

    #[arg(long, env = "RAKKR_ATTACH_CACHE_DURATION_SECONDS")]
    pub attach_cache_duration_seconds: Option<u64>,

    #[arg(long, env = "RAKKR_ATTACH_CACHE_FILE_NAME")]
    pub attach_cache_file_name: Option<String>,

    #[arg(long, env = "RAKKR_CAPTURE_RECORDING_ID")]
    pub capture_recording_id: Option<String>,

    #[arg(long, env = "RAKKR_CAPTURE_OUTPUT")]
    pub capture_output: Option<PathBuf>,

    #[arg(long, env = "RAKKR_CAPTURE_DEVICE", default_value = "default")]
    pub capture_device: String,

    #[arg(long, env = "RAKKR_CAPTURE_COMMAND", default_value = "arecord")]
    pub capture_command: String,

    #[arg(long, env = "RAKKR_CAPTURE_ARGS_TEMPLATE")]
    pub capture_args_template: Option<String>,

    #[arg(long, env = "RAKKR_CHANNEL_RENDER_COMMAND", default_value = "ffmpeg")]
    pub channel_render_command: String,

    #[arg(long, env = "RAKKR_CAPTURE_FORMAT", default_value = "S16_LE")]
    pub capture_format: String,

    #[arg(long, env = "RAKKR_CAPTURE_SECONDS", default_value_t = 60)]
    pub capture_seconds: u64,

    #[arg(long, env = "RAKKR_CAPTURE_SAMPLE_RATE", default_value_t = 48_000)]
    pub capture_sample_rate: u32,

    #[arg(long, env = "RAKKR_CAPTURE_CHANNELS", default_value_t = 2)]
    pub capture_channels: u16,

    #[arg(long, env = "RAKKR_CAPTURE_MIN_OUTPUT_BYTES", default_value_t = 128)]
    pub capture_min_output_bytes: u64,

    #[arg(long, env = "RAKKR_CAPTURE_GROWTH_GRACE_SECONDS", default_value_t = 10)]
    pub capture_growth_grace_seconds: u64,

    #[arg(long, env = "RAKKR_CAPTURE_STALLED_SECONDS", default_value_t = 30)]
    pub capture_stalled_seconds: u64,

    #[arg(long, env = "RAKKR_METER_BACKEND", value_enum, default_value_t = MeterBackend::Alsa)]
    pub meter_backend: MeterBackend,

    #[arg(long, env = "RAKKR_METER_ARGS_TEMPLATE")]
    pub meter_args_template: Option<String>,

    #[arg(long, env = "RAKKR_METER_SAMPLE_SECONDS", default_value_t = 1)]
    pub meter_sample_seconds: u64,

    #[arg(long, env = "RAKKR_METER_CLIP_DBFS", default_value_t = -1.0)]
    pub meter_clip_dbfs: f32,

    #[arg(long, env = "RAKKR_METER_FLATLINE_DBFS", default_value_t = -120.0)]
    pub meter_flatline_dbfs: f32,

    #[arg(long, env = "RAKKR_MONITOR_CHUNK_SYNC_ENABLED", default_value_t = true)]
    pub monitor_chunk_sync_enabled: bool,

    #[arg(long, env = "RAKKR_RUN_NEXT_JOB", default_value_t = false)]
    pub run_next_job: bool,

    #[arg(long, env = "RAKKR_MAX_CONCURRENT_RECORDINGS", default_value_t = 1)]
    pub max_concurrent_recordings: usize,

    #[arg(
        long,
        env = "RAKKR_AGENT_STATE_FILE",
        default_value = "data/agent/job-state.json"
    )]
    pub agent_state_file: PathBuf,

    #[arg(
        long,
        env = "RAKKR_RECORDER_CACHE_MANIFEST_FILE",
        default_value = "data/agent/recorder-cache-manifest.json"
    )]
    pub recorder_cache_manifest_file: PathBuf,

    #[arg(long, env = "RAKKR_JOB_POLL_SECONDS", default_value_t = 2)]
    pub job_poll_seconds: u64,

    #[arg(
        long,
        env = "RAKKR_AGENT_HEALTH_LOG_FILE",
        default_value = "data/agent/health-events.jsonl"
    )]
    pub agent_health_log_file: PathBuf,

    #[arg(
        long,
        env = "RAKKR_AGENT_HEALTH_LOG_MAX_BYTES",
        default_value_t = 1_048_576
    )]
    pub agent_health_log_max_bytes: u64,

    #[arg(
        long,
        env = "RAKKR_AGENT_HEALTH_LOG_RETAINED_FILES",
        default_value_t = 3
    )]
    pub agent_health_log_retained_files: u16,

    #[arg(long, env = "RAKKR_SYSTEM_HEALTH_ENABLED", default_value_t = true)]
    pub system_health_enabled: bool,

    #[arg(long, env = "RAKKR_SYSTEM_HEALTH_DISK_PATH", default_value = ".")]
    pub system_health_disk_path: PathBuf,

    #[arg(
        long,
        env = "RAKKR_SYSTEM_HEALTH_DISK_WARNING_PERCENT",
        default_value_t = 85.0
    )]
    pub system_health_disk_warning_percent: f32,

    #[arg(
        long,
        env = "RAKKR_SYSTEM_HEALTH_DISK_CRITICAL_PERCENT",
        default_value_t = 95.0
    )]
    pub system_health_disk_critical_percent: f32,

    #[arg(
        long,
        env = "RAKKR_SYSTEM_HEALTH_LOAD_WARNING_PER_CORE",
        default_value_t = 2.0
    )]
    pub system_health_load_warning_per_core: f32,

    #[arg(
        long,
        env = "RAKKR_SYSTEM_HEALTH_LOAD_CRITICAL_PER_CORE",
        default_value_t = 4.0
    )]
    pub system_health_load_critical_per_core: f32,
}

impl AgentConfig {
    pub fn validate_controller_transport(&self) -> anyhow::Result<()> {
        validate_controller_transport(&self.controller_url, self.allow_insecure_controller)
    }
}

pub fn validate_controller_transport(
    controller_url: &str,
    allow_insecure_controller: bool,
) -> anyhow::Result<()> {
    let url = Url::parse(controller_url).context("parse controller URL")?;

    match url.scheme() {
        "https" => Ok(()),
        "http" if allow_insecure_controller || is_loopback_host(url.host_str()) => Ok(()),
        "http" => bail!(
            "controller URL must use HTTPS for non-loopback hosts; set --allow-insecure-controller only for explicit development exceptions"
        ),
        _ => bail!("controller URL must use http or https"),
    }
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let host = host.trim_matches(['[', ']']);

    host.eq_ignore_ascii_case("localhost") || host == "::1" || host.starts_with("127.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_controller_urls() {
        validate_controller_transport("https://controller.local:8787", false).unwrap();
    }

    #[test]
    fn accepts_loopback_http_for_local_development() {
        validate_controller_transport("http://localhost:8787", false).unwrap();
        validate_controller_transport("http://127.0.0.1:8787", false).unwrap();
        validate_controller_transport("http://[::1]:8787", false).unwrap();
    }

    #[test]
    fn rejects_non_loopback_http_by_default() {
        let error = validate_controller_transport("http://172.22.145.10:8787", false)
            .expect_err("plaintext LAN controller URL should fail");

        assert!(error.to_string().contains("must use HTTPS"));
    }

    #[test]
    fn can_explicitly_allow_insecure_controller_transport() {
        validate_controller_transport("http://172.22.145.10:8787", true).unwrap();
    }
}
