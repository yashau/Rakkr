use std::fs;
use std::path::Path;

use anyhow::Context;
use serde::Serialize;

use crate::config::AgentConfig;
use crate::controller::ControllerRecordingJob;
use crate::telemetry::now_rfc3339;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJobState {
    job_id: String,
    node_id: String,
    output_path: Option<String>,
    reason: Option<String>,
    recording_id: String,
    status: String,
    updated_at: String,
}

pub fn write_job_state(
    config: &AgentConfig,
    job: &ControllerRecordingJob,
    status: &str,
    output_path: Option<&Path>,
    reason: Option<&str>,
) -> anyhow::Result<()> {
    let state = AgentJobState {
        job_id: job.id.clone(),
        node_id: job.node_id.clone(),
        output_path: output_path.map(|path| path.display().to_string()),
        reason: reason.map(str::to_string),
        recording_id: job.recording_id.clone(),
        status: status.to_string(),
        updated_at: now_rfc3339(),
    };

    if let Some(parent) = config.agent_state_file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create agent state directory {}", parent.display()))?;
    }

    fs::write(&config.agent_state_file, serde_json::to_vec_pretty(&state)?)
        .with_context(|| format!("write agent state {}", config.agent_state_file.display()))
}
