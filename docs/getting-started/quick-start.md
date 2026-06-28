---
title: Quick start
description: Get a Rakkr controller and console running locally with mise or Docker Compose.
sidebar:
  order: 2
---

# Quick start

This gets a Rakkr controller, console, and database running on your machine.
There are two paths: **local dev servers** (fast iteration) or **Docker Compose**
(a production-shaped stack).

## Prerequisites

Rakkr uses [`mise`](https://mise.jdx.dev/) as its canonical toolchain and task
runner. Tool versions are pinned in [`.mise.toml`](../../.mise.toml):

| Tool | Version |
| ---- | ------- |
| Node | 26.x    |
| pnpm | 11.x    |
| Rust | 1.96    |

You also need **Docker** (for Postgres locally and for the Compose path).

## Path 1 — local dev servers

```powershell
mise trust
mise run setup          # install pinned toolchains + pnpm dependencies
Copy-Item .env.example .env
mise run services:up    # start local Postgres in Docker
mise run dev            # run the controller API and web console together
```

Default surfaces:

| Surface     | URL                             |
| ----------- | ------------------------------- |
| Web console | <http://localhost:5173>         |
| API health  | <http://localhost:8787/healthz> |
| Metrics     | <http://localhost:8787/metrics> |

Sign in with the local admin from [`.env.example`](../../.env.example):

| Field    | Default                    |
| -------- | -------------------------- |
| Email    | `admin@rakkr.local`        |
| Password | `rakkr-local-dev-password` |

Stop the database when you're done:

```powershell
mise run services:down
```

> The web dev server proxies `/api`, `/healthz`, and `/metrics` to the API on
> port 8787, so the browser talks to a single origin with no CORS setup.

## Path 2 — Docker Compose

Run the whole controller stack as containers:

```powershell
docker compose up --build
```

This starts Postgres, runs Drizzle migrations once, serves the API on `8787` and
the web console on `5173`, exposes the optional Ansible runner health endpoint on
`8790`, and includes a disposable Debian SSH target (`recorder-test-rig`) for
node-lifecycle smoke validation.

See [Deployment](../operations/deployment.md) for the full service list, image
build details, and the Helm chart for Kubernetes.

## Running without a database

The controller is designed to run **without `DATABASE_URL`**. When it is unset,
each store falls back to seeded in-memory or JSON-file data, which is how most of
the API test suite runs. Set `DATABASE_URL` to switch to Postgres. See the
[data model](../architecture/data-model.md) for the toggle details.

## Adding a recorder agent

The controller seeds demo nodes so you can explore the console immediately. To
run a real recorder agent against your local controller:

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory   # see what hardware it finds
cargo run -p rakkr-recorder-agent -- `
  --allow-insecure-controller `
  --controller-url http://127.0.0.1:8787 `
  --controller-token <node-token> `
  --node-id node_local_dev
```

Get a node token by enrolling a node in the console (**Nodes → Enroll Recorder
Node**, requires `node:manage`). The recorder agent is Linux-oriented for real
capture; on Windows/macOS use `--print-inventory` / `--print-meter-frame` and the
synthetic meter fallback to explore it. Full details:
[Recorder agent CLI](../reference/recorder-agent.md).

## What to do next

- Take the [tour of core concepts](concepts.md).
- Read the [architecture overview](../architecture/overview.md).
- Start a recording: [Recording guide](../guides/recording.md).
