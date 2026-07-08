# Rakkr Node Lifecycle Baseline

Status: MVP baseline checked.

## Overview

Rakkr can manage the **host** side of recorder nodes — installing dependencies,
deploying the agent binary, managing the systemd service, rotating controller CA
trust, and running smoke checks — over SSH, driven from the operator console. The
controller records RBAC/audit context and orchestrates the work; **the controller
never SSHes anywhere itself.** It calls a small Dockerized Ansible runner
(`deploy/ansible/runner.py`), which runs an Ansible playbook against the target
host. Each node also reports the agent version it is running, and the controller
flags when a newer release is available so an operator can update in one click.

Physical-fleet SSH targets and credentials are operator-configured (see the
security model in the guide); the software path is validated end to end against
the disposable Compose `recorder-test-rig` (offline `local` binary source). This
baseline covers the controller/runner/role contract and the version/update-check
behavior — not physical-hardware sign-off.

## Allowlisted Actions

Five actions are allowlisted, and the **same allowlist is enforced at the
controller route, the runner, and the Ansible role**, so an unknown action is
rejected at every layer:

| Action                 | What it does                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| `install_dependencies` | Install recorder packages (ALSA/ffmpeg/PipeWire/JACK) and create the `rakkr` user. |
| `update_binary`        | Download the recorder-agent from a GitHub release, verify it, and (re)install it.   |
| `restart_service`      | Restart the `rakkr-recorder-agent` systemd service.                                |
| `rotate_trust`         | Install/refresh the controller CA in the host trust store.                          |
| `smoke_check`          | Run a node smoke command (default `--print-inventory`) and report its output.       |

- Evidence: `apps/api/src/node-lifecycle.ts`,
  `apps/api/src/node-lifecycle-routes.ts`, `deploy/ansible/runner.py`,
  `deploy/ansible/playbooks/node-lifecycle.yml`,
  `deploy/ansible/roles/recorder_node/tasks/update_binary.yml`.

## RBAC And Audit

- Lifecycle **runs** require `node:manage`; lifecycle-job and release **reads**
  require `node:read`. Every action is scoped to the caller's visible nodes — a
  run against a node outside scope is a `node_not_found` failure, audited.
- Every run is audited with its runner run ID, exit code, target host, status,
  and output (stdout/stderr). The audit `correlationIds` carry the lifecycle job
  id.
- Evidence: `apps/api/src/node-lifecycle-routes.ts`.

## Version Reporting And Update-Available Check

- The agent stamps its calendar version (`YYYY.MM.DD-N`) at build time from the
  `agent-v…` release tag; unstamped dev/CI builds report `0.0.0-dev`. The value
  is reported on **every heartbeat** — the `NodeInventory` struct is
  `serde(rename_all = "camelCase")`, so `agent_version` serializes as the
  `agentVersion` the controller heartbeat schema requires and persists.
- The controller resolves the newest published recorder-agent release from
  GitHub. Because all components share one repo with prefixed tags, it **lists**
  releases and picks the newest `agent-v…` tag itself (GitHub's "latest release"
  can point at a docs or controller tag), skipping drafts and pre-releases.
- The lookup is served by `GET /api/v1/nodes/agent-release` (`node:read`) and is
  **non-blocking**: the controller caches the result and refreshes it in the
  background (**stale-while-revalidate**), returning the cached value — possibly
  `null` on a cold cache — immediately. A GitHub outage never stalls the nodes
  page; it just hides the badge, and the last good value is retained across a
  failed refresh (with back-off before retry).
- The console compares each node's reported version against the resolved release
  and shows an **update available** badge plus an **Update to `‹version›`** action
  that runs `update_binary` pinned to that exact release tag. A node reporting
  `0.0.0-dev` never prompts an update.
- Evidence: `crates/recorder-agent/src/version.rs`,
  `crates/recorder-agent/src/inventory.rs`, `packages/shared/src/agent-version.ts`,
  `apps/api/src/agent-release-service.ts`, `apps/api/src/agent-release-routes.ts`,
  `apps/web/src/pages/nodes.tsx`, `apps/web/src/components/node-lifecycle-menu.tsx`.

## Provisioning And Offline Liveness

- A newly enrolled node starts **provisioning** ("Awaiting first contact"): it has
  never sent a heartbeat, so heartbeat-staleness cannot apply. It is **excluded
  from offline alerting** — `reconcileNodeLivenessEvents` skips it with reason
  `node_never_provisioned`, and `deriveNodeStatus` keeps it `provisioning` — until
  its first heartbeat flips it to a live status.
- For every non-provisioning node, `deriveNodeStatus`/`nodeHeartbeatStale` returns
  **offline** when the heartbeat is stale: strictly `ageSeconds >
  offlineAfterSeconds` (`RAKKR_NODE_OFFLINE_AFTER_SECONDS`, default 120; a zero
  threshold disables derivation). The watchdog opens exactly one critical
  `watchdog.node_offline` health event per node (deduped against an already-open
  event, filtered by type) and auto-resolves it on recovery.
- "Reachable" for the `/metrics` `rakkr_node_online` gauge and the dashboard's
  active-node count is the shared `isNodeReachable` predicate (online / recording /
  degraded / alerting). A never-contacted **provisioning** node and an **offline**
  node are both *not* reachable, so neither inflates the "reporting" count.
- Evidence: `apps/api/src/node-liveness.ts`,
  `apps/api/src/watchdog-node-liveness.ts`, `packages/shared/src/index.ts`
  (`isNodeReachable`).

## Binary Deployment

- `update_binary` deploys from a published GitHub release by default: each target
  downloads the static musl artifact for its architecture, verifies it against
  the release `sha256` checksum, and installs it. Without a pinned version the
  role resolves the newest release; forwarding `agentVersion` (a full release tag
  such as `agent-v2026.06.28-1`) pins that exact build — which is what the
  console's **Update to …** action does. `RAKKR_ANSIBLE_AGENT_SOURCE=local` is the
  offline fallback used by the Compose smoke.
- The controller-side release check (`RAKKR_AGENT_RELEASE_REPO`,
  `RAKKR_GITHUB_TOKEN`) is independent of the runner's own download source
  (`RAKKR_ANSIBLE_AGENT_REPO`, `RAKKR_ANSIBLE_GITHUB_TOKEN`).
- Evidence: `deploy/ansible/roles/recorder_node/tasks/update_binary.yml`,
  `deploy/ansible/roles/recorder_node/defaults/main.yml`.

## Runner And Role Invariants

- The runner exposes `GET /healthz` (liveness) and `POST /runs` (token-authed run
  of an allowlisted action against a single-host inventory), returning
  `{ exitCode, runId, stdout, stderr, targetHost }`.
- The role (`deploy/ansible/roles/recorder_node`) is idempotent (package/user/
  file/systemd modules, no ad-hoc shell orchestration), branches on distro vars,
  escalates via `become`, and rolls out **serially** across hosts.
- Lifecycle credentials stay out of node metadata; the preferred path has the
  runner fetch each node's SSH key and a freshly-minted controller token from the
  controller at run time.
- Evidence: `deploy/ansible/runner.py`,
  `deploy/ansible/playbooks/node-lifecycle.yml`.

## Checked By

| Check                  | Command                          |
| ---------------------- | -------------------------------- |
| Node lifecycle baseline | `mise run nodes:check-lifecycle` |

`mise run check` runs the node lifecycle baseline check.
