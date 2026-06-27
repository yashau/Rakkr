# Rakkr Controller Deployment

Rakkr ships a deployable controller stack with:

- `Dockerfile.api` for the Hono controller API and Drizzle migrations.
- `Dockerfile.web` for the React console served by nginx.
- `docker-compose.yml` for a local controller stack with Postgres.
- `deploy/helm/rakkr-controller` for Kubernetes installs.

## Docker Compose

Build and run the controller stack:

```powershell
docker compose up --build
```

Compose starts:

| Service              | Purpose                           | Local URL                       |
| -------------------- | --------------------------------- | ------------------------------- |
| `postgres`           | Controller database               | `localhost:5432`                |
| `controller-migrate` | One-shot Drizzle migration runner | n/a                             |
| `controller-api`     | Controller API and metrics        | <http://localhost:8787/healthz> |
| `controller-web`     | Web console and API proxy         | <http://localhost:5173>         |

The web container proxies `/api`, `/healthz`, and `/metrics` to the API
container, so browser traffic can use the web origin.

Default local sign-in:

| Field    | Value                      |
| -------- | -------------------------- |
| Email    | `admin@rakkr.local`        |
| Password | `rakkr-local-dev-password` |

Override deployment values with environment variables before running Compose:

```powershell
$env:RAKKR_LOCAL_ADMIN_PASSWORD = "replace-me"
$env:RAKKR_WEB_ORIGIN = "http://localhost:5173"
docker compose up --build
```

Stop the stack:

```powershell
docker compose down
```

Remove local controller and Postgres volumes:

```powershell
docker compose down --volumes
```

## Helm

Build and publish images for your registry:

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

Enable ingress with explicit host/path settings:

```powershell
helm upgrade --install rakkr deploy/helm/rakkr-controller `
  --set ingress.enabled=true `
  --set ingress.hosts[0].host=rakkr.example.com `
  --set ingress.hosts[0].paths[0].path=/ `
  --set ingress.hosts[0].paths[0].pathType=Prefix `
  --set api.env.RAKKR_WEB_ORIGIN=https://rakkr.example.com `
  --set api.env.RAKKR_OIDC_REDIRECT_URI=https://rakkr.example.com/api/v1/auth/oidc/callback
```

Use an external database:

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

Then apply it:

```powershell
helm upgrade --install rakkr deploy/helm/rakkr-controller -f values.production.yaml
```

The API deployment runs migrations in an init container by default
(`api.migrateOnStartup=true`). For controlled release pipelines, set
`api.migrateOnStartup=false` and run the optional migration Job with
`migrations.job.enabled=true`.
