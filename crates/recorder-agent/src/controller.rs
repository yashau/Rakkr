use anyhow::Context;
use reqwest::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use std::fs;
use tracing::info;

use crate::config::AgentConfig;

const DURATION_HEADER: &str = "x-rakkr-duration-seconds";
const FILE_NAME_HEADER: &str = "x-rakkr-file-name";

pub async fn attach_cache_file(config: &AgentConfig) -> anyhow::Result<()> {
    let recording_id = config
        .attach_cache_recording_id
        .as_deref()
        .context("missing --attach-cache-recording-id")?;
    let file_path = config
        .attach_cache_file
        .as_deref()
        .context("missing --attach-cache-file")?;
    let token = config
        .controller_token
        .as_deref()
        .context("missing --controller-token or RAKKR_CONTROLLER_TOKEN")?;
    let bytes = fs::read(file_path)
        .with_context(|| format!("read recording cache file {}", file_path.display()))?;

    if bytes.is_empty() {
        anyhow::bail!("recording cache file is empty: {}", file_path.display());
    }

    let url = recording_cache_url(&config.controller_url, recording_id);
    let file_name = config.attach_cache_file_name.clone().or_else(|| {
        file_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
    });
    let mut request = reqwest::Client::new()
        .put(&url)
        .bearer_auth(token)
        .header(CONTENT_TYPE, config.attach_cache_content_type.as_str())
        .body(bytes);

    if let Some(duration_seconds) = config.attach_cache_duration_seconds {
        request = request.header(
            HeaderName::from_static(DURATION_HEADER),
            HeaderValue::from_str(&duration_seconds.to_string()).context("duration header")?,
        );
    }

    if let Some(file_name) = file_name {
        request = request.header(
            HeaderName::from_static(FILE_NAME_HEADER),
            HeaderValue::from_str(&file_name).context("file name header")?,
        );
    }

    let response = request
        .send()
        .await
        .context("send cache file to controller")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        anyhow::bail!("controller rejected cache file with {status}: {body}");
    }

    info!(
        recording_id = recording_id,
        url = url,
        "attached recording cache file to controller"
    );

    Ok(())
}

fn recording_cache_url(controller_url: &str, recording_id: &str) -> String {
    format!(
        "{}/api/v1/recordings/{}/cache-file",
        controller_url.trim_end_matches('/'),
        recording_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_recording_cache_url_without_double_slashes() {
        assert_eq!(
            recording_cache_url("https://controller.local/", "rec_123"),
            "https://controller.local/api/v1/recordings/rec_123/cache-file"
        );
    }
}
