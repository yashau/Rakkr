# Rakkr Ansible Node Lifecycle

This optional component lets the controller request allowlisted recorder-node
lifecycle actions while Ansible owns host orchestration: SSH, package updates,
binary deployment, systemd units, privilege escalation, idempotency,
distro-specific tasks, and rolling execution.

Local compose starts:

- `ansible-runner` on `http://localhost:8790`
- `recorder-test-rig` as a Debian SSH target for smoke validation

The controller calls the runner through `RAKKR_ANSIBLE_RUNNER_URL`. The runner
accepts `POST /runs` for fixed actions only and writes a temporary single-host
inventory from the selected node.

Supported actions:

- `install_dependencies`
- `update_binary`
- `restart_service`
- `rotate_trust`
- `smoke_check`

The playbook is safe to run repeatedly. It uses package, user, file, copy,
template, and systemd modules rather than ad-hoc remote shell orchestration.

## Target Configuration

Use `RAKKR_ANSIBLE_TARGETS` to provide per-node runner settings without
storing SSH credentials in Rakkr node metadata:

```json
{
  "node_x32_test": {
    "host": "172.22.145.152",
    "sshUser": "root",
    "sshKeyFile": "/run/rakkr-ssh/id_ed25519",
    "becomePassword": "optional-if-sudo-prompts",
    "smokeCommand": "/tmp/rakkr-recorder-agent --print-inventory"
  }
}
```

For local compose, the default map points `node_x32_test` at
`recorder-test-rig` with the disposable `rakkr` password. For the physical X32
rig, mount the host SSH directory into the runner and provide the root key path
inside the container:

```powershell
$env:RAKKR_ANSIBLE_SSH_DIR = "$env:USERPROFILE\.ssh"
$env:RAKKR_ANSIBLE_TARGETS = '{"node_x32_test":{"host":"172.22.145.152","sshUser":"root","sshKeyFile":"/run/rakkr-ssh/id_ed25519","smokeCommand":"/tmp/rakkr-recorder-agent --print-inventory"}}'
docker compose up -d --build ansible-runner
```

The runner copies the mounted private key into a per-run temp directory with
`0600` permissions before invoking Ansible.

## Controller-managed SSH credentials (preferred)

The controller is the system of record for each node's SSH key and controller
token. When the runner is pointed at the controller it fetches the per-node SSH
private key (and, for deploy actions, a freshly-minted controller token) at run
time, so **no SSH secrets need to live in `RAKKR_ANSIBLE_TARGETS`** — it shrinks
to a non-secret host map.

```powershell
$env:RAKKR_RUNNER_CONTROLLER_URL = "https://controller.internal:8787"
$env:RAKKR_RUNNER_TOKEN = "<shared runner token, also set as RAKKR_RUNNER_TOKEN on the API>"
# Self-signed controller CA (optional): point at a mounted bundle, or allow insecure for dev.
$env:RAKKR_RUNNER_CONTROLLER_CA = "/run/rakkr/controller-ca.pem"
# $env:RAKKR_RUNNER_ALLOW_INSECURE = "1"   # dev only
$env:RAKKR_ANSIBLE_TARGETS = '{"node_x32_test":{"host":"172.22.145.152"}}'
```

Provision a node's key with the operator API (`node:manage`):

```bash
curl -X POST https://controller.internal:8787/api/v1/nodes/node_x32_test/ssh-credential/rotate \
  -H "authorization: Bearer <session token>"
# -> returns the OpenSSH public key + SHA256 fingerprint (private key stays controller-side)
```

The controller stores the private key encrypted at rest with the master key
(`RAKKR_NODE_SSH_MASTER_KEY`, falling back to `RAKKR_SECRET_KEY`). The runner
`rotate_trust`/`install_dependencies`/`update_binary` actions install the public
half into the agent user's `authorized_keys`. The runner writes the fetched
private key to a per-run `0600` temp file and deletes it when the run ends.

When `RAKKR_RUNNER_CONTROLLER_URL`/`RAKKR_RUNNER_TOKEN` are unset, or the node has
no managed SSH credential yet (HTTP 404), the runner falls back to the
`RAKKR_ANSIBLE_TARGETS`/env key described above.

## Binary Deployment

`update_binary` deploys the recorder-agent from a published GitHub release by
default. The target node downloads the static musl artifact for its
architecture (`x86_64`/`aarch64`), verifies it against the release `.sha256`,
unpacks it, and installs it as `/opt/rakkr/bin/rakkr-recorder-agent`.

| Variable                       | Purpose                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `RAKKR_ANSIBLE_AGENT_SOURCE`   | `release` (default) pulls a GitHub release; `local` copies a staged file (offline/smoke).  |
| `RAKKR_ANSIBLE_AGENT_REPO`     | `owner/repo` to pull releases from (defaults to `yashau/Rakkr`).                            |
| `RAKKR_ANSIBLE_GITHUB_TOKEN`   | Optional token for private repos or higher GitHub API rate limits.                          |
| `RAKKR_ANSIBLE_BINARY_SRC`     | Staged artifact path used only when the source is `local`.                                  |

The version is chosen per run: the controller/runner forwards `agentVersion` as
`rakkr_agent_version` (a full release tag such as `agent-v2026.06.28-1`) when set;
otherwise the role resolves the newest release via the GitHub API. Release binaries
are produced by the `Release recorder agent` workflow
(`.github/workflows/release-agent.yml`), triggered by pushing an `agent-v…` tag.

## Smokes

Start the optional compose services:

```powershell
docker compose up -d --build ansible-runner controller-api
```

Run the local SSH harness smoke. The compose runner defaults
`RAKKR_ANSIBLE_AGENT_SOURCE=local`, so this deploys the disposable baked
artifact into `recorder-test-rig` (no network), then runs `smoke_check`:

```powershell
mise run ansible:runner-smoke
```

To exercise the real GitHub-release path end to end, start the runner with the
release source (the test rig then downloads the published static musl binary):

```powershell
$env:RAKKR_ANSIBLE_AGENT_SOURCE = "release"
docker compose up -d --build ansible-runner recorder-test-rig
mise run ansible:runner-smoke
```

Run the safe physical X32 smoke check without deploying binaries:

```powershell
$env:RAKKR_ANSIBLE_SSH_DIR = "$env:USERPROFILE\.ssh"
$env:RAKKR_ANSIBLE_TARGETS = '{"node_x32_test":{"host":"172.22.145.152","sshUser":"root","sshKeyFile":"/run/rakkr-ssh/id_ed25519","smokeCommand":"/tmp/rakkr-recorder-agent --print-inventory"}}'
docker compose up -d --build ansible-runner
mise run ansible:x32-smoke
```

By default `update_binary` pulls the latest published release, so the physical
rig needs outbound access to GitHub. To deploy a specific build, forward
`agentVersion` (a full release tag such as `agent-v2026.06.28-1`) from the
console/controller. For
air-gapped rigs, set `RAKKR_ANSIBLE_AGENT_SOURCE=local` and point
`RAKKR_ANSIBLE_BINARY_SRC` at a staged Linux recorder-agent artifact.
