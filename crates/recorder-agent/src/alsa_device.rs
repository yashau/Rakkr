use crate::inventory::NodeInventory;

pub fn capture_device_interface_id(value: &str, inventory: &NodeInventory) -> Option<String> {
    let after_prefix = value.strip_prefix("hw:")?;
    let mut parts = after_prefix.split(',');
    let card = parts.next()?;
    let device = parts.next()?.parse::<u16>().ok()?;

    if let Ok(card) = card.parse::<u16>() {
        return Some(format!("alsa_hw_{card}_{device}"));
    }

    let card = normalize_alsa_token(card);
    if card.is_empty() {
        return None;
    }

    inventory
        .interfaces
        .iter()
        .find(|audio_interface| {
            audio_interface.backend == "alsa"
                && audio_interface
                    .system_ref
                    .as_deref()
                    .is_some_and(|system_ref| alsa_system_ref_device(system_ref) == Some(device))
                && normalize_alsa_token(&audio_interface.system_name).contains(&card)
        })
        .map(|audio_interface| audio_interface.id.clone())
}

fn alsa_system_ref_device(value: &str) -> Option<u16> {
    let after_prefix = value.strip_prefix("hw:")?;
    let mut parts = after_prefix.split(',');
    let _card = parts.next()?;

    parts.next()?.parse::<u16>().ok()
}

fn normalize_alsa_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::{AudioInterfaceInventory, NodeInventory, NodeLocation, NodeRuntime};

    #[test]
    fn maps_numeric_alsa_capture_device_to_inventory_id() {
        let inventory = inventory_with_interfaces(Vec::new());

        assert_eq!(
            capture_device_interface_id("hw:1,1,0", &inventory).as_deref(),
            Some("alsa_hw_1_1")
        );
    }

    #[test]
    fn maps_named_alsa_capture_device_to_inventory_id() {
        let inventory = inventory_with_interfaces(vec![AudioInterfaceInventory {
            alias: "Loopback PCM".to_string(),
            backend: "alsa".to_string(),
            channel_count: 2,
            channels: Vec::new(),
            hardware_path: None,
            id: "alsa_hw_2_1".to_string(),
            sample_rates: vec![48_000],
            serial_number: None,
            system_name: "Loopback Loopback PCM".to_string(),
            system_ref: Some("hw:2,1".to_string()),
        }]);

        assert_eq!(
            capture_device_interface_id("hw:Loopback,1,0", &inventory).as_deref(),
            Some("alsa_hw_2_1")
        );
    }

    #[test]
    fn ignores_unknown_named_alsa_capture_device() {
        let inventory = inventory_with_interfaces(Vec::new());

        assert_eq!(
            capture_device_interface_id("hw:Missing,1,0", &inventory),
            None
        );
    }

    fn inventory_with_interfaces(interfaces: Vec<AudioInterfaceInventory>) -> NodeInventory {
        NodeInventory {
            agent_version: "test".to_string(),
            alias: "Node".to_string(),
            hostname: "node.local".to_string(),
            id: "node_1".to_string(),
            interfaces,
            ip_addresses: Vec::new(),
            last_seen_at: "2026-06-20T00:00:00Z".to_string(),
            location: NodeLocation {
                room: "Room".to_string(),
                site: "Site".to_string(),
            },
            runtime: NodeRuntime {
                architecture: "x86_64".to_string(),
                audio_backends: vec!["alsa".to_string()],
                kernel_release: None,
                os_name: None,
                uptime_seconds: None,
            },
            status: "online".to_string(),
            tags: Vec::new(),
        }
    }
}
