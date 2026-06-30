use serde::{Deserialize, Serialize};

use crate::config::CaptureBackend;
use crate::recorder_cache_retention::ControllerRecorderCacheRetention;

pub struct CacheFileUpload<'a> {
    pub allow_insecure_controller: bool,
    pub content_type: &'a str,
    pub controller_ca_cert_path: Option<&'a std::path::Path>,
    pub controller_url: &'a str,
    pub duration_seconds: Option<u64>,
    pub file_name: Option<String>,
    pub file_path: &'a std::path::Path,
    pub job_id: Option<&'a str>,
    pub recording_id: &'a str,
    /// Optional rendition marker forwarded as `?rendition=raw|enhanced`. `None`
    /// uploads the primary (legacy) recording file.
    pub rendition: Option<&'a str>,
    pub token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecordingJob {
    pub command: ControllerCaptureCommand,
    pub failure_reason: Option<String>,
    pub id: String,
    pub node_id: String,
    pub recording_id: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerCaptureCommand {
    pub capture_backend: Option<CaptureBackend>,
    pub capture_channels: u16,
    /// Resolved 1-based source channels this job owns on the interface. Absent =
    /// whole interface. Drives the inline channel map and identifies the job's
    /// channels within a shared capture session.
    #[serde(default)]
    pub capture_channel_selection: Option<Vec<u16>>,
    pub capture_device: String,
    pub capture_format: String,
    /// Jobs sharing an interface + capture window carry the same group id; the
    /// agent captures the device once for the group and renders each job's
    /// channel subset from that single capture.
    #[serde(default)]
    pub capture_group_id: Option<String>,
    pub capture_interface_id: Option<String>,
    pub capture_sample_rate: u32,
    pub channel_map: Option<ControllerRecordingJobChannelMap>,
    pub duration_seconds: u64,
    pub enhancement: Option<ControllerRecordingEnhancement>,
    pub output_bitrate_kbps: Option<u32>,
    pub output_codec: Option<String>,
    pub output_file_name: String,
    pub output_vbr: Option<bool>,
    pub recorder_cache_retention: Option<ControllerRecorderCacheRetention>,
    pub track_group_id: Option<String>,
    pub track_index: Option<u32>,
    pub track_total: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecordingEnhancement {
    pub keep_raw: bool,
    pub denoise: ControllerEnhancementDenoise,
    pub highpass: ControllerEnhancementHighpass,
    pub lowpass: ControllerEnhancementLowpass,
    pub deesser: ControllerEnhancementDeesser,
    pub compressor: ControllerEnhancementCompressor,
    pub loudnorm: ControllerEnhancementLoudnorm,
    pub gate: ControllerEnhancementGate,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementDenoise {
    pub enabled: bool,
    pub engine: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementHighpass {
    pub enabled: bool,
    pub hz: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementLowpass {
    pub enabled: bool,
    pub hz: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementDeesser {
    pub enabled: bool,
    pub intensity: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementCompressor {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementLoudnorm {
    pub enabled: bool,
    pub target_i: f32,
    pub true_peak: f32,
    pub lra: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerEnhancementGate {
    pub enabled: bool,
    pub threshold_db: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecordingJobChannelMap {
    pub assignment_id: String,
    pub channel_mode: String,
    pub entries: Vec<ControllerChannelMapEntry>,
    pub source_channels: u16,
    pub target_id: String,
    pub target_type: String,
    pub template_id: String,
    pub template_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapBundle {
    pub assignment: ControllerChannelMapAssignment,
    pub template: ControllerChannelMapTemplate,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapAssignment {
    pub assigned_at: String,
    pub id: String,
    pub target_id: String,
    pub target_type: String,
    pub template_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapTemplate {
    pub channel_mode: String,
    pub entries: Vec<ControllerChannelMapEntry>,
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerChannelMapEntry {
    pub included: bool,
    pub label: String,
    pub output_channel_index: Option<u16>,
    pub source_channel_index: u16,
}

#[derive(Debug, Deserialize)]
pub(super) struct DataEnvelope<T> {
    pub data: T,
}
