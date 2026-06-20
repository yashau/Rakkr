use anyhow::Context;
use serde::Deserialize;

use crate::config::AgentConfig;
use crate::recorder_cache_retention::ControllerRecorderCacheRetention;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerNodeConfig {
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
