use serde::Serialize;

use crate::config::AgentConfig;
use crate::telemetry::now_rfc3339;

#[derive(Debug, Serialize)]
pub struct NodeInventory {
    pub agent_version: String,
    pub alias: String,
    pub hostname: String,
    pub id: String,
    pub interfaces: Vec<AudioInterfaceInventory>,
    pub ip_addresses: Vec<String>,
    pub last_seen_at: String,
    pub location: NodeLocation,
    pub status: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct NodeLocation {
    pub room: String,
    pub site: String,
}

#[derive(Debug, Serialize)]
pub struct AudioInterfaceInventory {
    pub alias: String,
    pub backend: String,
    pub channel_count: u16,
    pub channels: Vec<AudioChannelInventory>,
    pub id: String,
    pub sample_rates: Vec<u32>,
    pub system_name: String,
}

#[derive(Debug, Serialize)]
pub struct AudioChannelInventory {
    pub alias: String,
    pub index: u16,
}

pub fn collect(config: &AgentConfig) -> NodeInventory {
    let hostname = hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "unknown-host".to_string());

    NodeInventory {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        alias: config.alias.clone(),
        hostname,
        id: config.node_id.clone(),
        interfaces: vec![AudioInterfaceInventory {
            alias: "Default Capture Interface".to_string(),
            backend: "unknown".to_string(),
            channel_count: 2,
            channels: vec![
                AudioChannelInventory {
                    alias: "Input 1".to_string(),
                    index: 1,
                },
                AudioChannelInventory {
                    alias: "Input 2".to_string(),
                    index: 2,
                },
            ],
            id: "iface_default_capture".to_string(),
            sample_rates: vec![48_000],
            system_name: "Audio backend discovery pending".to_string(),
        }],
        ip_addresses: Vec::new(),
        last_seen_at: now_rfc3339(),
        location: NodeLocation {
            room: config.room.clone(),
            site: config.site.clone(),
        },
        status: "online".to_string(),
        tags: vec!["recorder-agent".to_string()],
    }
}
