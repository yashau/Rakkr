use std::fs;
use std::path::Path;
use std::process::Command;
use std::thread;

use serde_json::{Value, json};

use crate::config::AgentConfig;
use crate::inventory::NodeInventory;

#[derive(Default)]
pub struct SystemHealthState {
    audio_backend: Option<SystemHealthLevel>,
    disk: Option<SystemHealthLevel>,
    load: Option<SystemHealthLevel>,
}

pub struct SystemHealthEvent {
    pub details: Value,
    pub event_type: &'static str,
    pub severity: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SystemHealthLevel {
    Healthy,
    Warning,
    Critical,
}

impl SystemHealthLevel {
    fn severity(self) -> &'static str {
        match self {
            Self::Healthy => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }
}

pub fn collect_system_health_events(
    config: &AgentConfig,
    inventory: &NodeInventory,
    state: &mut SystemHealthState,
) -> Vec<SystemHealthEvent> {
    if !config.system_health_enabled {
        return Vec::new();
    }

    let mut events = Vec::new();

    if let Some(disk_used_percent) = disk_used_percent(&config.system_health_disk_path) {
        let level = pressure_level(
            disk_used_percent,
            config.system_health_disk_warning_percent,
            config.system_health_disk_critical_percent,
        );

        maybe_push_transition(
            &mut events,
            &mut state.disk,
            level,
            "agent.system.disk_pressure",
            "agent.system.disk_recovered",
            json!({
                "criticalPercent": config.system_health_disk_critical_percent,
                "nodeId": config.node_id,
                "path": config.system_health_disk_path.display().to_string(),
                "usedPercent": round_one(disk_used_percent),
                "warningPercent": config.system_health_disk_warning_percent,
            }),
        );
    }

    if let Some(load_average) = load_average_one_minute() {
        let cores = available_cores();
        let load_per_core = load_average / cores;
        let level = pressure_level(
            load_per_core,
            config.system_health_load_warning_per_core,
            config.system_health_load_critical_per_core,
        );

        maybe_push_transition(
            &mut events,
            &mut state.load,
            level,
            "agent.system.cpu_pressure",
            "agent.system.cpu_recovered",
            json!({
                "cores": round_one(cores),
                "criticalLoadPerCore": config.system_health_load_critical_per_core,
                "loadAverageOneMinute": round_one(load_average),
                "loadPerCore": round_one(load_per_core),
                "nodeId": config.node_id,
                "warningLoadPerCore": config.system_health_load_warning_per_core,
            }),
        );
    }

    let audio_level = if has_audio_backend(inventory) {
        SystemHealthLevel::Healthy
    } else {
        SystemHealthLevel::Warning
    };

    maybe_push_transition(
        &mut events,
        &mut state.audio_backend,
        audio_level,
        "agent.audio_backend.unavailable",
        "agent.audio_backend.recovered",
        json!({
            "interfaces": inventory.interfaces.len(),
            "nodeId": config.node_id,
        }),
    );

    events
}

fn maybe_push_transition(
    events: &mut Vec<SystemHealthEvent>,
    previous: &mut Option<SystemHealthLevel>,
    next: SystemHealthLevel,
    problem_type: &'static str,
    recovery_type: &'static str,
    details: Value,
) {
    if previous.is_some_and(|level| level == next) {
        return;
    }

    let should_emit = next != SystemHealthLevel::Healthy
        || previous.is_some_and(|level| level != SystemHealthLevel::Healthy);

    *previous = Some(next);

    if !should_emit {
        return;
    }

    events.push(SystemHealthEvent {
        details,
        event_type: if next == SystemHealthLevel::Healthy {
            recovery_type
        } else {
            problem_type
        },
        severity: next.severity(),
    });
}

fn pressure_level(
    value: f32,
    warning_threshold: f32,
    critical_threshold: f32,
) -> SystemHealthLevel {
    let warning = warning_threshold.min(critical_threshold);
    let critical = warning_threshold.max(critical_threshold);

    if value >= critical {
        SystemHealthLevel::Critical
    } else if value >= warning {
        SystemHealthLevel::Warning
    } else {
        SystemHealthLevel::Healthy
    }
}

fn disk_used_percent(path: &Path) -> Option<f32> {
    let output = Command::new("df").arg("-Pk").arg(path).output().ok()?;

    if !output.status.success() {
        return None;
    }

    parse_df_used_percent(&String::from_utf8_lossy(&output.stdout))
}

fn parse_df_used_percent(input: &str) -> Option<f32> {
    input.lines().skip(1).find_map(|line| {
        let usage = line.split_whitespace().nth(4)?;
        usage.trim_end_matches('%').parse::<f32>().ok()
    })
}

fn load_average_one_minute() -> Option<f32> {
    let content = fs::read_to_string("/proc/loadavg").ok()?;

    parse_load_average_one_minute(&content)
}

fn parse_load_average_one_minute(input: &str) -> Option<f32> {
    input.split_whitespace().next()?.parse::<f32>().ok()
}

fn available_cores() -> f32 {
    thread::available_parallelism()
        .map(|value| value.get() as f32)
        .unwrap_or(1.0)
        .max(1.0)
}

fn has_audio_backend(inventory: &NodeInventory) -> bool {
    inventory.interfaces.iter().any(|audio_interface| {
        audio_interface.backend != "unknown" && audio_interface.channel_count > 0
    })
}

fn round_one(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_df_used_percent() {
        let output = r#"
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1         10000000 8750000   1250000      88% /
"#;

        assert_eq!(parse_df_used_percent(output), Some(88.0));
    }

    #[test]
    fn parses_load_average() {
        assert_eq!(
            parse_load_average_one_minute("1.23 0.42 0.10 1/200 1234"),
            Some(1.23)
        );
    }

    #[test]
    fn pressure_level_prefers_critical() {
        assert_eq!(
            pressure_level(96.0, 85.0, 95.0),
            SystemHealthLevel::Critical
        );
    }

    #[test]
    fn transition_emits_problem_once_and_recovery_once() {
        let mut events = Vec::new();
        let mut previous = None;

        maybe_push_transition(
            &mut events,
            &mut previous,
            SystemHealthLevel::Warning,
            "problem",
            "recovered",
            json!({}),
        );
        maybe_push_transition(
            &mut events,
            &mut previous,
            SystemHealthLevel::Warning,
            "problem",
            "recovered",
            json!({}),
        );
        maybe_push_transition(
            &mut events,
            &mut previous,
            SystemHealthLevel::Healthy,
            "problem",
            "recovered",
            json!({}),
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "problem");
        assert_eq!(events[1].event_type, "recovered");
    }
}
