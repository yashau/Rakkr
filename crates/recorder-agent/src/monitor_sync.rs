use anyhow::Context;
use reqwest::header::{CONTENT_TYPE, HeaderName};

use crate::config::AgentConfig;
use crate::controller::node_url;
use crate::controller_http::controller_http_client;
use crate::telemetry::MeterSample;

const CAPTURED_AT_HEADER: &str = "x-rakkr-captured-at";
const DURATION_MS_HEADER: &str = "x-rakkr-duration-ms";

pub async fn post_monitor_chunk(
    config: &AgentConfig,
    token: &str,
    sample: &MeterSample,
) -> anyhow::Result<()> {
    config.validate_controller_transport()?;
    let url = node_url(&config.controller_url, &config.node_id, "listen/chunk");
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .header(CONTENT_TYPE, "audio/wav")
        .header(
            HeaderName::from_static(CAPTURED_AT_HEADER),
            sample.frame.captured_at.as_str(),
        )
        .header(
            HeaderName::from_static(DURATION_MS_HEADER),
            sample.monitor_duration_ms.to_string(),
        )
        .body(sample.monitor_wav.clone())
        .send()
        .await
        .context("post monitor chunk to controller")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected monitor chunk with {status}: {body}");
    }

    Ok(())
}

pub fn monitor_chunk_health_details(
    node_id: &str,
    sample: &MeterSample,
    error: Option<String>,
) -> serde_json::Value {
    serde_json::json!({
        "capturedAt": sample.frame.captured_at,
        "contentType": "audio/wav",
        "durationMs": sample.monitor_duration_ms,
        "error": error,
        "interfaceId": sample.frame.interface_id,
        "monitorBytes": sample.monitor_wav.len(),
        "nodeId": node_id,
    })
}
