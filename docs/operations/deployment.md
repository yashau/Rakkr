---
title: Deployment
description: Deploy the Rakkr controller with Docker Compose or Helm, and run the optional Ansible node-lifecycle runner.
sidebar:
  order: 1
---

# Deployment

Rakkr ships a deployable controller stack:

- `Dockerfile.api` — the Hono controller API (also runs Drizzle migrations).
- `Dockerfile.web` — the React console served by nginx.
- `docker-compose.yml` — a local controller stack with Postgres.
- `deploy/ansible` — the optional recorder-node lifecycle runner.
- `deploy/helm/rakkr-controller` — the Kubernetes chart.

All controller environment variables are documented in the
[configuration reference](../reference/configuration.md).

## Docker Compose

```powershell
docker compose up --build
```

The stack starts these services:

| Service              | Purpose                                                        | Port   |
| -------------------- | -------------------------------------------------------------- | ------ |
| `postgres`           | Controller database (`postgres:17-alpine`).                    | `5432` |
| `controller-migrate` | One-shot Drizzle migration runner; runs before the API starts. | —      |
| `controller-api`     | Controller API + `/metrics`.                                   | `8787` |
| `controller-web`     | React console served by nginx, proxying the API.               | `5173` |
| `ansible-runner`     | Optional node-lifecycle runner.                                | `8790` |
| `recorder-test-rig`  | Disposable Debian SSH target for lifecycle smokes.             | `2222` |

The web container proxies `/api`, `/healthz`, and `/metrics` to the API, so
browser traffic uses a single origin. Migrations run once in `controller-migrate`
(the API waits for it to complete) — both use the API image, which carries the
Drizzle tooling.

Default local sign-in is `admin@rakkr.local` / `rakkr-local-dev-password`.
Override before starting:

```powershell
$env:RAKKR_LOCAL_ADMIN_PASSWORD = "replace-me"
$env:RAKKR_WEB_ORIGIN = "http://localhost:5173"
docker compose up --build
```

Stop, or remove volumes:

```powershell
docker compose down
docker compose down --volumes
```

## The images

**`Dockerfile.api`** — multi-stage on `node:26-alpine` (pnpm 11.9.0): install deps,
build `@rakkr/shared` + `@rakkr/db` + `@rakkr/api`, then a runtime stage that
installs `ffmpeg`, copies the build plus the committed `packages/db/drizzle`
migrations, runs as non-root, exposes `8787`, and starts the API. Because it
includes migration tooling, the same image runs migrations.

**`Dockerfile.web`** — multi-stage build of `@rakkr/shared` + `@rakkr/web` (Vite),
then an `nginx:1.29-alpine` runtime that serves the SPA and env-substitutes
`deploy/nginx/default.conf.template`. That template serves the SPA with
`try_files … /index.html` and reverse-proxies `/api/`, `/healthz`, and `/metrics`
to `${RAKKR_API_UPSTREAM}` (default `http://controller-api:8787`).

## Optional Ansible node lifecycle

The controller can request allowlisted node-lifecycle actions through the
Dockerized Ansible runner. Compose wires `controller-api` to it with
`RAKKR_ANSIBLE_RUNNER_URL=http://ansible-runner:8790`; the runner exposes
`POST /runs` internally and a health endpoint at
<http://localhost:8790/healthz>.

Supported actions: `install_dependencies`, `update_binary`, `restart_service`,
`rotate_trust`, `smoke_check`. For local smoke validation, Compose also starts
`recorder-test-rig` and maps the seeded `node_x32_test` record to it without
touching real metadata.

For a physical rig, mount your SSH directory into the runner and provide per-node
targets:

```powershell
$env:RAKKR_ANSIBLE_SSH_DIR = "$env:USERPROFILE\.ssh"
$env:RAKKR_ANSIBLE_TARGETS = '{"node_x32_test":{"host":"172.22.145.152","sshUser":"root","sshKeyFile":"/run/rakkr-ssh/id_ed25519","smokeCommand":"/tmp/rakkr-recorder-agent --print-inventory"}}'
docker compose up -d --build ansible-runner
mise run ansible:x32-smoke
```

`mise run ansible:x32-smoke` runs a safe `smoke_check` (no binary deploy). Use
`update_binary` only after `RAKKR_ANSIBLE_BINARY_SRC` points at a real Linux
recorder-agent artifact. Full details: [Node lifecycle](../guides/node-lifecycle.md)
and `deploy/ansible/README.md`.

### Recorder-agent release binaries

The recorder-agent is versioned `YYYY.MM.DD-N` from
`crates/recorder-agent/VERSION`; bumping that file and merging to `main` runs the
`Release recorder agent` workflow (`.github/workflows/release-agent.yml`), which
builds static musl binaries for `x86_64-unknown-linux-musl` and
`aarch64-unknown-linux-musl` and publishes a GitHub release tagged with the
version (each with a `.sha256`). The static musl build runs on Debian and RedHat
nodes without a glibc version dependency.

The Ansible `update_binary` action pulls these releases automatically: the target
node downloads the artifact for its architecture, verifies the checksum, and
installs it. It defaults to the newest release; forward `agentVersion` to pin a
specific tag. Set `RAKKR_ANSIBLE_AGENT_SOURCE=local` with
`RAKKR_ANSIBLE_BINARY_SRC` only for air-gapped or offline staging. See
[Node lifecycle](../guides/node-lifecycle.md) and the
[recorder-agent README](https://github.com/yashau/Rakkr/blob/main/crates/recorder-agent/README.md)
for the bump-and-release flow.

## Helm (Kubernetes)

The chart is `deploy/helm/rakkr-controller`. Build and publish the two images:

```powershell
docker build -f Dockerfile.api -t registry.example.com/rakkr/controller-api:0.1.0 .
docker build -f Dockerfile.web -t registry.example.com/rakkr/controller-web:0.1.0 .
docker push registry.example.com/rakkr/controller-api:0.1.0
docker push registry.example.com/rakkr/controller-web:0.1.0
```

Install with the bundled Postgres StatefulSet:

```powershell
helm upgrade --install rakkr deploy/helm/rakkr-controller `
  --set api.image.repository=registry.example.com/rakkr/controller-api `
  --set api.image.tag=0.1.0 `
  --set web.image.repository=registry.example.com/rakkr/controller-web `
  --set web.image.tag=0.1.0
```

Enable ingress (it routes to the web service, which proxies the API):

```powershell
helm upgrade --install rakkr deploy/helm/rakkr-controller `
  --set ingress.enabled=true `
  --set ingress.hosts[0].host=rakkr.example.com `
  --set ingress.hosts[0].paths[0].path=/ `
  --set ingress.hosts[0].paths[0].pathType=Prefix `
  --set api.env.RAKKR_WEB_ORIGIN=https://rakkr.example.com `
  --set api.env.RAKKR_OIDC_REDIRECT_URI=https://rakkr.example.com/api/v1/auth/oidc/callback
```

Use an external database instead of the bundled Postgres:

```powershell
helm upgrade --install rakkr deploy/helm/rakkr-controller `
  --set postgres.enabled=false `
  --set database.externalUrl=postgres://user:password@postgres.example.com:5432/rakkr
```

For production, prefer a values file or Kubernetes Secret for sensitive values:

```yaml
database:
  existingSecret:
    name: rakkr-database
    key: DATABASE_URL

api:
  secretEnv:
    RAKKR_LOCAL_ADMIN_PASSWORD: replace-me
    RAKKR_OIDC_CLIENT_SECRET: replace-me
```

### What the chart deploys

API and web Deployments + Services, an API PVC (`/var/lib/rakkr`), a ConfigMap
(non-secret API env), a Secret (`DATABASE_URL` + `secretEnv`), a ServiceAccount,
an optional Ingress, an optional migration Job, and — when `postgres.enabled=true`
— a Postgres StatefulSet/Service/Secret.

Migrations run in an API **init container** by default (`api.migrateOnStartup=true`,
after a `wait-for-database` probe). For controlled release pipelines, set
`api.migrateOnStartup=false` and enable the separate Job with
`migrations.job.enabled=true`. Key values include `api.image`/`web.image`,
`api.replicaCount`, `api.service.port`, `api.persistence`, `api.env`/`api.secretEnv`,
`postgres.auth`/`postgres.enabled`, `database.externalUrl`/`existingSecret`, and
`ingress.*`.
