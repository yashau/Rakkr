# Rakkr

Rakkr is a centrally managed, Linux/Docker based audio recorder platform for reliable voice recording across managed recorder nodes.

The project source of truth lives in [docs/RAKKR_SOURCE_OF_TRUTH.md](docs/RAKKR_SOURCE_OF_TRUTH.md).

## Stack

| Layer             | Choice                                                          |
| ----------------- | --------------------------------------------------------------- |
| Tooling           | `mise` as the canonical entrypoint for Node.js, pnpm, and Rust  |
| Controller API    | Hono on Node.js                                                 |
| Controller UI     | React, TanStack Router, TanStack Query, shadcn-style components |
| Database          | Postgres, Drizzle schema package                                |
| Recorder agent    | Rust                                                            |
| Initial transport | Encrypted HTTP/WebSocket-ready boundary over trusted LAN        |

`mise` owns workspace setup and repository commands. pnpm, Node.js, Rust, Cargo, Clippy, Miri, Oxlint, and Oxfmt are pinned or invoked through mise tasks.

## Quick Start

```powershell
mise install
mise run install
docker compose up -d postgres
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
mise run dev          # API + web UI
mise run build        # TypeScript packages/apps + Rust agent
mise run check        # LOC, TypeScript, Oxlint, Oxfmt, Cargo, Clippy, Miri
mise run node:format  # Oxfmt for Node/TypeScript files
mise run rust:fmt     # format Rust crates
```

## First Hardware Target

The initial recorder test rig is a Debian node at `172.22.145.152` with a Behringer X32 Rack connected over USB.
