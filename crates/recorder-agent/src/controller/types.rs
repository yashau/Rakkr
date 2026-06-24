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
    pub capture_device: String,
    pub capture_format: String,
    pub capture_interface_id: Option<String>,
    pub capture_sample_rate: u32,
    pub channel_map: Option<ControllerRecordingJobChannelMap>,
    pub duration_seconds: u64,
    pub output_bitrate_kbps: Option<u32>,
    pub output_codec: Option<String>,
    pub output_file_name: String,
    pub output_vbr: Option<bool>,
    pub recorder_cache_retention: Option<ControllerRecorderCacheRetention>,
    pub track_group_id: Option<String>,
    pub track_index: Option<u32>,
    pub track_total: Option<u32>,
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
