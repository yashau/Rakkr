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
