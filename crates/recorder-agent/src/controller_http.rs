use std::path::Path;

use anyhow::{Context, bail};

use crate::config::AgentConfig;

pub fn controller_http_client(config: &AgentConfig) -> anyhow::Result<reqwest::Client> {
    controller_http_client_with_ca(config.controller_ca_cert_path.as_deref())
}

pub fn controller_http_client_with_ca(
    ca_cert_path: Option<&Path>,
) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder();

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
}
