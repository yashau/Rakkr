use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

use serde::Serialize;

use crate::config::AgentConfig;
use crate::telemetry::now_rfc3339;

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

    let interfaces = discover_audio_interfaces(config);
    let runtime = runtime_details(&interfaces);

    NodeInventory {
        agent_version: crate::version::AGENT_VERSION.to_string(),
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
        runtime,
        status: "online".to_string(),
        tags: vec!["recorder-agent".to_string()],
    }
}

pub fn heartbeat_snapshot(inventory: &NodeInventory) -> NodeInventory {
    let mut snapshot = inventory.clone();

    snapshot.last_seen_at = now_rfc3339();
    snapshot.runtime = runtime_details(&snapshot.interfaces);

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

fn discover_audio_interfaces(config: &AgentConfig) -> Vec<AudioInterfaceInventory> {
    let mut alsa_interfaces = discover_arecord_interfaces(&config.inventory_arecord_command);

    if alsa_interfaces.is_empty() {
        alsa_interfaces = discover_proc_asound_interfaces(
            &config.inventory_proc_asound_pcm_path,
            &config.inventory_arecord_command,
        );
    }

    if alsa_interfaces.is_empty() {
        vec![fallback_interface()]
    } else {
        alsa_interfaces
    }
}

fn discover_arecord_interfaces(arecord_command: &str) -> Vec<AudioInterfaceInventory> {
    let Ok(output) = Command::new(arecord_command).arg("-l").output() else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    let list_output = String::from_utf8_lossy(&output.stdout);

    parse_alsa_capture_devices(&list_output)
        .into_iter()
        .map(|device| {
            let metadata = read_alsa_metadata(device.card, device.device, arecord_command);
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
                hardware_path: Some(alsa_hardware_path(device.card, device.device)),
                sample_rates,
                serial_number: alsa_serial_number(device.card),
                id: alsa_interface_id(&device),
                system_name: device.system_name,
                system_ref: Some(device.system_ref),
            }
        })
        .collect()
}

fn discover_proc_asound_interfaces(
    path: &Path,
    arecord_command: &str,
) -> Vec<AudioInterfaceInventory> {
    fs::read_to_string(path)
        .map(|content| {
            parse_proc_asound_pcm_devices(&content)
                .into_iter()
                .map(|device| {
                    let metadata = read_alsa_metadata(device.card, device.device, arecord_command);
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
                        hardware_path: Some(alsa_hardware_path(device.card, device.device)),
                        id: format!("alsa_hw_{}_{}", device.card, device.device),
                        sample_rates,
                        serial_number: alsa_serial_number(device.card),
                        system_name: device.system_name,
                        system_ref: Some(device.system_ref),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

// The controller caps a heartbeat's `ipAddresses` at 16 (nodeHeartbeatSchema)
// and truncates an over-cap list rather than reject it. A well-behaved agent
// should never emit more than the cap in the first place, so bound the list
// here too (a multi-homed host — IPv6 SLAAC/privacy + Docker/libvirt/VLAN
// bridges — can exceed 16). See audit R7-IP-AGENT-CAP / R7-IPCAP.
const MAX_IP_ADDRESSES: usize = 16;

fn collect_ip_addresses() -> Vec<String> {
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

fn fallback_interface() -> AudioInterfaceInventory {
    AudioInterfaceInventory {
        alias: "Default Capture Interface".to_string(),
        backend: "unknown".to_string(),
        channel_count: 2,
        channels: channels(2),
        hardware_path: None,
        id: "iface_default_capture".to_string(),
        sample_rates: vec![48_000],
        serial_number: None,
        system_name: "Audio backend discovery pending".to_string(),
        system_ref: None,
    }
}

fn alsa_hardware_path(card: u16, device: u16) -> String {
    canonical_path(format!("/sys/class/sound/card{card}/pcmC{card}D{device}c"))
        .or_else(|| canonical_path(format!("/sys/class/sound/card{card}/device")))
        .unwrap_or_else(|| PathBuf::from(format!("/proc/asound/card{card}/pcm{device}c")))
        .to_string_lossy()
        .to_string()
}

fn alsa_interface_id(device: &AlsaCaptureDevice) -> String {
    let Some(card_id) = alsa_card_id(&device.system_ref) else {
        return format!("alsa_hw_{}_{}", device.card, device.device);
    };
    let normalized = normalize_inventory_id_token(&card_id);

    if normalized.is_empty() {
        format!("alsa_hw_{}_{}", device.card, device.device)
    } else {
        format!("alsa_card_{normalized}_dev_{}", device.device)
    }
}

fn alsa_card_id(system_ref: &str) -> Option<String> {
    system_ref
        .strip_prefix("hw:")?
        .split(',')
        .find_map(|part| part.trim().strip_prefix("CARD=").map(str::to_string))
}

fn normalize_inventory_id_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn alsa_serial_number(card: u16) -> Option<String> {
    let device_path = canonical_path(format!("/sys/class/sound/card{card}/device"))?;

    sysfs_serial_number(&device_path)
}

fn sysfs_serial_number(path: &Path) -> Option<String> {
    path.ancestors().find_map(|candidate| {
        read_trimmed(candidate.join("serial"))
            .or_else(|| serial_from_uevent(&read_trimmed(candidate.join("uevent"))?))
    })
}

fn canonical_path(path: impl AsRef<Path>) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    let value = fs::read_to_string(path).ok()?.trim().to_string();

    if value.is_empty() { None } else { Some(value) }
}

fn serial_from_uevent(value: &str) -> Option<String> {
    value.lines().find_map(|line| {
        let serial = line.strip_prefix("SERIAL=")?.trim();

        if serial.is_empty() {
            None
        } else {
            Some(serial.to_string())
        }
    })
}

fn runtime_details(interfaces: &[AudioInterfaceInventory]) -> NodeRuntime {
    NodeRuntime {
        architecture: std::env::consts::ARCH.to_string(),
        audio_backends: runtime_audio_backends(interfaces, command_available),
        kernel_release: command_stdout("uname", &["-r"]),
        os_name: linux_pretty_name().or_else(|| command_stdout("uname", &["-s"])),
        uptime_seconds: linux_uptime_seconds(),
    }
}

fn runtime_audio_backends(
    interfaces: &[AudioInterfaceInventory],
    mut is_command_available: impl FnMut(&str) -> bool,
) -> Vec<String> {
    let mut audio_backends = interfaces
        .iter()
        .map(|audio_interface| audio_interface.backend.clone())
        .collect::<Vec<_>>();

    if is_command_available("pw-cli") || is_command_available("pipewire") {
        audio_backends.push("pipewire".to_string());
    }

    if is_command_available("jackd") || is_command_available("jack_control") {
        audio_backends.push("jack".to_string());
    }

    if audio_backends.iter().any(|backend| backend != "unknown") {
        audio_backends.retain(|backend| backend != "unknown");
    }

    audio_backends.sort();
    audio_backends.dedup();
    audio_backends
}

fn command_available(command: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };
    let extensions = command_extensions();

    env::split_paths(&paths).any(|path| {
        extensions
            .iter()
            .map(|extension| path.join(format!("{command}{extension}")))
            .any(|candidate| candidate.is_file())
    })
}

fn command_extensions() -> Vec<String> {
    if cfg!(windows) {
        env::var_os("PATHEXT")
            .map(|value| {
                let mut extensions = vec!["".to_string()];
                extensions.extend(
                    value
                        .to_string_lossy()
                        .split(';')
                        .map(str::trim)
                        .filter(|extension| !extension.is_empty())
                        .map(str::to_string),
                );

                extensions
            })
            .filter(|extensions| extensions.len() > 1)
            .unwrap_or_else(|| {
                vec![
                    "".to_string(),
                    ".exe".to_string(),
                    ".cmd".to_string(),
                    ".bat".to_string(),
                ]
            })
    } else {
        vec!["".to_string()]
    }
}

fn command_stdout(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if value.is_empty() { None } else { Some(value) }
}

fn linux_pretty_name() -> Option<String> {
    let content = fs::read_to_string("/etc/os-release").ok()?;

    content.lines().find_map(|line| {
        let value = line.strip_prefix("PRETTY_NAME=")?;

        Some(value.trim_matches('"').to_string())
    })
}

fn linux_uptime_seconds() -> Option<u64> {
    let content = fs::read_to_string("/proc/uptime").ok()?;
    let first = content.split_whitespace().next()?;
    let seconds = first.split('.').next()?.parse::<u64>().ok()?;

    Some(seconds)
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
    system_ref: String,
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
    let card_id = card_label_text.split_whitespace().next()?;
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
        system_ref: format!("hw:CARD={card_id},DEV={device}"),
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
        system_ref: format!("hw:{card},{device}"),
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

fn read_alsa_metadata(card: u16, device: u16, arecord_command: &str) -> AlsaStreamMetadata {
    let metadata = read_alsa_stream_metadata(card);

    if metadata.is_complete() {
        metadata
    } else {
        metadata.with_fallback(read_alsa_hw_params_metadata(card, device, arecord_command))
    }
}

fn read_alsa_hw_params_metadata(
    card: u16,
    device: u16,
    arecord_command: &str,
) -> AlsaStreamMetadata {
    let Ok(output) = Command::new(arecord_command)
        .arg("-D")
        .arg(format!("hw:{card},{device}"))
        .arg("--dump-hw-params")
        .arg("-f")
        .arg("S16_LE")
        .arg("-r")
        .arg("48000")
        .arg("-c")
        .arg("2")
        .arg("-d")
        .arg("1")
        .arg("/dev/null")
        .output()
    else {
        return AlsaStreamMetadata::default();
    };

    if !output.status.success() {
        return AlsaStreamMetadata::default();
    }

    let mut content = String::from_utf8_lossy(&output.stdout).to_string();
    content.push_str(&String::from_utf8_lossy(&output.stderr));

    parse_alsa_hw_params_metadata(&content)
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

fn parse_alsa_hw_params_metadata(input: &str) -> AlsaStreamMetadata {
    let mut metadata = AlsaStreamMetadata::default();

    for line in input.lines() {
        let trimmed = line.trim();

        if let Some(value) = trimmed.strip_prefix("CHANNELS:") {
            metadata.channel_count = parse_numbers::<u16>(value).into_iter().max();
        } else if let Some(value) = trimmed.strip_prefix("RATE:") {
            metadata.sample_rates = parse_numbers(value);
        }
    }

    metadata.sample_rates.sort_unstable();
    metadata.sample_rates.dedup();
    metadata
}

impl AlsaStreamMetadata {
    fn is_complete(&self) -> bool {
        self.channel_count.is_some() && !self.sample_rates.is_empty()
    }

    fn with_fallback(mut self, fallback: Self) -> Self {
        if self.channel_count.is_none() {
            self.channel_count = fallback.channel_count;
        }

        if self.sample_rates.is_empty() {
            self.sample_rates = fallback.sample_rates;
        }

        self
    }
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
                system_ref: "hw:CARD=XUSB,DEV=0".to_string(),
                system_name: "X-USB USB Audio".to_string(),
            }]
        );
    }

    #[test]
    fn stable_alsa_interface_id_uses_card_name_when_available() {
        let device = AlsaCaptureDevice {
            card: 7,
            device: 0,
            system_ref: "hw:CARD=SMOKE,DEV=0".to_string(),
            system_name: "Smoke Audio Capture".to_string(),
        };

        assert_eq!(alsa_interface_id(&device), "alsa_card_smoke_dev_0");
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
    fn parses_arecord_hw_params_metadata() {
        let metadata = parse_alsa_hw_params_metadata(
            r#"
HW Params of device "hw:1,0":
--------------------
ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED
FORMAT:  S16_LE S24_LE S32_LE
CHANNELS: [1 32]
RATE: [44100 96000]
PERIOD_SIZE: [32 8192]
"#,
        );

        assert_eq!(
            metadata,
            AlsaStreamMetadata {
                channel_count: Some(32),
                sample_rates: vec![44_100, 96_000],
            }
        );
    }

    #[test]
    fn keeps_proc_stream_metadata_before_hw_params_fallback() {
        let metadata = AlsaStreamMetadata {
            channel_count: Some(32),
            sample_rates: vec![48_000],
        }
        .with_fallback(AlsaStreamMetadata {
            channel_count: Some(2),
            sample_rates: vec![44_100],
        });

        assert_eq!(
            metadata,
            AlsaStreamMetadata {
                channel_count: Some(32),
                sample_rates: vec![48_000],
            }
        );
    }

    #[test]
    fn fills_missing_stream_metadata_from_hw_params_fallback() {
        let metadata = AlsaStreamMetadata {
            channel_count: None,
            sample_rates: Vec::new(),
        }
        .with_fallback(AlsaStreamMetadata {
            channel_count: Some(8),
            sample_rates: vec![44_100, 48_000],
        });

        assert_eq!(
            metadata,
            AlsaStreamMetadata {
                channel_count: Some(8),
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
                    system_ref: "hw:0,0".to_string(),
                    system_name: "ALC256 Analog".to_string(),
                },
                AlsaCaptureDevice {
                    card: 1,
                    device: 0,
                    system_ref: "hw:1,0".to_string(),
                    system_name: "USB Audio".to_string(),
                },
            ]
        );
    }

    #[test]
    fn runtime_audio_backends_include_available_pipewire_and_jack() {
        let interfaces = vec![AudioInterfaceInventory {
            alias: "USB".to_string(),
            backend: "alsa".to_string(),
            channel_count: 2,
            channels: Vec::new(),
            hardware_path: None,
            id: "alsa_hw_1_0".to_string(),
            sample_rates: vec![48_000],
            serial_number: None,
            system_name: "USB Audio".to_string(),
            system_ref: Some("hw:1,0".to_string()),
        }];

        assert_eq!(
            runtime_audio_backends(&interfaces, |command| matches!(command, "pw-cli" | "jackd")),
            vec!["alsa", "jack", "pipewire"]
        );
    }

    #[test]
    fn runtime_audio_backends_keep_unknown_fallback() {
        assert_eq!(
            runtime_audio_backends(&[fallback_interface()], |_| false),
            vec!["unknown"]
        );
    }

    #[test]
    fn runtime_audio_backends_drop_unknown_when_real_backend_available() {
        assert_eq!(
            runtime_audio_backends(&[fallback_interface()], |command| command == "pipewire"),
            vec!["pipewire"]
        );
    }

    #[test]
    fn runtime_audio_backends_dedupe_and_sort() {
        let interfaces = vec![
            AudioInterfaceInventory {
                alias: "A".to_string(),
                backend: "alsa".to_string(),
                channel_count: 2,
                channels: Vec::new(),
                hardware_path: None,
                id: "a".to_string(),
                sample_rates: vec![48_000],
                serial_number: None,
                system_name: "A".to_string(),
                system_ref: Some("hw:1,0".to_string()),
            },
            AudioInterfaceInventory {
                alias: "B".to_string(),
                backend: "alsa".to_string(),
                channel_count: 2,
                channels: Vec::new(),
                hardware_path: None,
                id: "b".to_string(),
                sample_rates: vec![48_000],
                serial_number: None,
                system_name: "B".to_string(),
                system_ref: Some("hw:2,0".to_string()),
            },
        ];

        assert_eq!(runtime_audio_backends(&interfaces, |_| false), vec!["alsa"]);
    }

    #[test]
    fn parses_serial_from_sysfs_uevent() {
        assert_eq!(
            serial_from_uevent(
                r#"
PRODUCT=1397/50/100
SERIAL=x32-rack-usb-serial
TYPE=0/0/0
"#
            ),
            Some("x32-rack-usb-serial".to_string())
        );
    }
}
