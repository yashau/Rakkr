# Rakkr

Rakkr is a centrally managed, Linux/Docker based audio recorder platform for reliable voice recording across managed recorder nodes.

The project source of truth lives in [docs/RAKKR_SOURCE_OF_TRUTH.md](docs/RAKKR_SOURCE_OF_TRUTH.md).

## Stack

| Layer             | Choice                                                          |
| ----------------- | --------------------------------------------------------------- |
| Tooling           | `mise`, `pnpm`, Cargo                                           |
| Controller API    | Hono on Node.js                                                 |
| Controller UI     | React, TanStack Router, TanStack Query, shadcn-style components |
| Database          | Postgres, Drizzle schema package                                |
| Recorder agent    | Rust                                                            |
| Initial transport | Trusted LAN HTTP/WebSocket-ready boundary                       |

## Quick Start

```powershell
mise install
pnpm install
docker compose up -d postgres
pnpm dev
```

Useful URLs:

- Web UI: <http://localhost:5173>
- API health: <http://localhost:8787/healthz>
- Prometheus metrics stub: <http://localhost:8787/metrics>

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
pnpm dev       # API + web UI
pnpm build     # TypeScript packages/apps + Rust agent
pnpm check     # TypeScript checks + Cargo check
pnpm format    # Prettier + cargo fmt
```

## First Hardware Target

The initial recorder test rig is a Debian node at `172.22.145.152` with a Behringer X32 Rack connected over USB.
