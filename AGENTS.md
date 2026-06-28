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

The product contract lives in `docs/RAKKR_SOURCE_OF_TRUTH.md`. Treat that file
as the authoritative roadmap and status ledger. If implementation, README text,
and the source-of-truth doc disagree, investigate before changing behavior.
Runtime/tool versions should follow the checked config files, especially
`.mise.toml` and CI.

## Stack Summary

- Workspace/task runner: `mise`
- Node runtime: pinned by `.mise.toml`
- Package manager: `pnpm`
- API: Node.js, Hono, Zod, `@hono/node-server`
- Web: React, Vite, TanStack Router, TanStack Query, Tailwind 4, shadcn/ui-style
  local components, lucide-react icons
- Shared contracts: TypeScript schemas in `packages/shared`
- Database: Postgres, Drizzle ORM and Drizzle Kit in `packages/db`
- Recorder agent: Rust workspace crate at `crates/recorder-agent`
- Rust checks: cargo check, rustfmt, clippy, Miri via `mise`
- Lint/format: oxlint, oxlint-tailwindcss, oxfmt
- Recorder node lifecycle: optional Dockerized Ansible runner under
  `deploy/ansible`, called by controller node lifecycle routes and the nodes UI
- Deployment: Docker Compose, API/web/Ansible Dockerfiles, Helm chart under
  `deploy/helm/rakkr-controller`
- Observability: `/metrics`, Prometheus/Mimir examples, Grafana dashboard,
  JSONL/health-event evidence

## Repository Map

```text
apps/api/                 Hono controller API and API tests
apps/web/                 React/Vite operator console and UI helper tests
packages/shared/          Shared TypeScript schemas/contracts
packages/db/              Drizzle schema, migrations, migration verifier
crates/recorder-agent/    Rust recorder node agent
deploy/ansible/           Optional Ansible lifecycle runner, playbooks, role
docs/                     Human documentation; source of truth; internal baselines
fixtures/audio/           Golden speech fixture and metadata
scripts/                  Gate scripts, smoke tests, baseline verifiers
deploy/                   nginx config and Helm chart
```

Important docs:

- `README.md`: human-facing overview and quick start
- `docs/index.md`: documentation home (getting started, architecture, guides,
  reference, operations, contributing)
- `docs/RAKKR_SOURCE_OF_TRUTH.md`: project contract, status, invariants
- `crates/recorder-agent/README.md`: recorder-agent commands and config
- `docs/operations/deployment.md`: Docker Compose and Helm deployment notes
- `docs/observability/README.md`: metrics, alerts, Grafana runbook
- machine-checked baseline docs under `docs/internal/baselines/`, each verified by
  a `scripts/verify-*-baseline.mjs` script (see
  `docs/contributing/baselines.md`)

## Workspace Setup

From the repo root:

```powershell
mise trust
mise run setup
```

`mise run setup` installs the pinned toolchains and then runs `pnpm install`.
The pinned tools currently come from `.mise.toml`; do not hand-edit lockfiles or
tool versions unless the task requires it.

Local environment:

```powershell
Copy-Item .env.example .env
```

Useful defaults from `.env.example`:

- API port: `8787`
- Web port: `5173`
- Database URL: `postgres://rakkr:rakkr@127.0.0.1:5432/rakkr`
- Local admin email: `admin@rakkr.local`
- Local admin password: `rakkr-local-dev-password`
- Recording cache: `data/recordings`

The repository ignores `.env` and `.env.*` except `.env.example`; never commit
local secrets.

## Running Locally

Start Postgres for local development:

```powershell
mise run services:up
```

Run the API and web console:

```powershell
mise run dev
```

Default URLs:

- Web UI: `http://localhost:5173`
- API health: `http://localhost:8787/healthz`
- Metrics: `http://localhost:8787/metrics`
- Ansible runner health: `http://localhost:8790/healthz`

Stop local services:

```powershell
mise run services:down
```

Run the controller as containers instead of local dev servers:

```powershell
docker compose up --build
```

Compose starts Postgres, runs migrations, serves the API on port `8787`, serves
the web console on port `5173`, exposes the optional Ansible runner on port
`8790`, and includes a disposable Debian SSH target named `recorder-test-rig`
for lifecycle smoke validation.

## Database Workflow

Drizzle schema and migrations live in `packages/db`.

Common commands:

```powershell
mise run db:generate
mise run db:migrate
mise run db:verify
```

Rules for migration work:

- Change `packages/db/src/schema.ts` first.
- Generate migrations with `mise run db:generate`.
- Review generated SQL and metadata under `packages/db/drizzle`.
- Run `mise run db:verify`; it replays migrations against a fresh throwaway
  Postgres database.
- Keep generated migration files committed with the schema change.

## Gates And Checks

Use the smallest meaningful gate while iterating, then run the broader gate
before handing off when practical.

Full repository gate:

```powershell
mise run check
```

Build gate:

```powershell
mise run build
```

CI runs:

```powershell
mise trust
mise run install:ci
mise run check
mise run build
```

Targeted Node/TypeScript gates:

```powershell
mise run node:check
mise run node:test
mise run node:lint
mise run node:format-check
mise run node:build
```

Targeted Rust gates:

```powershell
mise run rust:check
mise run rust:fmt-check
mise run rust:clippy
mise run rust:miri
mise run rust:build
```

Formatting:

```powershell
mise run node:format
mise run rust:fmt
```

LOC guard:

```powershell
mise run check:loc
```

The full check is intentionally broad. It includes checked baseline docs,
Drizzle replay, TypeScript checks, Node tests, oxlint, oxfmt check, fake
controller smoke, cargo check, rustfmt check, clippy, and Miri. It may take a
while and requires a working Docker/Postgres setup for the DB verifier.

## Test Notes

API tests:

```powershell
pnpm --filter @rakkr/api test
```

The API test runner sets `RAKKR_API_NO_LISTEN=1`. By default it removes
`DATABASE_URL` unless `RAKKR_API_TEST_DATABASE_URL` is set, so many tests run
against in-memory/fallback stores.

Web tests:

```powershell
pnpm --filter @rakkr/web test
```

Shared/db checks:

```powershell
pnpm --filter @rakkr/shared check
pnpm --filter @rakkr/db check
```

Recorder agent quick commands:

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
cargo run -p rakkr-recorder-agent -- --print-meter-frame
```

Fake-controller smoke:

```powershell
mise run agent:fake-controller-smoke
```

Ansible recorder-node lifecycle smokes:

```powershell
docker compose up -d --build ansible-runner recorder-test-rig
mise run ansible:runner-smoke
```

The local runner smoke deploys the disposable recorder-agent artifact into the
Compose `recorder-test-rig` target, then runs `smoke_check`. For the physical
X32 rig, set `RAKKR_ANSIBLE_SSH_DIR` and `RAKKR_ANSIBLE_TARGETS` as documented
in `deploy/ansible/README.md`, then run:

```powershell
mise run ansible:x32-smoke
```

Linux audio smoke tests exist for ALSA loopback, generic ALSA hardware, X32, and
PCH hardware. These are host/hardware dependent and should not be treated as
portable Windows gates:

```powershell
mise run agent:loopback-smoke
mise run agent:loopback-meter-smoke
mise run agent:loopback-fixture-smoke
mise run agent:loopback-job-smoke
mise run agent:alsa-capture-smoke
mise run agent:alsa-meter-smoke
mise run agent:alsa-job-smoke
```

Run hardware smokes only when the required Linux device or loopback setup is
available.

## Code Style And Conventions

- Follow `.editorconfig`: UTF-8, LF, final newline, trim trailing whitespace,
  two-space indentation except Rust uses four spaces.
- Keep files under the enforced 1000 LOC budget.
- Prefer existing module patterns over new abstractions.
- Use shared TypeScript contracts from `packages/shared` when API and UI need
  the same shapes.
- Preserve server-side authorization. UI visibility must not replace API RBAC
  checks.
- Every privileged action should remain RBAC-gated and audited.
- Store dates as UTC ISO 8601 strings; display browser-local time in the UI
  according to existing helpers.
- Keep generated build output (`dist`, `target`, coverage, Vite output) out of
  commits.
- Do not commit local `.env` files, logs, temporary files, or host-specific
  runtime data.

## API Guidance

- API entrypoint: `apps/api/src/index.ts`.
- Route modules live beside their stores/helpers in `apps/api/src`.
- Tests live under `apps/api/test`.
- Maintain the route pattern of permission checks, action summaries, audit
  events, and scoped resource visibility.
- Keep service-action and denied-attempt audit behavior intact.
- Watch for route families that are mirrored in UI permission boundaries.
- Node lifecycle work lives in `apps/api/src/node-lifecycle.ts` and
  `apps/api/src/node-lifecycle-routes.ts`; keep actions allowlisted,
  `node:manage`-gated, scoped to visible nodes, and audited with runner run IDs,
  exit codes, target hosts, stdout, and stderr.
- If adding new settings, recordings, schedules, health, upload, or node
  behavior, check whether a baseline doc and verifier script also need updates.

## Web Guidance

- Web entrypoint: `apps/web/src/main.tsx`.
- Pages live in `apps/web/src/pages`.
- Shared UI components live in `apps/web/src/components`.
- Low-level shadcn/ui-style primitives live in `apps/web/src/components/ui`.
- Page helper logic and tests live in `apps/web/src/lib`.
- Use TanStack Query for server state and existing API helpers from
  `apps/web/src/lib/api.ts`.
- Preserve permission-aware UI boundaries; do not expose privileged controls
  only because data is present.
- Use lucide-react icons where appropriate and match the quiet operations-console
  style already in the app.
- Keep dense operational screens usable for scanning, filtering, and repeated
  action.
- Recorder-node lifecycle controls live in
  `apps/web/src/components/node-lifecycle-menu.tsx` and call
  `apps/web/src/lib/node-lifecycle-api.ts`; preserve the node-card placement,
  `node:manage` boundary, compact operations-console styling, and accessible
  controls.

## Rust Agent Guidance

- Crate: `crates/recorder-agent`.
- Main entrypoint: `crates/recorder-agent/src/main.rs`.
- Keep ALSA reliable by default while preserving PipeWire/JACK presets and
  synthetic/dev fallback behavior.
- The agent is evidence-oriented: health log entries, controller sync, job state
  transitions, cache cleanup, and failure/recovery events matter.
- Run Rust unit tests/checks plus fake-controller smoke for changes touching
  controller sync, jobs, health, cache, inventory, command templates, or capture
  behavior.
- Use Miri-compatible patterns where existing tests rely on Miri.
- The agent release version is calendar `YYYY.MM.DD-N`, stamped at build time from
  the release tag: the release workflow sets `RAKKR_AGENT_VERSION` and
  `src/version.rs` embeds it via `option_env!` (unstamped dev/CI builds report
  `0.0.0-dev`). It is surfaced through `--version` and inventory `agent_version`.
  Keep `Cargo.toml`'s SemVer `version` separate (calendar versions are not valid
  Cargo SemVer). See `docs/operations/releases.md` for the tag-driven flow.

## Baseline Documentation

Many docs are checked by scripts in `scripts/verify-*-baseline.mjs`. When
behavior changes an invariant, update the matching baseline doc and verifier in
the same slice.

Common baseline gates:

```powershell
mise run auth:check-oidc
mise run security:check-rbac
mise run security:check-transport
mise run scheduler:check
mise run settings:check
mise run recordings:check
mise run health:check-watchdog
mise run storage:check
mise run operations:check
mise run time:check
```

Do not mark source-of-truth status as complete unless code, tests/checks, docs,
and evidence support the promotion.

## Deployment Notes

- `Dockerfile.api` builds the API image and supports migration execution.
- `Dockerfile.web` builds the web console and serves it with nginx.
- `docker-compose.yml` is the local controller stack.
- `deploy/ansible/Dockerfile.runner` builds the optional Ansible lifecycle
  runner image; `deploy/ansible/runner.py` exposes `/healthz` and `POST /runs`.
- `deploy/ansible/playbooks/node-lifecycle.yml` and
  `deploy/ansible/roles/recorder_node` own SSH-target lifecycle work: package
  install/update, recorder binary deployment, systemd unit management, CA trust
  rotation, smoke checks, distro vars, privilege escalation, idempotency, and
  serial rollout.
- Keep lifecycle credentials out of node metadata. Use runner environment such
  as `RAKKR_ANSIBLE_TARGETS`, `RAKKR_ANSIBLE_SSH_DIR`, and mounted key paths
  for per-node SSH settings.
- `update_binary` pulls recorder-agent binaries from GitHub releases by default
  (static musl `x86_64`/`aarch64`, checksum-verified) via
  `deploy/ansible/roles/recorder_node/tasks/update_binary.yml`. `agentVersion`
  pins a full release tag (`agent-v<YYYY.MM.DD-N>`); `RAKKR_ANSIBLE_AGENT_SOURCE=local`
  with `RAKKR_ANSIBLE_BINARY_SRC` is the offline fallback (the Compose smoke uses it).
- `deploy/nginx/default.conf.template` handles web/API proxying for the web
  container.
- `deploy/helm/rakkr-controller` contains Kubernetes resources.
- Releases are tag-driven: pushing a `<component>-v<YYYY.MM.DD-N>` tag triggers that
  component's release workflow; merging to `main` only runs checks. Cut a release
  with `mise run release <agent|docs|controller>`, which computes the next same-day
  counter and pushes the tag. See `docs/operations/releases.md`.
- `.github/workflows/release-agent.yml` builds and publishes recorder-agent release
  binaries (static musl `x86_64` + `aarch64` via `cargo-zigbuild`) on an
  `agent-v<YYYY.MM.DD-N>` tag.
- `.github/workflows/release-docs.yml` deploys `apps/docs` to Cloudflare Workers
  (served at `docs.rakkr.org`) on a `docs-v*` tag (needs `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` secrets).
- `.github/workflows/release-controller.yml` builds and pushes versioned
  `ghcr.io/<repo>-api` and `-web` images on a `controller-v*` tag.
- Read `docs/operations/deployment.md` before changing image, Compose, Helm, or
  migration startup behavior.

## Git And Commit Workflow

Before editing:

```powershell
git status --short --branch
```

This repo may have user changes in progress. Do not revert, overwrite, or
reformat unrelated files. If you must touch a file that already has changes,
inspect it first and keep the final diff scoped to the task.

Before committing:

```powershell
git diff --check
git status --short
```

Run the relevant targeted gates and, when practical, `mise run check` plus
`mise run build`. If a full gate cannot be run, state exactly what was run and
why the full gate was skipped.

Commit guidance:

- Commit only files relevant to the completed slice.
- Keep generated artifacts out of commits unless they are intentional generated
  sources, such as Drizzle migrations.
- Use concise, imperative commit messages, for example:
  `Add recording export audit coverage`.
- If asked to push or open a PR, prefer the current branch unless instructed
  otherwise, and mention any skipped hardware-only smoke tests.

## Agent Operating Principles

- Start with the source of truth, README, nearby code, and tests before making
  architectural assumptions.
- Keep changes narrow and complete: code, tests, docs, and migration/evidence
  updates should travel together.
- Prefer repository tasks over ad hoc commands.
- Use `rg`/`rg --files` for search.
- Do not introduce new frameworks or formatting tools without explicit need.
- Preserve local developer ergonomics on Windows, while remembering the recorder
  agent and audio smokes are Linux-oriented.
- Be explicit in handoff notes about commands run, commands not run, and any
  hardware or service dependencies.
