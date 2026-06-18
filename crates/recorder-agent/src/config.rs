use std::path::PathBuf;

use clap::Parser;

#[derive(Clone, Debug, Parser)]
#[command(author, version, about = "Rakkr recorder node agent")]
pub struct AgentConfig {
    #[arg(
        long,
        env = "RAKKR_CONTROLLER_URL",
        default_value = "http://localhost:8787"
    )]
    pub controller_url: String,

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

    #[arg(long, env = "RAKKR_CAPTURE_FORMAT", default_value = "S16_LE")]
    pub capture_format: String,

    #[arg(long, env = "RAKKR_CAPTURE_SECONDS", default_value_t = 60)]
    pub capture_seconds: u64,

    #[arg(long, env = "RAKKR_CAPTURE_SAMPLE_RATE", default_value_t = 48_000)]
    pub capture_sample_rate: u32,

    #[arg(long, env = "RAKKR_CAPTURE_CHANNELS", default_value_t = 2)]
    pub capture_channels: u16,

    #[arg(long, env = "RAKKR_METER_BACKEND", default_value = "alsa")]
    pub meter_backend: String,

    #[arg(long, env = "RAKKR_METER_SAMPLE_SECONDS", default_value_t = 1)]
    pub meter_sample_seconds: u64,

    #[arg(long, env = "RAKKR_METER_CLIP_DBFS", default_value_t = -1.0)]
    pub meter_clip_dbfs: f32,

    #[arg(long, env = "RAKKR_METER_FLATLINE_DBFS", default_value_t = -120.0)]
    pub meter_flatline_dbfs: f32,

    #[arg(long, env = "RAKKR_RUN_NEXT_JOB", default_value_t = false)]
    pub run_next_job: bool,

    #[arg(
        long,
        env = "RAKKR_AGENT_STATE_FILE",
        default_value = "data/agent/job-state.json"
    )]
    pub agent_state_file: PathBuf,

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
}
