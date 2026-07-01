use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::AgentConfig;
use crate::controller::node_url;
use crate::controller_http::controller_http_client;
use crate::inventory::{self, AudioInterfaceInventory};

// Day-0 onboarding: the node mints its own SSH identity at first boot and hands
// the private key to the controller exactly once, over TLS, gated by the
// single-use bootstrap token. It keeps only its public key in authorized_keys,
// writes the controller-minted token into the agent env, and wipes the local
// private key. Ansible later SSHes in using the controller-held private key.
const BOOTSTRAP_SSH_USERNAME: &str = "rakkr";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapRequest<'a> {
    interfaces: &'a [AudioInterfaceInventory],
    private_key: String,
    public_key: String,
    username: &'a str,
}

#[derive(Deserialize)]
struct BootstrapResponseEnvelope {
    data: BootstrapResponseData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponseData {
    controller_token: Option<String>,
    fingerprint: Option<String>,
}

pub async fn run_bootstrap(config: &AgentConfig) -> anyhow::Result<()> {
    config.validate_controller_transport()?;

    let token = config
        .bootstrap_token
        .as_deref()
        .context("missing --bootstrap-token or RAKKR_BOOTSTRAP_TOKEN")?;
    let inventory = inventory::collect(config);
    let keypair = generate_keypair(config)?;

    install_authorized_key(&config.bootstrap_authorized_keys_path, &keypair.public_key)?;

    let payload = BootstrapRequest {
        interfaces: &inventory.interfaces,
        private_key: keypair.private_key.clone(),
        public_key: keypair.public_key.clone(),
        username: BOOTSTRAP_SSH_USERNAME,
    };
    let url = node_url(&config.controller_url, &config.node_id, "bootstrap");
    let response = controller_http_client(config)?
        .post(&url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .context("post node bootstrap to controller")?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        bail!("controller rejected node bootstrap with {status}: {body}");
    }

    let envelope = response
        .json::<BootstrapResponseEnvelope>()
        .await
        .context("decode node bootstrap response")?;

    if let Some(controller_token) = envelope.data.controller_token.as_deref() {
        write_controller_token(&config.bootstrap_env_file, controller_token)
            .context("write controller token to agent env file")?;
    } else {
        warn!("controller did not return a controller token during bootstrap");
    }

    info!(
        node_id = %config.node_id,
        fingerprint = ?envelope.data.fingerprint,
        "node bootstrap complete"
    );

    // `keypair` is wiped by its Drop impl on every exit path (success or any
    // `?`/`bail!` above) — the controller now holds the private key; the node
    // keeps only its installed public key.
    Ok(())
}

struct GeneratedKey {
    private_key: String,
    private_key_path: PathBuf,
    public_key: String,
}

fn generate_keypair(config: &AgentConfig) -> anyhow::Result<GeneratedKey> {
    let dir = std::env::temp_dir().join(format!("rakkr-bootstrap-{}", std::process::id()));

    fs::create_dir_all(&dir).context("create bootstrap key temp dir")?;
    set_permissions(&dir, 0o700);

    let key_path = dir.join("id_ed25519");
    // ssh-keygen refuses to overwrite an existing key, so start from a clean slate.
    let _ = fs::remove_file(&key_path);
    let _ = fs::remove_file(public_key_path(&key_path));

    let status = Command::new(&config.ssh_keygen_command)
        .arg("-t")
        .arg("ed25519")
        .arg("-N")
        .arg("")
        .arg("-C")
        .arg(format!("rakkr-{}", config.node_id))
        .arg("-f")
        .arg(&key_path)
        .status()
        .with_context(|| format!("run {}", config.ssh_keygen_command))?;

    if !status.success() {
        bail!("ssh-keygen failed with status {status}");
    }

    // ssh-keygen has already written the key files; if reading them back fails
    // (before the RAII-guarded GeneratedKey exists), remove them so a read error
    // cannot orphan a live private key on disk.
    let (private_key, public_key) = match read_generated_keypair(&key_path) {
        Ok(pair) => pair,
        Err(error) => {
            let _ = fs::remove_file(&key_path);
            let _ = fs::remove_file(public_key_path(&key_path));
            let _ = fs::remove_dir(&dir);

            return Err(error);
        }
    };

    Ok(GeneratedKey {
        private_key,
        private_key_path: key_path,
        public_key,
    })
}

fn read_generated_keypair(key_path: &Path) -> anyhow::Result<(String, String)> {
    let private_key = fs::read_to_string(key_path).context("read generated private key")?;
    let public_key = fs::read_to_string(public_key_path(key_path))
        .context("read generated public key")?
        .trim()
        .to_string();

    Ok((private_key, public_key))
}

fn install_authorized_key(path: &Path, public_key: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create ssh directory {}", parent.display()))?;
        set_permissions(parent, 0o700);
    }

    fs::write(path, format!("{public_key}\n"))
        .with_context(|| format!("write authorized_keys {}", path.display()))?;
    set_permissions(path, 0o600);

    Ok(())
}

fn write_controller_token(env_file: &Path, token: &str) -> anyhow::Result<()> {
    if let Some(parent) = env_file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create env directory {}", parent.display()))?;
    }

    // Replace any existing RAKKR_CONTROLLER_TOKEN line, preserving other env vars.
    let existing = fs::read_to_string(env_file).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| !line.trim_start().starts_with("RAKKR_CONTROLLER_TOKEN="))
        .map(str::to_string)
        .collect();

    lines.push(format!("RAKKR_CONTROLLER_TOKEN={token}"));
    fs::write(env_file, format!("{}\n", lines.join("\n")))
        .with_context(|| format!("write env file {}", env_file.display()))?;
    set_permissions(env_file, 0o640);

    Ok(())
}

impl Drop for GeneratedKey {
    // RAII wipe: best-effort overwrite + remove of the temp private key on every
    // exit path (success or any intermediate failure). Bootstrap is one-shot and
    // exits right after, so this is the only cleanup — a partial/failed bootstrap
    // must not leave a live SSH private key readable on disk.
    fn drop(&mut self) {
        if let Ok(metadata) = fs::metadata(&self.private_key_path) {
            let _ = fs::write(&self.private_key_path, vec![0u8; metadata.len() as usize]);
        }

        let _ = fs::remove_file(&self.private_key_path);
        let _ = fs::remove_file(public_key_path(&self.private_key_path));

        if let Some(parent) = self.private_key_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

fn public_key_path(private_key_path: &Path) -> PathBuf {
    let mut value = private_key_path.as_os_str().to_owned();

    value.push(".pub");

    PathBuf::from(value)
}

#[cfg(unix)]
fn set_permissions(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;

    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_permissions(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_key_path_appends_pub_suffix() {
        assert_eq!(
            public_key_path(Path::new("/tmp/rakkr/id_ed25519")),
            PathBuf::from("/tmp/rakkr/id_ed25519.pub")
        );
    }

    #[test]
    #[cfg_attr(miri, ignore)] // touches the real filesystem
    fn write_controller_token_replaces_existing_line() {
        let dir = std::env::temp_dir().join(format!("rakkr-bootstrap-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let env_file = dir.join("agent.env");
        fs::write(
            &env_file,
            "RAKKR_NODE_ID=node_test\nRAKKR_CONTROLLER_TOKEN=old\n",
        )
        .unwrap();

        write_controller_token(&env_file, "fresh-token").unwrap();
        let contents = fs::read_to_string(&env_file).unwrap();

        assert!(contents.contains("RAKKR_NODE_ID=node_test"));
        assert!(contents.contains("RAKKR_CONTROLLER_TOKEN=fresh-token"));
        assert_eq!(contents.matches("RAKKR_CONTROLLER_TOKEN=").count(), 1);

        let _ = fs::remove_file(&env_file);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    #[cfg_attr(miri, ignore)] // touches the real filesystem
    fn dropping_generated_key_wipes_the_private_key() {
        let dir = std::env::temp_dir().join(format!("rakkr-bootstrap-drop-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("id_ed25519");
        fs::write(&key_path, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        fs::write(public_key_path(&key_path), "ssh-ed25519 AAAA rakkr\n").unwrap();

        {
            let _keypair = GeneratedKey {
                private_key: "private".to_string(),
                private_key_path: key_path.clone(),
                public_key: "public".to_string(),
            };
            // Scope end drops the keypair. Pre-fix there was no Drop, so a
            // failed bootstrap left this file on disk; RAII must now wipe it.
        }

        assert!(
            !key_path.exists(),
            "private key must be wiped when the keypair is dropped"
        );
        assert!(
            !public_key_path(&key_path).exists(),
            "public key temp must be removed on drop",
        );

        let _ = fs::remove_dir(&dir);
    }
}
