# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Summary

Rakkr is a centrally managed Linux audio recording platform for reliable room
recording. It combines:

- a Hono controller API for auth, RBAC, audit, nodes, recordings, jobs,
  schedules, settings, uploads, health, and metrics;
- a React operations console for operators;
- a Rust recorder agent that runs on Linux audio nodes, captures audio, samples
  meters, manages local cache, writes health evidence, and syncs with the
  controller;
- Postgres and Drizzle for controller persistence;
- baseline documentation plus verification scripts for product invariants.

The product contract lives in `docs/RAKKR_SOURCE_OF_TRUTH.md`; treat it as the
authoritative roadmap and status ledger. If implementation, README text, and the
source-of-truth doc disagree, investigate before changing behavior. Runtime/tool
versions follow the checked config files, especially `.mise.toml` and CI.

## Stack Summary

- Workspace/task runner: `mise`; Node runtime pinned by `.mise.toml`; package
  manager `pnpm`.
- API: Node.js, Hono, Zod, `@hono/node-server`.
- Web: React, Vite, TanStack Router, TanStack Query, Tailwind 4, shadcn/ui-style
  local components on Base UI (`@base-ui/react`), lucide-react icons.
- Docs site: Astro + Starlight in `apps/docs` (renders repo-root `docs/`).
- Shared contracts: TypeScript schemas in `packages/shared`.
- Database: Postgres, Drizzle ORM and Drizzle Kit in `packages/db`.
- Recorder agent: Rust workspace crate at `crates/recorder-agent` (cargo check,
  rustfmt, clippy, Miri via `mise`).
- Lint/format: oxlint, oxlint-tailwindcss, oxfmt.
- Recorder node lifecycle: optional Dockerized Ansible runner under
  `deploy/ansible`, called by controller node lifecycle routes and the nodes UI.
- Deployment: Docker Compose, API/web/Ansible Dockerfiles, Helm chart under
  `deploy/helm/rakkr-controller`.
- Observability: `/metrics`, Prometheus/Mimir examples, Grafana dashboard,
  JSONL/health-event evidence.

## Repository Map

```text
apps/api/                 Hono controller API and API tests
apps/web/                 React/Vite operator console and UI helper tests
apps/docs/                Astro/Starlight docs site (renders docs/, served at docs.rakkr.org)
packages/shared/          Shared TypeScript schemas/contracts
packages/db/              Drizzle schema, migrations, migration verifier
crates/recorder-agent/    Rust recorder node agent
deploy/ansible/           Optional Ansible lifecycle runner, playbooks, role
deploy/bootstrap/         Day-0 one-liner installer (agent.sh) + cloud-init
deploy/nginx/             nginx config for the web container
deploy/helm/              Helm chart (rakkr-controller)
docs/                     Human documentation; source of truth; internal baselines
fixtures/audio/           Golden speech fixture and metadata
scripts/                  Gate scripts, smoke tests, baseline verifiers
```

Key docs: `README.md` (overview/quick start); `docs/index.md` (documentation
home); `docs/RAKKR_SOURCE_OF_TRUTH.md` (contract, status, invariants);
`crates/recorder-agent/README.md`; `docs/operations/deployment.md`;
`docs/observability/README.md`; machine-checked baselines under
`docs/internal/baselines/`, each verified by a `scripts/verify-*-baseline.mjs`
script (see `docs/contributing/baselines.md`).

## Setup And Local Dev

From the repo root:

```powershell
mise trust
mise run setup                 # installs pinned toolchains, then pnpm install
Copy-Item .env.example .env
```

Do not hand-edit lockfiles or tool versions unless the task requires it. `.env`
and `.env.*` (except `.env.example`) are git-ignored — never commit local
secrets. Useful `.env.example` defaults: API `8787`, Web `5173`, DB
`postgres://rakkr:rakkr@127.0.0.1:5432/rakkr`, admin `admin@rakkr.local` /
`rakkr-local-dev-password`, recording cache `data/recordings`.

Run locally:

```powershell
mise run services:up           # Postgres
mise run dev                   # API + web console
mise run services:down
```

URLs: web `http://localhost:5173`, API health `:8787/healthz`, metrics
`:8787/metrics`, Ansible runner `:8790/healthz`. `docker compose up --build`
runs the full controller stack instead (Postgres, migrations, API `8787`, web
`5173`, Ansible runner `8790`, and a disposable Debian SSH target
`recorder-test-rig` for lifecycle smokes).

## Database Workflow

Schema and migrations live in `packages/db`. `src/schema.ts` is a re-export
barrel; tables live in per-subsystem modules under `packages/db/src/schema/`.

- Edit the matching table module under `packages/db/src/schema/` first
  (re-exported by `schema.ts`; `drizzle.config.ts` reads `schema.ts`).
- `mise run db:generate`, review the SQL/metadata under `packages/db/drizzle`,
  then `mise run db:verify` (replays migrations against a throwaway Postgres).
- Commit generated migration files with the schema change.

## Gates And Checks

Use the smallest meaningful gate while iterating; run the broader gate before
handing off when practical.

```powershell
mise run check                 # full repo gate (broad, slow; db:verify needs Docker/Postgres)
mise run build                 # build gate
# targeted:
mise run node:check | node:test | node:lint | node:format-check | node:build
mise run rust:check | rust:fmt-check | rust:clippy | rust:miri | rust:build
mise run node:format           # apply formatting (also: rust:fmt)
mise run check:loc             # 1000-LOC-per-file guard
```

CI runs `mise trust && mise run install:ci && mise run check && mise run build`.
The full `check` includes checked baseline docs, Drizzle replay, TypeScript,
Node tests, oxlint, oxfmt, fake-controller smoke, cargo check, rustfmt, clippy,
and Miri.

## Test Notes

```powershell
pnpm --filter @rakkr/api test      # sets RAKKR_API_NO_LISTEN=1; drops DATABASE_URL
                                   #   unless RAKKR_API_TEST_DATABASE_URL is set
pnpm --filter @rakkr/web test
pnpm --filter @rakkr/shared check
pnpm --filter @rakkr/db check
mise run agent:fake-controller-smoke
```

API/web tests are discovered by glob (`test/**/*.test.ts`); co-locate shared
setup/helpers in non-`.test.ts` modules so the runner ignores them. Recorder
quick checks: `cargo run -p rakkr-recorder-agent -- --print-inventory` (or
`--print-meter-frame`).

Ansible lifecycle smoke: `docker compose up -d --build ansible-runner
recorder-test-rig` then `mise run ansible:runner-smoke` (deploys the disposable
artifact into `recorder-test-rig`, runs `smoke_check`). Physical X32: set
`RAKKR_ANSIBLE_SSH_DIR` and `RAKKR_ANSIBLE_TARGETS` (see
`deploy/ansible/README.md`), then `mise run ansible:x32-smoke`.

Linux-audio smokes (`agent:loopback-*`, `agent:alsa-*`) are host/hardware
dependent — run only when the required Linux device/loopback exists; they are
not portable Windows gates.

## Code Style And Conventions

- Follow `.editorconfig`: UTF-8, LF, final newline, trim trailing whitespace,
  two-space indentation (Rust uses four).
- Keep files under the enforced **1000 LOC budget** (`check:loc`). Oversized
  modules are split into domain sub-modules re-exported from a slim barrel (e.g.
  `packages/shared/src/index.ts`, `packages/db/src/schema.ts`,
  `apps/api/src/index.ts`, `crates/recorder-agent/src/inventory.rs`); add new
  code to the matching sub-module, not the barrel.
- Prefer existing module patterns over new abstractions. Share shapes via
  `packages/shared` contracts when API and UI need the same types.
- Preserve server-side authorization — UI visibility must not replace API RBAC.
  Every privileged action stays RBAC-gated and audited.
- Store dates as UTC ISO 8601 strings; display browser-local time via existing
  helpers.
- Keep generated output (`dist`, `target`, coverage, Vite output), local `.env`,
  logs, and temporary/host-specific data out of commits.

## API Guidance

- Entrypoint `apps/api/src/index.ts` is a thin composition root: it builds the
  stores and helper factories (`index-authorization.ts` for the audit/permission
  closures, `index-readiness.ts` for the `/readyz` probe, `index-scoped-resources.ts`,
  `resource-scope-targets.ts`) and mounts the route modules. Route modules live
  beside their stores/helpers in `apps/api/src`; tests under `apps/api/test`.
- Keep the route pattern: permission check → action summary → audit event →
  scoped resource visibility. Preserve service-action and denied-attempt audits,
  and watch for route families mirrored in UI permission boundaries.
- Node lifecycle (`node-lifecycle.ts`, `node-lifecycle-routes.ts`): actions
  allowlisted, `node:manage`-gated, scoped to visible nodes, audited with runner
  run IDs, exit codes, target hosts, stdout, and stderr.
- Node onboarding/credentials/secrets are one subsystem (controller is the system
  of record). SSH keys live in `node_ssh_credentials`, encrypted at rest via
  `node-ssh-credential-crypto.ts`/`node-ssh-credential-store.ts` (master key
  `RAKKR_NODE_SSH_MASTER_KEY`, falling back to `RAKKR_SECRET_KEY`); day-0 bootstrap
  tokens in `node_bootstrap_tokens`/`node-bootstrap-store.ts`. Invariants (in
  `node-ssh-credential-routes.ts`, `node-bootstrap-routes.ts`, `agent-inventory-route.ts`):
  private keys are **never** returned to operators or logged; the runner-scoped
  `…/ssh-credential/material` fetch and the bootstrap endpoint use token auth (not
  user sessions); bootstrap tokens are single-use + atomic-consume; startup
  inventory reconcile preserves operator labels + channel-maps and flags absent
  interfaces. See `docs/guides/node-onboarding.md`.
- Uploads to external storage are **controller-only** — the recorder agent never
  touches SMB/S3. The agent uploads renditions to the controller cache
  (`…/recordings/:id/cache-file`); the controller's **upload runner**
  (`upload-runner.ts`) is the only writer to object storage. Operators define
  named **destinations** (`upload_destinations`, secrets encrypted via
  `RAKKR_SECRET_KEY`); **upload policies** each select one destination plus an
  optional subfolder. Schedules and recordings carry a *list* of policy ids
  (`uploadPolicyIds`), so one recording fans out to independent queue items,
  reconciled to `uploaded` (all ok) or `partial` (some failed). Execution is
  direct SMB 2.1/3.x + S3 (no mounts, no external binaries), checksum-verified;
  controller-cache retention runs only after a confirmed upload.
  `upload_providers`/`uploadPolicyId`/`provider`/`target` are legacy backfill
  columns. See `docs/guides/storage-and-uploads.md`.
- Rooms are a first-class entity (`rooms` table; `room-routes.ts`). The stable
  `roomId` is the source of truth for room identity and RBAC scope; `nodes.roomId`
  (SET NULL) and `schedules.roomId` (RESTRICT) bind resources to it, with legacy
  `location`/`room` columns retained only for display. Identity CRUD is
  `node:read`/`node:manage`; the per-room **roster** is `auth:manage`
  (`GET`/`PUT /api/v1/rooms/:roomId/roster`). Roster entries grant per-action
  capabilities (`packages/shared/src/room-capabilities.ts`:
  view/listen/download/operate/book/edit/delete) that map onto catalog permissions
  **only when the request target resolves to that room** — no new global
  permissions, and node/settings/credential permissions stay role-based. Schedule
  assignments auto-populate the roster as `source="calendar"` entries (default caps
  `[view, operate]`), reconciled when schedules change.
- Access groups are first-party (`access_groups`/`user_access_groups`), managed
  under `auth:manage` at `/api/v1/auth/groups` (`auth-group-routes.ts`, mounted via
  `auth-management-routes.ts`). The `id` is a server-derived immutable slug
  (`accessGroupSlug`); the group is assignable to schedules (`assignedGroupIds`),
  room rosters, and access policies, and deleting it cascade-cleans all three. OIDC
  group claims sync into the same store.
- Switcher routing is controller-only under `/api/v1/settings/switchers`
  (`switcher-routes.ts`) with mappings under `.../:id/mappings`
  (`switcher-mapping-routes.ts`); the modular driver layer lives in
  `apps/api/src/switchers` (+ `avpro-ac-max.ts`). The control-channel password
  (`switchers.secrets.password`) is encrypted via secret-box AES-256-GCM
  (`secret-box.ts`, keyed by `RAKKR_SECRET_KEY`) and never returned to the console.
  The reconcile runner (`switcher-routing-runner.ts`, default 20s) has
  `disabled`/`observe`/`enforce` modes, enforces owned-outputs-only +
  live-meeting-only, and opens a `switcher.unreachable` health event on failure.
  Permissions: `switcher:read`, `switcher:map`, `switcher:manage`.
- Schedule calendar/occurrences live in `schedule-occurrence-routes.ts`:
  `GET /api/v1/schedules/calendar` (`schedule:read`) and
  `POST /api/v1/schedules/:scheduleId/move-occurrence` (`schedule:manage`). Moving a
  recurring instance skips it (recurrence skip exception) and clones a
  duration-preserving one-off; the original series rolls back if the clone fails.
- Adding settings, recordings, schedules, health, upload, or node behavior? Check
  whether a baseline doc and verifier script also need updating (see Baselines).

## Web Guidance

- Entrypoint `apps/web/src/main.tsx`. Pages in `src/pages`; shared components in
  `src/components`; shadcn/ui-style primitives in `src/components/ui`; page helpers
  and their tests in `src/lib`. Use TanStack Query for server state and the API
  helpers in `src/lib/api.ts`.
- Preserve permission-aware boundaries — do not expose privileged controls just
  because data is present. Match the quiet operations-console style (lucide-react
  icons); keep dense screens usable for scanning, filtering, and repeated action.
- Dark mode is wired via `next-themes` (`ThemeProvider` in `main.tsx`,
  `theme-toggle.tsx`, `theme-helpers.ts`); style with tokens or `dark:` variants,
  never light-only colors.
- Recorder-node lifecycle controls live in `components/node-lifecycle-menu.tsx`
  and call `lib/node-lifecycle-api.ts`; preserve node-card placement, the
  `node:manage` boundary, compact styling, and accessible controls.
- Rooms have a list page (`rooms.tsx`) and a detail page (`room-detail.tsx` —
  editable name/location/notes, node inventory, upcoming occurrences, recent
  recordings, `room-roster-editor.tsx`). The calendar view is at
  `/schedules/calendar` (`schedules-calendar.tsx`). The Settings page
  (`settings.tsx`) has a **Switchers** section and a "Week starts on" selector
  (`weekStartsOn`). A shared searchable user/group picker (`subject-combobox.tsx`,
  `group-multi-select.tsx`, `user-multi-select.tsx`, `assignee-multi-select.tsx`) is
  reused across schedules, room rosters, and the access-policy composer.
- **Playwright is the canonical way to screenshot** the console (docs imagery, PR
  evidence, visual checks) — drive the running app; do not hand-craft or mock UI
  images.

## Rust Agent Guidance

- Crate `crates/recorder-agent`; entrypoint `src/main.rs`. Oversized modules are
  split into sub-module directories re-exported from a facade (e.g. `inventory.rs`
  over `inventory/{alsa,runtime,net}.rs`).
- Keep ALSA reliable by default while preserving PipeWire/JACK presets and
  synthetic/dev fallback. The agent is evidence-oriented: health log entries,
  controller sync, job state transitions, cache cleanup, and failure/recovery
  events matter. Run Rust unit tests/checks plus the fake-controller smoke for
  changes touching controller sync, jobs, health, cache, inventory, command
  templates, or capture. Gate filesystem/`Command`-touching tests with
  `#[cfg_attr(miri, ignore)]`.
- On startup the agent reconciles discovered interfaces with the controller
  (`controller::post_node_inventory`, before the heartbeat loop) — it owns hardware
  truth. `src/bootstrap.rs` is the one-shot `--bootstrap` day-0 mode (ssh-keygen
  keypair, `authorized_keys` install, bootstrap POST, env-file token write,
  private-key wipe); it shells to `ssh-keygen` and must stay Windows-compilable
  (guard unix-only code with `#[cfg(unix)]`). `deploy/bootstrap/agent.sh` mirrors
  the `recorder_node` install layout — keep them in sync.
- Voice enhancement is in-process (`src/enhance.rs`: DeepFilterNet3 or RNNoise;
  `enhanced_render::render_enhanced_output`). The agent uploads **both renditions
  to the controller** via `PUT /api/v1/recordings/:id/cache-file?rendition=enhanced|raw`
  (`recording_job_upload.rs`): enhanced is the primary that completes the job; raw
  is a supplementary upload sent only when the primary succeeds and the profile's
  `keepRaw` is set. The agent never pushes to SMB/S3. Configured per recording
  profile (`packages/shared/src/enhancement.ts`); raw always preserved; engine
  tests excluded under Miri. See `docs/guides/audio-enhancement.md`.
- The agent release version is calendar `YYYY.MM.DD-N`, stamped at build time from
  the release tag (`RAKKR_AGENT_VERSION` → `src/version.rs` via `option_env!`;
  dev/CI builds report `0.0.0-dev`), surfaced through `--version` and inventory
  `agent_version`. Keep `Cargo.toml`'s SemVer `version` separate. See
  `docs/operations/releases.md`.

## Baseline Documentation

Many docs are machine-checked by `scripts/verify-*-baseline.mjs`. When a change
touches an invariant, update the matching baseline doc **and** its verifier in the
same slice.

Each verifier scans a hardcoded list of source/test files for required snippets
(some also assert the baseline doc references those paths). If you move, rename, or
split a tracked file, update the verifier's file list — and the baseline doc's
referenced paths where enforced — or the check breaks.

Common gates: `auth:check-oidc`, `security:check-rbac`, `security:check-transport`,
`scheduler:check`, `settings:check`, `recordings:check`, `recordings:check-first-reliable`,
`health:check-watchdog`, `storage:check`, `operations:check`, `time:check`,
`switcher:check`, `devices:check-generic`. Do not mark source-of-truth status
complete unless code, checks, docs, and evidence support it.

## Deployment Notes

- Images: `Dockerfile.api` (API, supports migration execution), `Dockerfile.web`
  (web via nginx; `deploy/nginx/default.conf.template` proxies web/API).
  `docker-compose.yml` is the local stack; `deploy/helm/rakkr-controller` holds the
  Kubernetes resources.
- Ansible: `deploy/ansible/Dockerfile.runner` builds the runner (`runner.py`
  exposes `/healthz`, `POST /runs`). `playbooks/node-lifecycle.yml` +
  `roles/recorder_node` own SSH-target lifecycle work (package install/update,
  binary deploy, systemd units, CA trust rotation, smoke checks, distro vars,
  privilege escalation, idempotency, serial rollout). Keep lifecycle credentials
  out of node metadata — preferred: point the runner at the controller
  (`RAKKR_RUNNER_CONTROLLER_URL` + `RAKKR_RUNNER_TOKEN`) so it fetches per-node SSH
  keys/tokens at run time; the env path (`RAKKR_ANSIBLE_TARGETS`,
  `RAKKR_ANSIBLE_SSH_DIR`, mounted keys) is the fallback.
- `deploy/bootstrap/agent.sh` is the day-0 one-liner installer (published at
  `rakkr.org/agent.sh`, with `cloud-init.yaml`); it shares the `recorder_node`
  install layout and runs `--bootstrap`. Keep them in sync.
- Helm sources every controller secret from one app `Secret` via `secrets.backend`
  (`native`/`externalSecrets`/`sealed`, plus `appSecret.existingSecret`);
  `values.yaml` ships no plaintext secret defaults (dev values in `values-dev.yaml`).
  New controller secrets (e.g. `RAKKR_NODE_SSH_MASTER_KEY`, `RAKKR_RUNNER_TOKEN`) go
  in `api.secretEnv`. Validate with `helm template` across backends.
- `update_binary` pulls recorder-agent binaries from GitHub releases (static musl
  `x86_64`/`aarch64`, checksum-verified; `roles/recorder_node/tasks/update_binary.yml`).
  `agentVersion` pins a full tag (`agent-v<YYYY.MM.DD-N>`);
  `RAKKR_ANSIBLE_AGENT_SOURCE=local` + `RAKKR_ANSIBLE_BINARY_SRC` is the offline
  fallback (the Compose smoke uses it).
- Releases are tag-driven: pushing `<component>-v<YYYY.MM.DD-N>` triggers that
  component's release workflow; merging to `main` only runs checks. Cut with
  `mise run release <agent|docs|controller>`. Workflows: `release-agent.yml` (musl
  x86_64 + aarch64 via cargo-zigbuild), `release-docs.yml` (Cloudflare Workers,
  `docs.rakkr.org`; needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`),
  `release-controller.yml` (`ghcr.io/<repo>-api` + `-web`). Read
  `docs/operations/deployment.md` before changing image/Compose/Helm/migration
  startup behavior.

## Git And Commit Workflow

- Run `git status --short --branch` first — the repo may have user changes in
  progress; do not revert, overwrite, or reformat unrelated files, and keep the
  final diff scoped.
- Before committing: `git diff --check` and `git status --short`; run the relevant
  targeted gates (and `mise run check` / `build` when practical). If a full gate
  cannot run, state exactly what ran and why.
- Commit only files for the completed slice; keep generated artifacts out of
  commits except intentional generated sources such as Drizzle migrations. Use
  concise, imperative commit messages (e.g. `Add recording export audit coverage`).
  If asked to push or open a PR, prefer the current branch unless instructed
  otherwise, and mention any skipped hardware-only smoke tests.

## Agent Operating Principles

- Start with the source of truth, README, nearby code, and tests before making
  architectural assumptions.
- Keep changes narrow and complete: code, tests, docs, and migration/evidence
  updates travel together.
- Prefer repository tasks over ad hoc commands; use `rg`/`rg --files` for search.
- Do not introduce new frameworks or formatting tools without explicit need.
- Preserve Windows dev ergonomics while remembering the recorder agent and audio
  smokes are Linux-oriented.
- Be explicit in handoff notes about commands run, commands not run, and any
  hardware or service dependencies.
