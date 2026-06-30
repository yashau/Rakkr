//! Recording cache-file upload to the controller.
//!
//! The agent uploads recording renditions (and, for chunked recordings, individual
//! chunk files) to the controller cache via `PUT /recordings/:id/cache-file`. The
//! controller — not the agent — is the only thing that writes to external storage.

use anyhow::Context;
use reqwest::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use tracing::info;

use super::{CacheFileUpload, DURATION_HEADER, FILE_NAME_HEADER, JOB_ID_HEADER};
use crate::controller_http::controller_http_client_with_ca;

pub async fn upload_cache_file(input: CacheFileUpload<'_>) -> anyhow::Result<()> {
    crate::config::validate_controller_transport(
        input.controller_url,
        input.allow_insecure_controller,
    )?;
    let bytes = std::fs::read(input.file_path)
        .with_context(|| format!("read recording cache file {}", input.file_path.display()))?;

    if bytes.is_empty() {
        anyhow::bail!(
            "recording cache file is empty: {}",
            input.file_path.display()
        );
    }

    let url = recording_cache_url_with_query(
        input.controller_url,
        input.recording_id,
        input.rendition,
        input.chunk_index,
        input.chunk_total,
    );
    let mut request = controller_http_client_with_ca(input.controller_ca_cert_path)?
        .put(&url)
        .bearer_auth(input.token)
        .header(CONTENT_TYPE, input.content_type)
        .body(bytes);

    if let Some(duration_seconds) = input.duration_seconds {
        request = request.header(
            HeaderName::from_static(DURATION_HEADER),
            HeaderValue::from_str(&duration_seconds.to_string()).context("duration header")?,
        );
    }

    if let Some(file_name) = input.file_name {
        request = request.header(
            HeaderName::from_static(FILE_NAME_HEADER),
            HeaderValue::from_str(&file_name).context("file name header")?,
        );
    }

    if let Some(job_id) = input.job_id {
        request = request.header(
            HeaderName::from_static(JOB_ID_HEADER),
            HeaderValue::from_str(job_id).context("job id header")?,
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
        recording_id = input.recording_id,
        url = url,
        "attached recording cache file to controller"
    );

    Ok(())
}

pub(super) fn recording_cache_url(controller_url: &str, recording_id: &str) -> String {
    format!(
        "{}/api/v1/recordings/{}/cache-file",
        controller_url.trim_end_matches('/'),
        recording_id
    )
}

/// Build the cache-file PUT URL, appending the optional `rendition`, `chunk`, and
/// `chunkTotal` query params. `chunkTotal` is only present on the final chunk of a
/// chunked recording; older controllers ignore the chunk params entirely.
pub(super) fn recording_cache_url_with_query(
    controller_url: &str,
    recording_id: &str,
    rendition: Option<&str>,
    chunk_index: Option<u32>,
    chunk_total: Option<u32>,
) -> String {
    let mut url = recording_cache_url(controller_url, recording_id);
    let mut params: Vec<(&str, String)> = Vec::new();

    if let Some(rendition) = rendition {
        params.push(("rendition", rendition.to_string()));
    }
    if let Some(chunk_index) = chunk_index {
        params.push(("chunk", chunk_index.to_string()));
    }
    if let Some(chunk_total) = chunk_total {
        params.push(("chunkTotal", chunk_total.to_string()));
    }

    if !params.is_empty() {
        url.push('?');
        url.push_str(
            &params
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("&"),
        );
    }

    url
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

    #[test]
    fn builds_cache_url_without_query_when_no_markers() {
        assert_eq!(
            recording_cache_url_with_query("https://controller.local", "rec_1", None, None, None),
            "https://controller.local/api/v1/recordings/rec_1/cache-file"
        );
    }

    #[test]
    fn builds_cache_url_with_rendition_only() {
        assert_eq!(
            recording_cache_url_with_query(
                "https://controller.local",
                "rec_1",
                Some("enhanced"),
                None,
                None
            ),
            "https://controller.local/api/v1/recordings/rec_1/cache-file?rendition=enhanced"
        );
    }

    #[test]
    fn builds_cache_url_with_chunk_index_but_no_total() {
        assert_eq!(
            recording_cache_url_with_query(
                "https://controller.local",
                "rec_1",
                Some("raw"),
                Some(3),
                None
            ),
            "https://controller.local/api/v1/recordings/rec_1/cache-file?rendition=raw&chunk=3"
        );
    }

    #[test]
    fn builds_cache_url_with_chunk_total_on_final_chunk() {
        assert_eq!(
            recording_cache_url_with_query(
                "https://controller.local",
                "rec_1",
                Some("enhanced"),
                Some(5),
                Some(5)
            ),
            "https://controller.local/api/v1/recordings/rec_1/cache-file?rendition=enhanced&chunk=5&chunkTotal=5"
        );
    }

    #[test]
    fn builds_cache_url_with_chunk_index_without_rendition() {
        assert_eq!(
            recording_cache_url_with_query(
                "https://controller.local",
                "rec_1",
                None,
                Some(1),
                None
            ),
            "https://controller.local/api/v1/recordings/rec_1/cache-file?chunk=1"
        );
    }
}
