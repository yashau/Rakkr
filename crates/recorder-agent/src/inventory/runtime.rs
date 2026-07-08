use std::env;
use std::fs;
use std::process::Command;

use super::{AudioInterfaceInventory, NodeRuntime};

pub(crate) fn runtime_details(interfaces: &[AudioInterfaceInventory]) -> NodeRuntime {
    NodeRuntime {
        architecture: env::consts::ARCH.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::alsa::fallback_interface;

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
}
