use std::fs;
use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::config::AgentConfig;
use crate::controller::ControllerRecordingJob;
use crate::telemetry::now_rfc3339;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJobState {
    pub job_id: String,
    pub node_id: String,
    pub output_path: Option<String>,
    pub reason: Option<String>,
    pub recording_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovered_segments: Vec<AgentRecoveredCaptureSegment>,
    pub status: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecoveredCaptureSegment {
    pub attempt: u8,
    pub bytes: u64,
    pub path: String,
    pub reason: String,
}

pub fn write_job_state(
    config: &AgentConfig,
    job: &ControllerRecordingJob,
    status: &str,
    output_path: Option<&Path>,
    reason: Option<&str>,
) -> anyhow::Result<()> {
    write_job_state_snapshot(
        config,
        AgentJobState {
            job_id: job.id.clone(),
            node_id: job.node_id.clone(),
            output_path: output_path.map(|path| path.display().to_string()),
            reason: reason.map(str::to_string),
            recording_id: job.recording_id.clone(),
            recovered_segments: Vec::new(),
            status: status.to_string(),
            updated_at: now_rfc3339(),
        },
    )
}

pub fn write_job_state_snapshot(config: &AgentConfig, state: AgentJobState) -> anyhow::Result<()> {
    if let Some(parent) = config.agent_state_file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create agent state directory {}", parent.display()))?;
    }

    fs::write(&config.agent_state_file, serde_json::to_vec_pretty(&state)?)
        .with_context(|| format!("write agent state {}", config.agent_state_file.display()))
}

pub fn read_job_state(config: &AgentConfig) -> anyhow::Result<Option<AgentJobState>> {
    if !config.agent_state_file.exists() {
        return Ok(None);
    }

    let bytes = fs::read(&config.agent_state_file)
        .with_context(|| format!("read agent state {}", config.agent_state_file.display()))?;
    let state = serde_json::from_slice(&bytes)
        .with_context(|| format!("decode agent state {}", config.agent_state_file.display()))?;

    Ok(Some(state))
}

impl AgentJobState {
    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "cancelled" | "completed" | "failed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    #[cfg_attr(miri, ignore)]
    fn reads_written_job_state_snapshot() {
        let state_file = temp_state_file("snapshot");
        let state_file_arg = state_file.to_string_lossy().into_owned();
        let config =
            AgentConfig::parse_from(["test", "--agent-state-file", state_file_arg.as_str()]);

        write_job_state_snapshot(
            &config,
            AgentJobState {
                job_id: "job_recovery".to_string(),
                node_id: "node_recovery".to_string(),
                output_path: Some("/tmp/recovery.wav".to_string()),
                reason: Some("interrupted".to_string()),
                recording_id: "rec_recovery".to_string(),
                recovered_segments: vec![AgentRecoveredCaptureSegment {
                    attempt: 1,
                    bytes: 128,
                    path: "/tmp/recovery.segment.wav".to_string(),
                    reason: "device_lost".to_string(),
                }],
                status: "running".to_string(),
                updated_at: "2026-06-25T00:00:00Z".to_string(),
            },
        )
        .expect("write state");

        let loaded = read_job_state(&config).expect("read state").expect("state");

        assert_eq!(loaded.job_id, "job_recovery");
        assert_eq!(loaded.recording_id, "rec_recovery");
        assert_eq!(loaded.status, "running");
        assert_eq!(loaded.recovered_segments.len(), 1);
        assert_eq!(loaded.recovered_segments[0].attempt, 1);
        assert!(!loaded.is_terminal());

        cleanup(&state_file);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn missing_job_state_returns_none() {
        let state_file = temp_state_file("missing");
        let state_file_arg = state_file.to_string_lossy().into_owned();
        let config =
            AgentConfig::parse_from(["test", "--agent-state-file", state_file_arg.as_str()]);

        assert!(read_job_state(&config).expect("read state").is_none());

        cleanup(&state_file);
    }

    fn temp_state_file(name: &str) -> std::path::PathBuf {
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::path::PathBuf::from("target")
            .join(format!("rakkr-agent-state-{name}-{counter}"))
            .join("state.json")
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
