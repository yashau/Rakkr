# Rakkr

Rakkr is a centrally managed, Linux/Docker based audio recorder platform for reliable voice recording across managed recorder nodes.

The project source of truth lives in [docs/RAKKR_SOURCE_OF_TRUTH.md](docs/RAKKR_SOURCE_OF_TRUTH.md).

## Stack

| Layer             | Choice                                                          |
| ----------------- | --------------------------------------------------------------- |
| Tooling           | `mise` as the canonical entrypoint for setup, checks, and builds |
| Controller API    | Hono on Node.js                                                 |
| Controller UI     | React, TanStack Router, TanStack Query, shadcn/ui components    |
| Database          | Postgres, Drizzle schema package                                |
| Recorder agent    | Rust                                                            |
| Initial transport | Encrypted HTTP/WebSocket-ready boundary over trusted LAN        |

`mise` owns every developer-facing workspace command. Install runtimes and dependencies, start local services, run checks, format, build, and launch local development through mise tasks. The commands below are the canonical interface for the repo.

## Quick Start

```powershell
mise trust
mise run setup
mise run services:up
mise run dev
```

Useful URLs:

- Web UI: <http://localhost:5173>
- API health: <http://localhost:8787/healthz>
- Prometheus metrics stub: <http://localhost:8787/metrics>

Local dev sign-in defaults come from `.env.example`:

- Email: `admin@rakkr.local`
- Password: `rakkr-local-dev-password`

Override them with `RAKKR_LOCAL_ADMIN_EMAIL`, `RAKKR_LOCAL_ADMIN_ID`, `RAKKR_LOCAL_ADMIN_PASSWORD`, and `RAKKR_LOCAL_ADMIN_NAME`.

For non-admin local roles, scoped resource access can be seeded with `RAKKR_LOCAL_RESOURCE_GRANTS`, for example `{"node":["node_x32_test"]}`.

## Azure AD OIDC

OIDC is disabled by default. To test Azure AD sign-in:

- In Microsoft Entra App registrations, create a Rakkr app and copy the Application (client) ID and Directory (tenant) ID.
- Add a Web redirect URI matching `RAKKR_OIDC_REDIRECT_URI`, for example `http://localhost:8787/api/v1/auth/oidc/callback` in local dev or the HTTPS controller URL in production.
- Set `RAKKR_OIDC_ENABLED=1`, `RAKKR_OIDC_AZURE_TENANT_ID`, `RAKKR_OIDC_CLIENT_ID`, and optionally `RAKKR_OIDC_CLIENT_SECRET`.
- Keep scopes at `openid profile email` unless group or app-role claims are configured for RBAC sync.

References: [Microsoft identity platform auth code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [redirect URI configuration](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri).

Local cached recording files are served from `RAKKR_RECORDING_CACHE_DIR`, defaulting to `data/recordings`.

Recorder agents authenticate with node credentials, sample ALSA S16_LE PCM for live meter frames by default, post those frames to the controller, and keep a local JSONL health log. Meter behavior is controlled by `RAKKR_METER_BACKEND` (`alsa` or `synthetic`), `RAKKR_METER_SAMPLE_SECONDS`, `RAKKR_METER_CLIP_DBFS`, and `RAKKR_METER_FLATLINE_DBFS`. System health sampling is controlled by `RAKKR_SYSTEM_HEALTH_ENABLED`, `RAKKR_SYSTEM_HEALTH_DISK_PATH`, disk warning/critical percentages, and load warning/critical per-core thresholds. The default log path is `RAKKR_AGENT_HEALTH_LOG_FILE=data/agent/health-events.jsonl`, with size rotation controlled by `RAKKR_AGENT_HEALTH_LOG_MAX_BYTES`.

## Workspace

```text
apps/
  api/                 Hono controller API
  web/                 React controller UI
packages/
  shared/              Shared TypeScript schemas and types
  db/                  Drizzle schema and database contracts
crates/
  recorder-agent/      Rust recorder node agent
docs/
  RAKKR_SOURCE_OF_TRUTH.md
```

## Development Commands

```powershell
mise run setup        # toolchains + workspace dependencies
mise run dev          # API + web UI
mise run services:up  # local Postgres
mise run services:down
mise run build        # TypeScript packages/apps + Rust agent
mise run check        # LOC, Drizzle replay, TypeScript, Oxlint, Oxfmt, Cargo, Clippy, Miri
mise run db:generate  # Drizzle migration generation
mise run db:migrate   # apply Drizzle migrations to Postgres
mise run db:verify    # replay Drizzle migrations against a fresh throwaway database
mise run node:format  # Oxfmt for Node/TypeScript files
mise run rust:fmt     # format Rust crates
```

## First Hardware Target

The initial recorder test rig is a Debian node at `172.22.145.152` with a Behringer X32 Rack connected over USB.

Before the physical interface is ready, a Linux recorder node can fake a capture device with ALSA `snd-aloop`:

```powershell
mise run agent:loopback-smoke        # record a WAV through snd-aloop
mise run agent:loopback-meter-smoke  # sample Rakkr agent meters through snd-aloop
mise run agent:loopback-render-smoke # capture and validate mapped/rendered output
```
