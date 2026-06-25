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

#[derive(Clone, Copy, Debug)]
pub struct DiskUsage {
    pub free_bytes: u64,
    pub free_percent: f32,
    pub total_bytes: u64,
    pub used_percent: f32,
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

    if let Some(disk_usage) = disk_usage(
        &config.system_health_df_command,
        &config.system_health_disk_path,
    ) {
        let level = pressure_level(
            disk_usage.used_percent,
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
                "usedPercent": round_one(disk_usage.used_percent),
                "warningPercent": config.system_health_disk_warning_percent,
            }),
        );
    }

    if let Some(load_average) = load_average_one_minute(&config.system_health_loadavg_path) {
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

    push_audio_backend_health_event(config, inventory, state, &mut events);

    events
}

fn push_audio_backend_health_event(
    config: &AgentConfig,
    inventory: &NodeInventory,
    state: &mut SystemHealthState,
    events: &mut Vec<SystemHealthEvent>,
) {
    let available_audio_interfaces = available_audio_interface_count(inventory);
    let audio_level = if available_audio_interfaces > 0 {
        SystemHealthLevel::Healthy
    } else {
        SystemHealthLevel::Warning
    };

    maybe_push_transition(
        events,
        &mut state.audio_backend,
        audio_level,
        "agent.audio_backend.unavailable",
        "agent.audio_backend.recovered",
        json!({
            "audioBackends": inventory.runtime.audio_backends.clone(),
            "availableInterfaces": available_audio_interfaces,
            "backendCount": inventory.runtime.audio_backends.len(),
            "interfaces": inventory.interfaces.len(),
            "nodeId": config.node_id,
        }),
    );
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

pub fn disk_usage(command: &str, path: &Path) -> Option<DiskUsage> {
    let output = Command::new(command).arg("-Pk").arg(path).output().ok()?;

    if !output.status.success() {
        return None;
    }

    parse_df_disk_usage(&String::from_utf8_lossy(&output.stdout))
}

fn parse_df_disk_usage(input: &str) -> Option<DiskUsage> {
    input.lines().skip(1).find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let total_blocks = fields.get(1)?.parse::<u64>().ok()?;
        let available_blocks = fields.get(3)?.parse::<u64>().ok()?;
        let used_percent = fields.get(4)?.trim_end_matches('%').parse::<f32>().ok()?;
        let total_bytes = total_blocks.saturating_mul(1024);
        let free_bytes = available_blocks.saturating_mul(1024);
        let free_percent = if total_bytes == 0 {
            0.0
        } else {
            (free_bytes as f32 / total_bytes as f32) * 100.0
        };

        Some(DiskUsage {
            free_bytes,
            free_percent,
            total_bytes,
            used_percent,
        })
    })
}

fn load_average_one_minute(path: &Path) -> Option<f32> {
    let content = fs::read_to_string(path).ok()?;

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

fn available_audio_interface_count(inventory: &NodeInventory) -> usize {
    inventory
        .interfaces
        .iter()
        .filter(|audio_interface| {
            audio_interface.backend != "unknown" && audio_interface.channel_count > 0
        })
        .count()
}

fn round_one(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    use crate::inventory::{
        AudioChannelInventory, AudioInterfaceInventory, NodeLocation, NodeRuntime,
    };

    #[test]
    fn parses_df_disk_usage() {
        let output = r#"
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1         10000000 8750000   1250000      88% /
"#;
        let disk_usage = parse_df_disk_usage(output).unwrap();

        assert_eq!(disk_usage.used_percent, 88.0);
        assert_eq!(disk_usage.free_bytes, 1_280_000_000);
        assert_eq!(disk_usage.total_bytes, 10_240_000_000);
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

    #[test]
    fn audio_backend_health_reports_unavailable_once_and_recovery() {
        let mut config = AgentConfig::try_parse_from(["rakkr-recorder-agent"]).unwrap();
        config.system_health_enabled = true;
        config.system_health_disk_warning_percent = 101.0;
        config.system_health_disk_critical_percent = 102.0;
        config.system_health_load_warning_per_core = 1_000.0;
        config.system_health_load_critical_per_core = 2_000.0;
        config.system_health_loadavg_path = Path::new("/missing-loadavg").to_path_buf();
        let mut state = SystemHealthState::default();

        let mut unavailable = Vec::new();
        push_audio_backend_health_event(
            &config,
            &inventory(vec![audio_interface("unknown", 0)], vec![]),
            &mut state,
            &mut unavailable,
        );
        let mut unchanged = Vec::new();
        push_audio_backend_health_event(
            &config,
            &inventory(vec![audio_interface("unknown", 0)], vec![]),
            &mut state,
            &mut unchanged,
        );
        let mut recovered = Vec::new();
        push_audio_backend_health_event(
            &config,
            &inventory(vec![audio_interface("alsa", 2)], vec!["alsa"]),
            &mut state,
            &mut recovered,
        );

        let unavailable_event = unavailable
            .iter()
            .find(|event| event.event_type == "agent.audio_backend.unavailable")
            .unwrap();
        assert_eq!(unavailable_event.severity, "warning");
        assert_eq!(unavailable_event.details["backendCount"], 0);
        assert_eq!(unavailable_event.details["availableInterfaces"], 0);
        assert_eq!(unavailable_event.details["interfaces"], 1);
        assert!(
            !unchanged
                .iter()
                .any(|event| event.event_type == "agent.audio_backend.unavailable")
        );

        let recovered_event = recovered
            .iter()
            .find(|event| event.event_type == "agent.audio_backend.recovered")
            .unwrap();
        assert_eq!(recovered_event.severity, "info");
        assert_eq!(recovered_event.details["backendCount"], 1);
        assert_eq!(recovered_event.details["availableInterfaces"], 1);
        assert_eq!(recovered_event.details["audioBackends"][0], "alsa");
    }

    fn inventory(
        interfaces: Vec<AudioInterfaceInventory>,
        audio_backends: Vec<&str>,
    ) -> NodeInventory {
        NodeInventory {
            agent_version: "test".to_string(),
            alias: "test node".to_string(),
            hostname: "test-host".to_string(),
            id: "node_local_dev".to_string(),
            interfaces,
            ip_addresses: Vec::new(),
            last_seen_at: "2026-06-25T00:00:00Z".to_string(),
            location: NodeLocation {
                room: "room".to_string(),
                site: "site".to_string(),
            },
            runtime: NodeRuntime {
                architecture: "test-arch".to_string(),
                audio_backends: audio_backends.into_iter().map(str::to_string).collect(),
                kernel_release: None,
                os_name: None,
                uptime_seconds: None,
            },
            status: "online".to_string(),
            tags: Vec::new(),
        }
    }

    fn audio_interface(backend: &str, channel_count: u16) -> AudioInterfaceInventory {
        AudioInterfaceInventory {
            alias: format!("{backend} input"),
            backend: backend.to_string(),
            channel_count,
            channels: (0..channel_count)
                .map(|index| AudioChannelInventory {
                    alias: format!("ch {}", index + 1),
                    index: index + 1,
                })
                .collect(),
            hardware_path: None,
            id: format!("{backend}_{channel_count}"),
            sample_rates: vec![48_000],
            serial_number: None,
            system_name: backend.to_string(),
            system_ref: None,
        }
    }
}
