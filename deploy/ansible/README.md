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

## Smokes

Start the optional compose services:

```powershell
docker compose up -d --build ansible-runner controller-api
```

Run the local SSH harness smoke. This deploys the disposable recorder-agent
artifact into `recorder-test-rig`, then runs `smoke_check` against it:

```powershell
mise run ansible:runner-smoke
```

Run the safe physical X32 smoke check without deploying binaries:

```powershell
$env:RAKKR_ANSIBLE_SSH_DIR = "$env:USERPROFILE\.ssh"
$env:RAKKR_ANSIBLE_TARGETS = '{"node_x32_test":{"host":"172.22.145.152","sshUser":"root","sshKeyFile":"/run/rakkr-ssh/id_ed25519","smokeCommand":"/tmp/rakkr-recorder-agent --print-inventory"}}'
docker compose up -d --build ansible-runner
mise run ansible:x32-smoke
```

Do not run `update_binary` against the physical rig until
`RAKKR_ANSIBLE_BINARY_SRC` points at the intended Linux recorder-agent artifact.
