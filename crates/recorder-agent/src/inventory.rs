use serde::Serialize;

use crate::config::AgentConfig;
use crate::telemetry::now_rfc3339;

mod alsa;
mod net;
mod runtime;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInventory {
    pub agent_version: String,
    pub alias: String,
    pub hostname: String,
    pub id: String,
    pub interfaces: Vec<AudioInterfaceInventory>,
    pub ip_addresses: Vec<String>,
    pub last_seen_at: String,
    pub location: NodeLocation,
    pub runtime: NodeRuntime,
    pub status: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLocation {
    pub room: String,
    pub site: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntime {
    pub architecture: String,
    pub audio_backends: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInterfaceInventory {
    pub alias: String,
    pub backend: String,
    pub channel_count: u16,
    pub channels: Vec<AudioChannelInventory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hardware_path: Option<String>,
    pub id: String,
    pub sample_rates: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    pub system_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChannelInventory {
    pub alias: String,
    pub index: u16,
}

pub fn collect(config: &AgentConfig) -> NodeInventory {
    let hostname = hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "unknown-host".to_string());

    let interfaces = alsa::discover_audio_interfaces(config);
    let runtime = runtime::runtime_details(&interfaces);

    NodeInventory {
        agent_version: crate::version::AGENT_VERSION.to_string(),
        alias: config.alias.clone(),
        hostname,
        id: config.node_id.clone(),
        interfaces,
        ip_addresses: net::collect_ip_addresses(),
        last_seen_at: now_rfc3339(),
        location: NodeLocation {
            room: config.room.clone(),
            site: config.site.clone(),
        },
        runtime,
        status: "online".to_string(),
        tags: vec!["recorder-agent".to_string()],
    }
}

pub fn heartbeat_snapshot(inventory: &NodeInventory) -> NodeInventory {
    let mut snapshot = inventory.clone();

    snapshot.last_seen_at = now_rfc3339();
    snapshot.runtime = runtime::runtime_details(&snapshot.interfaces);

    snapshot
}

pub fn heartbeat_health_details(
    heartbeat: &NodeInventory,
    error: Option<String>,
) -> serde_json::Value {
    serde_json::json!({
        "alias": heartbeat.alias.as_str(),
        "audioBackends": heartbeat.runtime.audio_backends.clone(),
        "error": error,
        "hostname": heartbeat.hostname.as_str(),
        "interfaceCount": heartbeat.interfaces.len(),
        "lastSeenAt": heartbeat.last_seen_at.as_str(),
        "nodeId": heartbeat.id.as_str(),
        "status": heartbeat.status.as_str(),
    })
}
