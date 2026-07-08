use std::process::Command;

// The controller caps a heartbeat's `ipAddresses` at 16 (nodeHeartbeatSchema)
// and truncates an over-cap list rather than reject it. A well-behaved agent
// should never emit more than the cap in the first place, so bound the list
// here too (a multi-homed host — IPv6 SLAAC/privacy + Docker/libvirt/VLAN
// bridges — can exceed 16). See audit R7-IP-AGENT-CAP / R7-IPCAP.
const MAX_IP_ADDRESSES: usize = 16;

pub(crate) fn collect_ip_addresses() -> Vec<String> {
    let Ok(output) = Command::new("hostname").arg("-I").output() else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    parse_ip_addresses(&String::from_utf8_lossy(&output.stdout))
}

// Pure parser for `hostname -I` output: whitespace-split, bounded to the
// documented cap so the agent never sends a payload the controller would have
// to truncate.
fn parse_ip_addresses(stdout: &str) -> Vec<String> {
    stdout
        .split_whitespace()
        .take(MAX_IP_ADDRESSES)
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ip_addresses_and_caps_at_the_documented_limit() {
        // A normal multi-address host parses to a trimmed list.
        assert_eq!(
            parse_ip_addresses("192.168.1.10 10.0.0.5 \n"),
            vec!["192.168.1.10".to_string(), "10.0.0.5".to_string()],
        );

        // A host with more than the cap (e.g. IPv6 SLAAC/privacy + bridges) is
        // bounded to MAX_IP_ADDRESSES so the controller never has to truncate.
        let many = (0..40)
            .map(|n| format!("10.0.0.{n}"))
            .collect::<Vec<_>>()
            .join(" ");
        let parsed = parse_ip_addresses(&many);

        assert_eq!(parsed.len(), MAX_IP_ADDRESSES);
        assert_eq!(parsed.first().map(String::as_str), Some("10.0.0.0"));
        assert_eq!(parsed.last().map(String::as_str), Some("10.0.0.15"));

        // Empty output yields no addresses.
        assert!(parse_ip_addresses("   \n").is_empty());
    }
}
