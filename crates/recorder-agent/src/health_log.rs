use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Context;
#[cfg(not(miri))]
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::config::{AgentConfig, AgentHealthLogStore};
use crate::telemetry::now_rfc3339;

static HEALTH_LOG_LOCK: Mutex<()> = Mutex::new(());

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

    let _guard = HEALTH_LOG_LOCK
        .lock()
        .map_err(|error| anyhow::anyhow!("health log lock poisoned: {error}"))?;

    match config.agent_health_log_store {
        AgentHealthLogStore::Jsonl => {
            rotate_if_needed(
                &config.agent_health_log_file,
                config.agent_health_log_max_bytes,
                config.agent_health_log_retained_files,
            )?;
            append_json_line(&config.agent_health_log_file, &event)?;
        }
        AgentHealthLogStore::Sqlite => {
            append_sqlite_event(&config.agent_health_sqlite_file, &config.node_id, &event)?;
        }
    }

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

#[cfg(not(miri))]
fn append_sqlite_event(path: &Path, node_id: &str, event: &AgentHealthEvent) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create health SQLite directory {}", parent.display()))?;
    }

    let connection = Connection::open(path)
        .with_context(|| format!("open health SQLite store {}", path.display()))?;

    initialize_sqlite_store(&connection)?;

    let details_json =
        serde_json::to_string(&event.details).context("encode health event details")?;

    connection
        .execute(
            "INSERT OR REPLACE INTO agent_health_events (
                id,
                node_id,
                type,
                severity,
                opened_at,
                recording_id,
                schedule_id,
                details_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.id.as_str(),
                node_id,
                event.r#type.as_str(),
                event.severity.as_str(),
                event.opened_at.as_str(),
                event.recording_id.as_deref(),
                event.schedule_id.as_deref(),
                details_json,
            ],
        )
        .context("insert health event into SQLite store")?;

    Ok(())
}

#[cfg(miri)]
fn append_sqlite_event(
    _path: &Path,
    _node_id: &str,
    _event: &AgentHealthEvent,
) -> anyhow::Result<()> {
    anyhow::bail!("SQLite health log store is not available under Miri")
}

#[cfg(not(miri))]
fn initialize_sqlite_store(connection: &Connection) -> anyhow::Result<()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_health_events (
                id TEXT PRIMARY KEY NOT NULL,
                node_id TEXT NOT NULL,
                type TEXT NOT NULL,
                severity TEXT NOT NULL,
                opened_at TEXT NOT NULL,
                recording_id TEXT,
                schedule_id TEXT,
                details_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS agent_health_events_opened_at_idx
                ON agent_health_events(opened_at);
            CREATE INDEX IF NOT EXISTS agent_health_events_type_severity_idx
                ON agent_health_events(type, severity);",
        )
        .context("initialize health SQLite schema")
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
    use clap::Parser;
    #[cfg(not(miri))]
    use rusqlite::Connection;
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

    #[test]
    #[cfg_attr(miri, ignore)]
    fn concurrent_appends_keep_json_lines_intact() {
        let path = temp_health_log_path("concurrent");
        let path_arg = path.to_string_lossy().into_owned();
        let config = AgentConfig::parse_from([
            "test",
            "--agent-health-log-file",
            path_arg.as_str(),
            "--agent-health-log-max-bytes",
            "0",
        ]);
        let handles = (0..16).map(|index| {
            let config = config.clone();

            std::thread::spawn(move || {
                append_health_event(
                    &config,
                    "agent.concurrent_append",
                    "info",
                    serde_json::json!({ "index": index }),
                )
                .expect("append health event");
            })
        });

        for handle in handles {
            handle.join().expect("join append thread");
        }

        let contents = fs::read_to_string(&path).expect("read health log");
        let lines = contents.lines().collect::<Vec<_>>();

        assert_eq!(lines.len(), 16);

        for line in lines {
            serde_json::from_str::<serde_json::Value>(line).expect("parse health event line");
        }

        cleanup(&path);
    }

    #[test]
    #[cfg(not(miri))]
    fn sqlite_store_initializes_schema_and_writes_health_events() {
        let path = temp_health_sqlite_path("sqlite");
        let path_arg = path.to_string_lossy().into_owned();
        let config = AgentConfig::parse_from([
            "test",
            "--agent-health-log-store",
            "sqlite",
            "--agent-health-sqlite-file",
            path_arg.as_str(),
        ]);

        let event = append_health_event_with_targets(
            &config,
            "agent.sqlite_append",
            "warning",
            serde_json::json!({ "source": "unit-test" }),
            Some("rec_test".to_string()),
            Some("sched_test".to_string()),
        )
        .expect("append SQLite health event");

        let connection = Connection::open(&path).expect("open SQLite health store");
        let stored: (String, String, String, String, String, String, String) = connection
            .query_row(
                "SELECT node_id, type, severity, opened_at, recording_id, schedule_id, details_json
                 FROM agent_health_events
                 WHERE id = ?1",
                [event.id.as_str()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .expect("read SQLite health event");

        assert_eq!(stored.0, config.node_id);
        assert_eq!(stored.1, "agent.sqlite_append");
        assert_eq!(stored.2, "warning");
        assert_eq!(stored.3, event.opened_at);
        assert_eq!(stored.4, "rec_test");
        assert_eq!(stored.5, "sched_test");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored.6).unwrap(),
            serde_json::json!({ "source": "unit-test" })
        );

        cleanup(&path);
    }

    fn temp_health_log_path(name: &str) -> PathBuf {
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory =
            PathBuf::from("target").join(format!("rakkr-agent-health-log-{name}-{counter}"));

        fs::create_dir_all(&directory).expect("create temp health log directory");

        directory.join("health-events.jsonl")
    }

    #[cfg(not(miri))]
    fn temp_health_sqlite_path(name: &str) -> PathBuf {
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory =
            PathBuf::from("target").join(format!("rakkr-agent-health-log-{name}-{counter}"));

        fs::create_dir_all(&directory).expect("create temp health SQLite directory");

        directory.join("health-events.sqlite3")
    }

    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
}
