# Recorder Node Onboarding, Credential & Secrets Management — Design Proposal

> **Status: PROPOSAL — for review, not yet implemented.**
> Scope: day-0 onboarding of a new recorder node (#7), node credential
> management for controller tokens + SSH keys (#8), and Kubernetes secrets
> management for the controller (#9). These three are designed together because
> they share one system of record.

## 1. Current state (what exists today)

**Enrollment.** `POST /api/v1/nodes/enroll` (`node:manage`) creates a node row
and returns a one-time `rakkr_node_…` token. The token is shown once and never
retrievable again. There is no pre-registration / bootstrap concept — the whole
node + first credential is minted in a single operator API call.

**Controller token credential.** `node_credentials` table: `id`, `nodeId`,
`tokenHash` (SHA-256), `tokenPrefix`, `createdAt`, `revokedAt`, `lastUsedAt`,
`createdByUserId`. Long-lived bearer; soft-revoke; rotated via
`POST /api/v1/nodes/:id/credentials/rotate`. The agent presents it as
`RAKKR_CONTROLLER_TOKEN`. Hashed at rest (good).

**SSH access for Ansible.** Entirely manual and out-of-band. The runner reads
SSH user/key/password from `RAKKR_ANSIBLE_TARGETS` (a JSON env blob that
**embeds passwords**), `RAKKR_ANSIBLE_SSH_DIR`, and mounted key files. There is
**no** controller-side SSH key storage, generation, rotation, or link to the
node credential. The recorder_node role never manages `authorized_keys`.

**Token delivery to the agent.** Before this work the Ansible env template
carried no token. This session added the *plumbing* (the runner forwards a
`controllerToken` into the agent env), but the token value is still supplied
**manually** via `RAKKR_ANSIBLE_TARGETS` — the temporary wiring on the rig today.

**Secrets.** All plaintext in env / `values.yaml`. The Helm chart has `Secret`
resources for `DATABASE_URL`, `RAKKR_LOCAL_ADMIN_PASSWORD`,
`RAKKR_OIDC_CLIENT_SECRET`, and the postgres password, and supports
`existingSecret` for the DB + postgres only. **Missing from Helm entirely:** the
whole `RAKKR_ANSIBLE_*` set (runner token, SSH password/key, GitHub token,
become password) and `RAKKR_ANSIBLE_TARGETS` (which embeds SSH passwords). No
External Secrets Operator / Vault / Sealed Secrets anywhere.

### Gaps
- No secure day-0 bootstrap: a brand-new node can't get its SSH trust + token
  without an operator manually copying secrets.
- Two unlinked secrets per node (SSH + token), neither lifecycle-managed as a
  pair, SSH not managed at all.
- Secrets (incl. SSH credentials) live in plaintext env / `RAKKR_ANSIBLE_TARGETS`.
- k8s deployment can't source the Ansible/runner secrets from a secret manager.

## 2. Goals & principles

1. **Low-touch day-0.** Bring up a generic node image with one short-lived
   bootstrap token; everything else is provisioned automatically.
2. **One system of record.** The controller owns node credentials — both the
   controller token (hashed) and the SSH key (encrypted) — issued, rotated, and
   revoked together, audited and RBAC-gated (`node:manage`).
3. **No standing plaintext secrets.** Nothing sensitive in node metadata, in
   `RAKKR_ANSIBLE_TARGETS`, or in committed `values.yaml`.
4. **Golden-rule aligned.** Same posture as meters: real, managed, honest — no
   secrets smuggled through convenience env blobs.
5. **k8s-ready.** Every controller secret sources from a `Secret` and can be fed
   by an external secret manager.

## 3. Proposed architecture

### 3.1 Controller becomes the credential system of record

- **Controller token** — keep `node_credentials` as-is (hashed, rotatable,
  revocable).
- **SSH credential (new)** — `node_ssh_credentials`: `id`, `nodeId`,
  `publicKey`, `privateKeyEncrypted`, `fingerprint`, `createdAt`, `rotatedAt`,
  `revokedAt`, `createdByUserId`. SSH private keys **must** be usable, so they
  are **encrypted at rest** with a controller master key (not hashed). One
  active (non-revoked) key per node.
- **Runner pulls creds from the controller.** At lifecycle time the runner asks
  the controller (authenticated with a runner-scoped token) for the target
  node's SSH private key + a freshly-minted node token, writes the key to a
  per-run temp file (`0600`, already its pattern), uses it, and deletes it. This
  **removes SSH secrets from `RAKKR_ANSIBLE_TARGETS`** — `TARGETS` shrinks to a
  non-secret host/user map (or is derived from node metadata).

### 3.2 Day-0 onboarding flow (decided: node-generated key, from the OS install up)

Starting from a bare OS install — nothing trusted is pre-baked into the image
except a short-lived bootstrap token delivered by the provisioning layer:

```
0. OS install (Debian autoinstall / cloud-init user-data), supplied at
   provisioning time with: controller URL + a single-use bootstrap token.
   First boot: create the agent user, install the agent binary (baked into the
   image or downloaded from a release, checksum-verified), then run a one-shot
   `rakkr-recorder-agent --bootstrap`.

Operator (console)                Controller                    New node (first boot)
  │  enroll node (alias, loc) ──────▶ create node row
  │                                   issue ONE-TIME bootstrap token (short TTL)
  │  ◀── bootstrap token + node id ───┘
  │  (token rides into the node's autoinstall / cloud-init user-data)
  │                                                              │
  │                                          first-boot one-shot:
  │                                          rakkr-recorder-agent --bootstrap
  │                                            • generate SSH keypair locally
  │                                            • install PUBLIC key into the
  │                                              agent user's authorized_keys
  │                                            • POST /nodes/:id/bootstrap
  │                                              (auth: bootstrap token) with
  │                                              inventory + SSH PRIVATE key
  │                       verify bootstrap token (single-use, unexpired) ◀──────┘
  │                       store SSH private key (encrypted) + public key
  │                       mint long-lived controller token
  │                       consume bootstrap token; audit
  │                       └── return controller token ──────────▶ write agent env
  │                                                               wipe local privkey
  │                                                               enable agent service
  ▼
From now on: the Ansible runner fetches this node's SSH key + token from the
controller for every lifecycle action. No manual key/token handling, and no SSH
keys baked into OS images — only the one-time bootstrap token rides along.
```

The node mints its own SSH identity at first boot and hands the private key to
the controller exactly once (over TLS, gated by the single-use token), then
wipes it locally — it keeps only its own **public** key in `authorized_keys`,
and Ansible SSHes *in* using the controller-held private key. The `--bootstrap`
mode lives in the existing agent binary (single artifact, already deployed by
the `update_binary` lifecycle) and is invoked by the first-boot one-shot.

**Delivery paths (both run the same `--bootstrap`):**

1. **One-liner installer (`curl … | sh`), published at `rakkr.org`** — the
   primary, familiar UX:
   ```bash
   curl -fsSL https://rakkr.org/agent.sh | sudo sh -s -- \
     --controller-url https://10.0.0.10:8787 \
     --bootstrap-token rakkr_bs_3kJ9… \
     [--version agent-vYYYY.MM.DD-N] [--allow-insecure]
   ```
   The script detects the CPU architecture, downloads the static-musl agent from
   the matching GitHub release (checksum-verified against the published
   `.sha256`), creates the `rakkr` user + dirs, installs the systemd unit, then
   execs `rakkr-recorder-agent --bootstrap …`. It reuses the **same install
   steps as the Ansible `recorder_node` role** (identical paths / user / unit) so
   the manual and Ansible-managed paths never drift. Served over HTTPS; the token
   is single-use + short-TTL.
2. **Autoinstall / cloud-init** — the same one-liner dropped into provisioning
   user-data (`runcmd`) for unattended first boot.

The script lives in the repo (e.g. `deploy/bootstrap/agent.sh`) and is
published to `rakkr.org/agent.sh`.

### 3.3 Credential lifecycle

- **Token rotation** — exists (`/credentials/rotate`); the runner can rotate on
  deploy so each (re)deploy re-provisions a fresh token into the agent env.
- **SSH key rotation** — new `rotate_trust`-style action: controller generates a
  new keypair (or requests node regeneration), pushes the new **public** key to
  the node's `authorized_keys` via Ansible, stores the new private key, then
  revokes the old. (The role already has a `rotate_trust` action to extend.)
- **Revocation** — revoking a node disables both credentials; the agent's next
  call is rejected and the node drops to offline (honest, like meters).

### 3.4 Kubernetes secrets management

- **Configurable backend (decided).** A `secrets.backend` value selects the
  source — `native` (you provision the `Secret`; chart references it via
  `existingSecret`), `externalSecrets` (ESO pulls from Vault / AWS SM / GCP SM /
  Azure KV), or `sealed` (Sealed Secrets committed to git). `existingSecret` is
  always honored regardless of backend.
- **Source every secret from a `Secret`.** Extend the chart so *all* sensitive
  env (DB, admin password, OIDC secret, runner token, the new credential
  **master encryption key**, and any remaining runner SSH/GitHub/become values)
  use `secretKeyRef` — not just DB/postgres.
- **Remove plaintext defaults from `values.yaml`.** Fail-closed in production;
  keep dev defaults only in a clearly-marked `values-dev.yaml` overlay.
- **External Secrets Operator path.** `ExternalSecret` templates gated by
  `secrets.backend=externalSecrets`, materializing the k8s `Secret` from the
  configured store with backend-managed rotation.
- **Sealed Secrets path.** `secrets.backend=sealed` consumes committed
  `SealedSecret`s for clusters without an external store.
- **`RAKKR_ANSIBLE_TARGETS` de-secreted.** Because §3.1 has the runner fetch
  per-node SSH creds from the controller, `TARGETS` no longer carries
  passwords/keys — the single biggest secret-sprawl reduction.
- **Master encryption key** for `node_ssh_credentials` is itself a first-class
  `Secret` (the root of trust); rotation re-encrypts stored keys.

### 3.5 Interface registration — reconciled by the agent on startup

The agent is the source of truth for what hardware exists. On startup (after it
authenticates, alongside its first heartbeat) the agent POSTs its full
discovered inventory and the controller **reconciles** `node.interfaces`:

- **Match by stable identity.** Interfaces are keyed by the agent's deterministic
  id (e.g. `alsa_card_xusb_dev_0`) / `system_ref`, so ids stay stable across
  restarts and existing **channel-map assignments keep resolving**.
- **Agent owns hardware facts.** existence, `channel_count` / channels,
  `system_ref`, `hardware_path`, backend, sample rates, system name/serial are
  upserted from the agent report.
- **Operator owns labels.** custom interface alias + per-channel aliases (and
  channel-map assignments) are preserved across reconcile by stable-id match.
- **Absent interfaces are flagged, not silently dropped.** Devices the agent no
  longer reports are marked `absent` (preserving channel-map history and
  surfacing the change in the UI) rather than hard-deleted; operators can remove
  them.
- **Idempotent + audited.** No diff → no-op; a real change emits a
  `nodes.inventory.reconciled` audit event summarizing added/updated/absent
  interfaces (node-token auth, `node:control`, mirroring the heartbeat).

Endpoint: `POST /api/v1/nodes/:id/inventory` (agent-authenticated). With this in
place **enrollment no longer needs hand-entered interfaces** — they become
optional/advisory and the agent fills the real list on first startup (the
hand-authored seed interface is just a placeholder until first contact). The
day-0 bootstrap (§3.2) carries the same inventory, so a node's interfaces are
correct from its very first registration.

## 4. Data-model & API changes (sketch)

- **DB:** add `node_ssh_credentials` (above); add a short-lived
  `node_bootstrap_tokens` table (`nodeId`, `tokenHash`, `expiresAt`,
  `consumedAt`, `createdByUserId`).
- **API:**
  - `POST /api/v1/nodes/:id/bootstrap-token` (`node:manage`) → issue single-use
    bootstrap token.
  - `POST /api/v1/nodes/:id/bootstrap` (auth: bootstrap token) → accept inventory
    + SSH key material, return controller token. One-shot.
  - `GET /api/v1/nodes/:id/ssh-credential` (runner-scoped auth) → decrypted
    private key for a lifecycle run (audited, never logged).
  - `POST /api/v1/nodes/:id/ssh-credential/rotate` (`node:manage`).
  - `POST /api/v1/nodes/:id/inventory` (node-token auth) → reconcile the node's
    interfaces from the agent's discovered inventory (§3.5); `nodes.enroll`
    interfaces become optional.
- **Agent:** `--bootstrap` mode (keygen, authorized_keys install, bootstrap POST,
  env write, privkey wipe) + **startup inventory reconcile** (§3.5).
- **RBAC/audit:** all privileged actions `node:manage`-gated; bootstrap consume,
  ssh-credential fetch/rotate, and revocation all emit audit events (mirroring
  existing node lifecycle auditing).

## 5. Security considerations

- **Private-key transit (node→controller).** One-time, over TLS, gated by a
  single-use short-TTL bootstrap token, wiped from the node afterward.
  *Alternative:* controller generates the keypair and the node only ever
  receives the **public** key (private key never leaves the controller). Cleaner
  key custody, but needs a channel to place the public key on the node at day-0
  (cloud-init / image bake). **Decision D1.**
- **Encryption at rest.** SSH private keys encrypted with the controller master
  key; tokens stay hashed. Master key lives in a `Secret` now, with KMS/Vault
  envelope encryption as a later upgrade. **Decision D4.**
- **Runner authority.** The runner holds a scoped token that can fetch SSH
  credentials for lifecycle; that token becomes a high-value secret (managed via
  §3.4). Fetches are audited and time-scoped to a run.
- **Bootstrap token.** Short TTL, single-use, `node:manage` to mint, audited on
  consume; replay-safe.

## 6. Rollout / phasing

- **Interface reconcile (independent — can land first). ✅ IMPLEMENTED.** Agent
  reports its discovered inventory on startup (`controller::post_node_inventory`
  in `main`, before the heartbeat loop); the controller reconciles
  `node.interfaces` via `POST /api/v1/nodes/:id/inventory` (node-token auth,
  `node:control`, `apps/api/src/agent-inventory-route.ts` +
  `node-inventory-reconcile.ts`). Interfaces match by stable system ref so
  persisted ids and channel-map assignments survive; operator labels are kept;
  absent devices are flagged via the new `audio_interfaces.absent_at` column
  (migration `0030`); real changes audit `nodes.inventory.reconciled`.
  Enrollment interfaces are now advisory. Covered by API unit/route tests and the
  fake-controller smoke.

- **Phase 1 — Credential store + runner fetch. ✅ IMPLEMENTED.** Added
  `node_ssh_credentials` (migration `0031`) with controller-side ed25519/RSA
  keypair generation + AES-256-GCM encryption at rest under a dedicated master
  key (`RAKKR_NODE_SSH_MASTER_KEY`, falls back to `RAKKR_SECRET_KEY`):
  `node-ssh-credential-crypto.ts` + `node-ssh-credential-store.ts`. Routes
  (`node-ssh-credential-routes.ts`): operator `node:manage` rotate + read (public
  half only), and a runner-scoped `GET /nodes/:id/ssh-credential/material`
  (Bearer `RAKKR_RUNNER_TOKEN`) returning the decrypted key + an optional
  freshly-minted controller token (`?mintToken=1` for deploy actions). `runner.py`
  fetches per-node SSH key + token from the controller when
  `RAKKR_RUNNER_CONTROLLER_URL`/`RAKKR_RUNNER_TOKEN` are set (falling back to
  `RAKKR_ANSIBLE_TARGETS`), and the `recorder_node` role installs the public key
  into the agent user's `authorized_keys`. Private keys are never returned to
  operators or logged. Covered by crypto + route tests. **Rig migration is
  operational:** call the rotate endpoint for `node_x32_test`, place/confirm the
  public key on the rig (or run `rotate_trust`), then drop the SSH key from
  `RAKKR_ANSIBLE_TARGETS`.
- **Phase 2 — Day-0 bootstrap.** Bootstrap tokens + bootstrap endpoint +
  `--bootstrap` agent mode + the `rakkr.org/agent.sh` installer and
  autoinstall / cloud-init templates.
- **Phase 3 — k8s secrets.** secretKeyRef everywhere + `existingSecret` for all,
  remove plaintext defaults, add ESO/Sealed-Secrets support, de-secret `TARGETS`.

## 7. Decisions (resolved)

- **D1 — SSH trust model:** node-generated key, established from the OS install
  up. The node mints its keypair at first boot and hands the private key to the
  controller over TLS; no SSH keys are baked into images, only a one-time
  bootstrap token rides in the provisioning user-data (§3.2).
- **D2 — k8s secrets backend:** configurable. The chart supports `native`
  (`existingSecret`), External Secrets Operator, and Sealed Secrets, selected by
  a `secrets.backend` value (§3.4).
- **D3 — Bootstrap delivery:** in-agent `--bootstrap` mode, invoked by the
  first-boot one-shot wired by autoinstall / cloud-init.
- **D4 — Master key custody:** controller `Secret` now, KMS / Vault envelope
  encryption as a later upgrade.
