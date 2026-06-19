use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

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
    append_health_event_with_targets(config, event_type, severity, details, None, None)
}

pub fn append_health_event_with_targets(
    config: &AgentConfig,
    event_type: &str,
    severity: &str,
    details: serde_json::Value,
    recording_id: Option<String>,
    schedule_id: Option<String>,
) -> anyhow::Result<AgentHealthEvent> {
    let event = AgentHealthEvent {
        details,
        id: format!(
            "node_event_{}_{}",
            config.node_id,
            now_rfc3339().replace([':', '.'], "-")
        ),
        opened_at: now_rfc3339(),
        recording_id,
        schedule_id,
        severity: severity.to_string(),
        r#type: event_type.to_string(),
    };

    rotate_if_needed(
        &config.agent_health_log_file,
        config.agent_health_log_max_bytes,
        config.agent_health_log_retained_files,
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

fn rotate_if_needed(path: &Path, max_bytes: u64, retained_files: u16) -> anyhow::Result<()> {
    if max_bytes == 0 || !path.exists() {
        return Ok(());
    }

    let metadata =
        fs::metadata(path).with_context(|| format!("stat health log {}", path.display()))?;

    if metadata.len() < max_bytes {
        return Ok(());
    }

    if retained_files == 0 {
        fs::remove_file(path)
            .with_context(|| format!("remove oversized health log {}", path.display()))?;
        return Ok(());
    }

    let last_rotated = rotated_log_path(path, retained_files);

    if last_rotated.exists() {
        fs::remove_file(&last_rotated)
            .with_context(|| format!("remove retained health log {}", last_rotated.display()))?;
    }

    for index in (1..retained_files).rev() {
        let current = rotated_log_path(path, index);
        let next = rotated_log_path(path, index + 1);

        if current.exists() {
            fs::rename(&current, &next).with_context(|| {
                format!(
                    "rotate health log {} to {}",
                    current.display(),
                    next.display()
                )
            })?;
        }
    }

    let first_rotated = rotated_log_path(path, 1);

    fs::rename(path, &first_rotated).with_context(|| {
        format!(
            "rotate health log {} to {}",
            path.display(),
            first_rotated.display()
        )
    })
}

fn rotated_log_path(path: &Path, index: u16) -> PathBuf {
    if let Some(file_name) = path.file_name() {
        return path.with_file_name(format!("{}.{index}", file_name.to_string_lossy()));
    }

    path.with_extension(index.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

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

    #[test]
    #[cfg_attr(miri, ignore)]
    fn rotates_with_configured_retention_count() {
        let path = temp_health_log_path("retention");
        let first = rotated_log_path(&path, 1);
        let second = rotated_log_path(&path, 2);
        let third = rotated_log_path(&path, 3);

        fs::write(&path, "active\n").expect("write active log");
        fs::write(&first, "older-one\n").expect("write first rotated log");
        fs::write(&second, "older-two\n").expect("write second rotated log");

        rotate_if_needed(&path, 1, 2).expect("rotate log");

        assert_eq!(fs::read_to_string(&first).unwrap(), "active\n");
        assert_eq!(fs::read_to_string(&second).unwrap(), "older-one\n");
        assert!(!third.exists());

        cleanup(&path);
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn zero_retained_files_removes_oversized_active_log() {
        let path = temp_health_log_path("no-retention");

        fs::write(&path, "active\n").expect("write active log");

        rotate_if_needed(&path, 1, 0).expect("rotate log");

        assert!(!path.exists());

        cleanup(&path);
    }

    fn temp_health_log_path(name: &str) -> PathBuf {
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory =
            PathBuf::from("target").join(format!("rakkr-agent-health-log-{name}-{counter}"));

        fs::create_dir_all(&directory).expect("create temp health log directory");

        directory.join("health-events.jsonl")
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
