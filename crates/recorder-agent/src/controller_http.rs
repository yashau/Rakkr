use std::path::Path;
use std::time::Duration;

use anyhow::{Context, bail};

use crate::config::AgentConfig;

pub fn controller_http_client(config: &AgentConfig) -> anyhow::Result<reqwest::Client> {
    controller_http_client_with_ca(config.controller_ca_cert_path.as_deref())
}

pub fn controller_http_client_with_ca(
    ca_cert_path: Option<&Path>,
) -> anyhow::Result<reqwest::Client> {
    build_controller_http_client(
        ca_cert_path,
        connect_timeout(),
        read_timeout(),
        request_timeout(),
    )
}

// Bound every controller request so a black-hole controller/proxy — one that accepts
// the TCP connection but never makes progress — cannot hang the heartbeat / upload /
// job-poll loop forever (reqwest has NO default timeout). connect_timeout bounds the
// TCP/TLS handshake; read_timeout bounds the wait between RESPONSE bytes; and an
// overall request timeout bounds the whole exchange — critically the request-body
// WRITE of a large buffered cache-file upload, which read_timeout can't see (no read
// is in progress while the body is being written), so a controller that stops
// draining the body would otherwise block the write forever. The overall ceiling is
// generous so it never caps a legitimately-progressing large upload. All env-tunable
// for slow links (read from env, not AgentConfig, because this is also called from
// contexts without a config — cache-file upload and day-0 bootstrap).
fn connect_timeout() -> Duration {
    Duration::from_millis(env_millis("RAKKR_CONTROLLER_CONNECT_TIMEOUT_MS", 10_000))
}

fn read_timeout() -> Duration {
    Duration::from_millis(env_millis("RAKKR_CONTROLLER_READ_TIMEOUT_MS", 60_000))
}

fn request_timeout() -> Duration {
    // Overall per-request deadline; default 1h to comfortably cover a multi-GB WAV
    // cache-file upload over a slow link while still bounding a stalled write/read.
    Duration::from_millis(env_millis("RAKKR_CONTROLLER_REQUEST_TIMEOUT_MS", 3_600_000))
}

fn env_millis(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn build_controller_http_client(
    ca_cert_path: Option<&Path>,
    connect_timeout: Duration,
    read_timeout: Duration,
    request_timeout: Duration,
) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .timeout(request_timeout);

    if let Some(path) = ca_cert_path {
        let cert = std::fs::read(path)
            .with_context(|| format!("read controller CA certificate from {}", path.display()))?;
        let certs = reqwest::Certificate::from_pem_bundle(&cert)
            .with_context(|| format!("parse controller CA certificate from {}", path.display()))?;

        if certs.is_empty() {
            bail!(
                "parse controller CA certificate from {}: no PEM certificates found",
                path.display()
            );
        }

        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }

    builder.build().context("build controller HTTP client")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn builds_default_controller_http_client() {
        controller_http_client_with_ca(None).expect("default client should build");
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn reports_invalid_controller_ca_cert_path() {
        let root = std::env::temp_dir().join(format!("rakkr-invalid-ca-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let cert_path = root.join("controller-ca.pem");
        fs::write(&cert_path, "not a pem certificate").unwrap();

        let error = controller_http_client_with_ca(Some(&cert_path))
            .expect_err("invalid CA PEM should fail");

        fs::remove_dir_all(&root).ok();

        assert!(
            error
                .to_string()
                .contains("parse controller CA certificate")
        );
    }

    #[tokio::test]
    #[cfg_attr(miri, ignore)]
    async fn abandons_a_black_hole_controller_within_the_read_timeout() {
        use std::time::Duration;
        use tokio::net::TcpListener;

        // A controller that accepts the connection but never sends a response.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream); // hold the connection open, never write a response
            }
        });

        let client = build_controller_http_client(
            None,
            Duration::from_secs(5),
            Duration::from_millis(300),
            Duration::from_secs(30),
        )
        .expect("client");

        // Without a read timeout this send() hangs forever; the 3s guard proves the
        // request is abandoned (errored) well within it once the timeout is set.
        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            client.get(format!("http://{addr}/")).send(),
        )
        .await;

        assert!(
            outcome.is_ok(),
            "request hung past the read timeout (no timeout configured)"
        );
        assert!(
            outcome.expect("did not hang").is_err(),
            "expected a timeout error from the black-hole controller"
        );
    }

    #[tokio::test]
    #[cfg_attr(miri, ignore)]
    async fn overall_request_timeout_bounds_a_stalled_exchange_even_with_a_long_read_timeout() {
        use std::time::Duration;
        use tokio::net::TcpListener;

        // A controller that accepts the connection but never makes progress. This
        // stands in for the request-body write-stall (a controller that stops draining
        // a large upload body), which read_timeout cannot see. The overall request
        // timeout must bound it regardless of the read timeout.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });

        // read_timeout is long (10s) so ONLY the overall request timeout (300ms) can
        // fire within the 3s guard — isolating the overall deadline.
        let client = build_controller_http_client(
            None,
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_millis(300),
        )
        .expect("client");

        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            client
                .put(format!("http://{addr}/upload"))
                .body(vec![0u8; 64])
                .send(),
        )
        .await;

        assert!(
            outcome.is_ok(),
            "request hung past the overall request timeout (no total deadline set)"
        );
        assert!(
            outcome.expect("did not hang").is_err(),
            "expected an overall-timeout error from the stalled controller"
        );
    }
}
