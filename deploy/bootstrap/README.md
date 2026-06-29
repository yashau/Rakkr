# Recorder node day-0 bootstrap

`agent.sh` is the one-liner installer for a brand-new recorder node. It is
published at `rakkr.org/agent.sh` and lives here in the repo so the manual and
Ansible-managed install paths never drift (same user, dirs, unit, and binary
layout as the `recorder_node` role).

## Flow

1. An operator enrolls the node and mints a **single-use, short-TTL** bootstrap
   token: `POST /api/v1/nodes/:id/bootstrap-token` (`node:manage`).
2. The token rides into the node's provisioning (cloud-init / autoinstall
   user-data) or is pasted into the one-liner.
3. First boot runs `agent.sh`, which:
   - downloads the checksum-verified static-musl agent from the matching GitHub
     release;
   - creates the `rakkr` user, dirs, env file, and systemd unit;
   - runs `rakkr-recorder-agent --bootstrap`, which **generates an SSH keypair
     locally**, installs the public key into the agent user's
     `authorized_keys`, POSTs the **private key + discovered inventory** to
     `POST /api/v1/nodes/:id/bootstrap` (authenticated only by the bootstrap
     token), receives a long-lived controller token, writes it to the env file,
     and wipes the local private key;
   - enables and starts the service.

From then on the Ansible runner fetches this node's SSH key + token from the
controller for every lifecycle action (see `deploy/ansible/README.md`); no SSH
keys are baked into images.

## Usage

```sh
curl -fsSL https://rakkr.org/agent.sh | sudo sh -s -- \
  --controller-url https://10.0.0.10:8787 \
  --bootstrap-token rakkr_bs_... \
  [--version agent-vYYYY.MM.DD-N] \
  [--node-id node_...] [--node-alias "Studio A"] [--site HQ] [--room "Studio A"] \
  [--allow-insecure] [--controller-ca /path/to/controller-ca.pem]
```

- `--version` pins a full release tag; omit it for the latest release.
- `--allow-insecure` permits a plaintext / self-signed controller (dev only).
- `--controller-ca` trusts a self-signed controller CA for the bootstrap call.

`cloud-init.yaml` is a ready-to-edit user-data example that runs the same
one-liner unattended on first boot.
