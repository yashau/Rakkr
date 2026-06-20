use anyhow::Context;
use serde::Deserialize;

use crate::config::AgentConfig;
use crate::recorder_cache_retention::ControllerRecorderCacheRetention;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerNodeConfig {
    pub audio_defaults: Option<ControllerAudioDefaults>,
    #[serde(default)]
    pub recorder_cache_policies: Vec<ControllerRecorderCacheRetention>,
    pub recording_capacity: Option<ControllerRecordingCapacity>,
}

impl ControllerNodeConfig {
    pub fn max_concurrent_recordings(&self) -> Option<usize> {
        self.recording_capacity
            .as_ref()
            .map(|capacity| capacity.max_concurrent_recordings.max(1))
    }

    pub fn apply_audio_defaults(&self, config: &mut AgentConfig) -> bool {
        let Some(defaults) = &self.audio_defaults else {
            return false;
        };
        let before = audio_default_signature(config);

        if let Some(value) = non_empty_string(&defaults.capture_args_template) {
            config.capture_args_template = Some(value.to_string());
        }
        if let Some(value) = defaults.capture_channels {
            config.capture_channels = value;
        }
        if let Some(value) = non_empty_string(&defaults.capture_command) {
            config.capture_command = value.to_string();
        }
        if let Some(value) = non_empty_string(&defaults.capture_device) {
            config.capture_device = value.to_string();
        }
        if let Some(value) = non_empty_string(&defaults.capture_format) {
            config.capture_format = value.to_string();
        }
        if let Some(value) = defaults.capture_sample_rate {
            config.capture_sample_rate = value;
        }
        if let Some(value) = non_empty_string(&defaults.meter_args_template) {
            config.meter_args_template = Some(value.to_string());
        }

        before != audio_default_signature(config)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerAudioDefaults {
    pub capture_args_template: Option<String>,
    pub capture_channels: Option<u16>,
    pub capture_command: Option<String>,
    pub capture_device: Option<String>,
    pub capture_format: Option<String>,
    pub capture_sample_rate: Option<u32>,
    pub meter_args_template: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerRecordingCapacity {
    pub max_concurrent_recordings: usize,
}

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
}

pub async fn fetch_node_config(
    config: &AgentConfig,
    token: &str,
) -> anyhow::Result<ControllerNodeConfig> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, "config");
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .context("fetch node config")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected node config request with {status}: {body}");
    }

    let envelope = response
        .json::<DataEnvelope<ControllerNodeConfig>>()
        .await
        .context("decode node config")?;

    Ok(envelope.data)
}

fn node_url(controller_url: &str, node_id: &str, suffix: &str) -> String {
    format!(
        "{}/api/v1/nodes/{}/{}",
        controller_url.trim_end_matches('/'),
        node_id,
        suffix.trim_start_matches('/')
    )
}

fn non_empty_string(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn audio_default_signature(config: &AgentConfig) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}",
        config.capture_args_template.as_deref().unwrap_or_default(),
        config.capture_channels,
        config.capture_command,
        config.capture_device,
        config.capture_format,
        config.capture_sample_rate,
        config.meter_args_template.as_deref().unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn applies_controller_audio_defaults_to_agent_config() {
        let mut config = AgentConfig::try_parse_from(["rakkr-recorder-agent"]).unwrap();
        let controller_config = ControllerNodeConfig {
            audio_defaults: Some(ControllerAudioDefaults {
                capture_args_template: Some("--device {device} --output {output}".to_string()),
                capture_channels: Some(4),
                capture_command: Some("custom-capture".to_string()),
                capture_device: Some("hw:Loopback,1,0".to_string()),
                capture_format: Some("S24_LE".to_string()),
                capture_sample_rate: Some(96_000),
                meter_args_template: Some("--meter {device} -".to_string()),
            }),
            recorder_cache_policies: Vec::new(),
            recording_capacity: None,
        };

        assert!(controller_config.apply_audio_defaults(&mut config));
        assert_eq!(config.capture_command, "custom-capture");
        assert_eq!(config.capture_device, "hw:Loopback,1,0");
        assert_eq!(config.capture_format, "S24_LE");
        assert_eq!(config.capture_sample_rate, 96_000);
        assert_eq!(config.capture_channels, 4);
        assert_eq!(
            config.capture_args_template.as_deref(),
            Some("--device {device} --output {output}")
        );
        assert_eq!(
            config.meter_args_template.as_deref(),
            Some("--meter {device} -")
        );
        assert!(!controller_config.apply_audio_defaults(&mut config));
    }
}
