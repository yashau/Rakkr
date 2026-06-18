use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use anyhow::Context;
use serde::Serialize;

use crate::config::AgentConfig;
use crate::telemetry::now_rfc3339;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealthEvent {
    pub details: serde_json::Value,
    pub id: String,
    pub opened_at: String,
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    pub r#type: String,
}

pub fn append_health_event(
    config: &AgentConfig,
    event_type: &str,
    severity: &str,
    details: serde_json::Value,
) -> anyhow::Result<AgentHealthEvent> {
    let event = AgentHealthEvent {
        details,
        id: format!(
            "node_event_{}_{}",
            config.node_id,
            now_rfc3339().replace([':', '.'], "-")
        ),
        opened_at: now_rfc3339(),
        recording_id: None,
        schedule_id: None,
        severity: severity.to_string(),
        r#type: event_type.to_string(),
    };

    rotate_if_needed(
        &config.agent_health_log_file,
        config.agent_health_log_max_bytes,
    )?;
    append_json_line(&config.agent_health_log_file, &event)?;

    Ok(event)
}

fn append_json_line(path: &Path, event: &AgentHealthEvent) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create health log directory {}", parent.display()))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open health log {}", path.display()))?;

    serde_json::to_writer(&mut file, event).context("encode health event")?;
    file.write_all(b"\n")
        .context("write health event newline")?;

    Ok(())
}

fn rotate_if_needed(path: &Path, max_bytes: u64) -> anyhow::Result<()> {
    if max_bytes == 0 || !path.exists() {
        return Ok(());
    }

    let metadata =
        fs::metadata(path).with_context(|| format!("stat health log {}", path.display()))?;

    if metadata.len() < max_bytes {
        return Ok(());
    }

    let rotated = path.with_extension("jsonl.1");

    if rotated.exists() {
        fs::remove_file(&rotated)
            .with_context(|| format!("remove rotated health log {}", rotated.display()))?;
    }

    fs::rename(path, &rotated).with_context(|| {
        format!(
            "rotate health log {} to {}",
            path.display(),
            rotated.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_health_event() {
        let event = AgentHealthEvent {
            details: serde_json::json!({ "ok": true }),
            id: "node_event_test".to_string(),
            opened_at: "2026-06-18T00:00:00Z".to_string(),
            recording_id: None,
            schedule_id: None,
            severity: "info".to_string(),
            r#type: "agent.test".to_string(),
        };
        let payload = serde_json::to_string(&event).expect("encode health event");

        assert!(payload.contains("\"openedAt\""));
        assert!(payload.contains("\"agent.test\""));
    }
}
