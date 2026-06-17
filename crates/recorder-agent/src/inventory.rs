use std::fs;
use std::process::Command;

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

    let interfaces = discover_audio_interfaces();

    NodeInventory {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        alias: config.alias.clone(),
        hostname,
        id: config.node_id.clone(),
        interfaces,
        ip_addresses: collect_ip_addresses(),
        last_seen_at: now_rfc3339(),
        location: NodeLocation {
            room: config.room.clone(),
            site: config.site.clone(),
        },
        status: "online".to_string(),
        tags: vec!["recorder-agent".to_string()],
    }
}

fn discover_audio_interfaces() -> Vec<AudioInterfaceInventory> {
    let mut alsa_interfaces = discover_arecord_interfaces();

    if alsa_interfaces.is_empty() {
        alsa_interfaces = discover_proc_asound_interfaces();
    }

    if alsa_interfaces.is_empty() {
        vec![fallback_interface()]
    } else {
        alsa_interfaces
    }
}

fn discover_arecord_interfaces() -> Vec<AudioInterfaceInventory> {
    let Ok(output) = Command::new("arecord").arg("-l").output() else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    let list_output = String::from_utf8_lossy(&output.stdout);

    parse_alsa_capture_devices(&list_output)
        .into_iter()
        .map(|device| {
            let metadata = read_alsa_stream_metadata(device.card);
            let channel_count = metadata.channel_count.unwrap_or(2);
            let sample_rates = if metadata.sample_rates.is_empty() {
                vec![48_000]
            } else {
                metadata.sample_rates
            };

            AudioInterfaceInventory {
                alias: device.system_name.clone(),
                backend: "alsa".to_string(),
                channel_count,
                channels: channels(channel_count),
                id: format!("alsa_hw_{}_{}", device.card, device.device),
                sample_rates,
                system_name: device.system_name,
            }
        })
        .collect()
}

fn discover_proc_asound_interfaces() -> Vec<AudioInterfaceInventory> {
    fs::read_to_string("/proc/asound/pcm")
        .map(|content| {
            parse_proc_asound_pcm_devices(&content)
                .into_iter()
                .map(|device| {
                    let metadata = read_alsa_stream_metadata(device.card);
                    let channel_count = metadata.channel_count.unwrap_or(2);
                    let sample_rates = if metadata.sample_rates.is_empty() {
                        vec![48_000]
                    } else {
                        metadata.sample_rates
                    };

                    AudioInterfaceInventory {
                        alias: device.system_name.clone(),
                        backend: "alsa".to_string(),
                        channel_count,
                        channels: channels(channel_count),
                        id: format!("alsa_hw_{}_{}", device.card, device.device),
                        sample_rates,
                        system_name: device.system_name,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn collect_ip_addresses() -> Vec<String> {
    let Ok(output) = Command::new("hostname").arg("-I").output() else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn fallback_interface() -> AudioInterfaceInventory {
    AudioInterfaceInventory {
        alias: "Default Capture Interface".to_string(),
        backend: "unknown".to_string(),
        channel_count: 2,
        channels: channels(2),
        id: "iface_default_capture".to_string(),
        sample_rates: vec![48_000],
        system_name: "Audio backend discovery pending".to_string(),
    }
}

fn channels(channel_count: u16) -> Vec<AudioChannelInventory> {
    (1..=channel_count)
        .map(|index| AudioChannelInventory {
            alias: format!("Input {index}"),
            index,
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct AlsaCaptureDevice {
    card: u16,
    device: u16,
    system_name: String,
}

fn parse_alsa_capture_devices(input: &str) -> Vec<AlsaCaptureDevice> {
    input
        .lines()
        .filter_map(parse_alsa_capture_device)
        .collect()
}

fn parse_proc_asound_pcm_devices(input: &str) -> Vec<AlsaCaptureDevice> {
    input
        .lines()
        .filter_map(parse_proc_asound_pcm_device)
        .collect()
}

fn parse_alsa_capture_device(line: &str) -> Option<AlsaCaptureDevice> {
    let after_card = line.trim().strip_prefix("card ")?;
    let (card_text, after_card_number) = after_card.split_once(':')?;
    let card = card_text.trim().parse::<u16>().ok()?;
    let (card_label_text, after_device_marker) = after_card_number.split_once(", device ")?;
    let (device_text, device_label_text) = after_device_marker.split_once(':')?;
    let device = device_text.trim().parse::<u16>().ok()?;
    let card_label = bracket_label(card_label_text).unwrap_or_else(|| card_label_text.trim());
    let device_label = bracket_label(device_label_text).unwrap_or_else(|| device_label_text.trim());
    let system_name = if card_label.eq_ignore_ascii_case(device_label) {
        device_label.to_string()
    } else {
        format!("{card_label} {device_label}")
    };

    Some(AlsaCaptureDevice {
        card,
        device,
        system_name,
    })
}

fn parse_proc_asound_pcm_device(line: &str) -> Option<AlsaCaptureDevice> {
    if !line.contains(": capture") {
        return None;
    }

    let (address, rest) = line.split_once(':')?;
    let (card_text, device_text) = address.trim().split_once('-')?;
    let card = card_text.trim().parse::<u16>().ok()?;
    let device = device_text.trim().parse::<u16>().ok()?;
    let system_name = rest
        .split(':')
        .map(str::trim)
        .find(|part| {
            !part.is_empty() && !part.starts_with("playback") && !part.starts_with("capture")
        })?
        .to_string();

    Some(AlsaCaptureDevice {
        card,
        device,
        system_name,
    })
}

fn bracket_label(value: &str) -> Option<&str> {
    let (_, after_open) = value.split_once('[')?;
    let (label, _) = after_open.split_once(']')?;
    Some(label.trim())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AlsaStreamMetadata {
    channel_count: Option<u16>,
    sample_rates: Vec<u32>,
}

fn read_alsa_stream_metadata(card: u16) -> AlsaStreamMetadata {
    fs::read_to_string(format!("/proc/asound/card{card}/stream0"))
        .map(|content| parse_alsa_stream_metadata(&content))
        .unwrap_or_default()
}

fn parse_alsa_stream_metadata(input: &str) -> AlsaStreamMetadata {
    let mut metadata = AlsaStreamMetadata::default();
    let mut in_capture = false;

    for line in input.lines() {
        let trimmed = line.trim();

        if trimmed == "Capture:" {
            in_capture = true;
            continue;
        }

        if trimmed.ends_with(':') && trimmed != "Capture:" {
            in_capture = false;
        }

        if !in_capture {
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("Channels:") {
            metadata.channel_count = parse_numbers::<u16>(value).into_iter().max();
        } else if let Some(value) = trimmed.strip_prefix("Rates:") {
            metadata.sample_rates = parse_numbers(value);
        }
    }

    metadata.sample_rates.sort_unstable();
    metadata.sample_rates.dedup();
    metadata
}

fn parse_numbers<T>(value: &str) -> Vec<T>
where
    T: std::str::FromStr,
{
    value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<T>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arecord_capture_devices() {
        let devices = parse_alsa_capture_devices(
            r#"
**** List of CAPTURE Hardware Devices ****
card 2: XUSB [X-USB], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
"#,
        );

        assert_eq!(
            devices,
            vec![AlsaCaptureDevice {
                card: 2,
                device: 0,
                system_name: "X-USB USB Audio".to_string(),
            }]
        );
    }

    #[test]
    fn parses_capture_stream_metadata() {
        let metadata = parse_alsa_stream_metadata(
            r#"
Playback:
  Channels: 2
  Rates: 48000
Capture:
  Channels: 32
  Rates: 44100, 48000
"#,
        );

        assert_eq!(
            metadata,
            AlsaStreamMetadata {
                channel_count: Some(32),
                sample_rates: vec![44_100, 48_000],
            }
        );
    }

    #[test]
    fn parses_proc_asound_pcm_capture_devices() {
        let devices = parse_proc_asound_pcm_devices(
            r#"
00-00: ALC256 Analog : ALC256 Analog : playback 1 : capture 1
00-03: HDMI 0 : HDMI 0 : playback 1
01-00: USB Audio : USB Audio : capture 1
"#,
        );

        assert_eq!(
            devices,
            vec![
                AlsaCaptureDevice {
                    card: 0,
                    device: 0,
                    system_name: "ALC256 Analog".to_string(),
                },
                AlsaCaptureDevice {
                    card: 1,
                    device: 0,
                    system_name: "USB Audio".to_string(),
                },
            ]
        );
    }
}
