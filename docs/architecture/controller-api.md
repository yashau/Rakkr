---
title: Controller API
description: How the Hono controller API is structured — authentication, the RBAC + audit route pattern, route families, and background runners.
sidebar:
  order: 2
---

# Controller API

The controller API is a [Hono](https://hono.dev/) application on Node, in
`apps/api`. It owns authentication, authorization, audit, all domain resources,
and the background runners. The entrypoint is `apps/api/src/index.ts`; route
modules live beside their stores and helpers (e.g. `recording-routes.ts` next to
`recording-store.ts`).

## Surface and versioning

All application routes are mounted under **`/api/v1`**. Two routes sit at the
root: `GET /metrics` (Prometheus) and `GET /healthz` (liveness). CORS is applied
to `/api/*`, allowing the configured web origin (`RAKKR_WEB_ORIGIN`, default
`http://localhost:5173`) with credentials.

Successful responses use a `{ "data": ... }` envelope. Errors are plain JSON
(`{ "error": "...", ... }`) with conventional status codes — see
[Errors](#error-shapes).

## Authentication

Two bearer-token schemes share the `Authorization: Bearer <token>` header:

### User sessions (operator console)

Handled by `LocalAuthService` (`auth-service.ts`):

- `POST /api/v1/auth/login` validates `{ email, password }` against a
  DB-persisted user (scrypt) or the env-configured local admin, then mints
  a token `rakkr_<random>`, stores only its SHA-256 hash, and returns
  `{ token, expiresAt, sessionId, user }` with a 12-hour TTL.
- `authenticate()` hashes the presented token and looks it up; disabled users and
  revoked/expired sessions are rejected.
- `POST /api/v1/auth/logout` revokes the session; `GET /api/v1/auth/me` returns
  the current user (including their resolved `permissions`).

**OIDC (Azure AD)** is an alternative browser-driven Authorization Code + PKCE
flow (`auth-oidc-routes.ts`): `oidc/login` sets an HttpOnly state cookie and
redirects to the IdP; `oidc/callback` validates state, exchanges the code, syncs
the user into RBAC, creates a session, and redirects back with the token in the
URL hash. Disabled by default. See
[Authentication & RBAC](../guides/authentication-and-rbac.md).

### Node credentials (recorder agent)

Agent "service" routes do **not** use sessions or `requirePermission`. They
authenticate a node credential token (`nodeStore.authenticateCredential`), then
enforce that the credential's node matches the `:nodeId` in the path. Tokens are
issued at enrollment / rotation and stored only as hashes.

## The RBAC + audit route pattern

Every user-facing route follows the same shape, enforced by the
`requirePermission(permission, action, targetFn)` middleware in `index.ts`:

```text
requirePermission → authenticate → resolve audit target
  → check permission membership
  → check resource scope (resourceScopeDecision)
  → ALWAYS write an audit event (allowed | denied)
  → 401 (no user) / 403 (no permission/scope) or next()
```

Inside the handler:

1. **Validate** the body with a Zod schema; on failure write a `*.failed` audit
   event (`reason: invalid_request`) and return 400.
2. **Scoped lookup** — re-fetch the target through a scoped helper
   (`findScopedNode`, `scopedRecordings`, …) so a user can never act on a resource
   outside their grants even by guessing an ID; missing → audit + 404.
3. **Mutate + audit success** — perform the store operation, then write a
   `*.succeeded` audit event with `before`/`after` snapshots, the permission, and
   the target.

Example (`PATCH /api/v1/nodes/:nodeId`): `requirePermission("node:manage",
"nodes.update", …)` → validate → `findScopedNode` → `nodeStore.update` → audit
`nodes.update.succeeded` with before/after → `{ data: updated }`.

**Resource scope** is hierarchical and default-deny. `owner`/`admin` bypass scope;
other users need a matching resource grant or an `allow` access policy, and any
`deny` policy wins. A target's scope expands to related entities (a recording
expands to its schedule/node/room/site), so a grant at any level in the hierarchy
applies. See [Authentication & RBAC](../guides/authentication-and-rbac.md).

## Route families

Permissions in `code` are the exact strings checked. This is the map; the
[API reference](../reference/api.md) lists the key endpoints per family.

| Family                | Base path                                         | Read                  | Write / control                                                                   |
| --------------------- | ------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| Auth / session        | `/api/v1/auth`                                    | — (self)              | login, logout, me                                                                 |
| OIDC                  | `/api/v1/auth/oidc`                               | public config/actions | `auth:manage` for discovery                                                       |
| Access / RBAC         | `/api/v1/auth/*`                                  | `auth:manage`         | users, groups, access policies, scopes                                            |
| Audit                 | `/api/v1/audit-events`                            | `audit:read`          | export, facets, detail                                                            |
| Nodes inventory       | `/api/v1/nodes`                                   | `node:read`           | `node:manage` (enroll, edit, rotate)                                              |
| Node lifecycle        | `/api/v1/nodes/:id/lifecycle*`                    | `node:read` (jobs)    | `node:manage` (run action)                                                        |
| Listen monitor        | `/api/v1/nodes/:id/listen*`                       | —                     | `listen:monitor`                                                                  |
| Agent service         | `/api/v1/nodes/:id/*`, `/api/v1/recording-jobs/*` | node credential       | node credential                                                                   |
| Recordings            | `/api/v1/recordings`                              | `recording:read`      | `recording:create` / `:control` / `:edit` / `:delete` / `:playback` / `:download` |
| Recording jobs        | `/api/v1/recording-jobs`                          | `recording:read`      | `recording:control`                                                               |
| Upload queue / runner | `/api/v1/upload-queue`, `/api/v1/upload-runner`   | `recording:read`      | `recording:control`                                                               |
| Schedules             | `/api/v1/schedules`                               | `schedule:read`       | `schedule:manage`                                                                 |
| Settings / templates  | `/api/v1/settings/*`                              | `settings:read`       | `settings:manage`                                                                 |
| Retention             | `/api/v1/settings/retention-policies`             | `settings:read`       | `settings:manage`                                                                 |
| Health events         | `/api/v1/health-events`                           | `health:read`         | `health:acknowledge`                                                              |
| Status                | `/api/v1/status`                                  | `node:read`           | —                                                                                 |
| Metrics               | `/metrics`                                        | `metrics:read`        | —                                                                                 |

## Background runners

The API hosts several interval-driven runners (`api-runners.ts`), each
individually toggleable and audited as service actions:

| Runner           | Default interval | Purpose                                                       |
| ---------------- | ---------------- | ------------------------------------------------------------- |
| Schedule runner  | 30s              | Materialize due schedule jobs under `system:scheduler`.       |
| Watchdog runner  | 30s              | Open/repeat/resolve health events from quality telemetry.     |
| Upload runner    | 60s              | Process the upload queue against providers and retry budgets. |
| Retention runner | 300s             | Execute controller-cache max-age/max-bytes cleanup.           |
| Job-lease runner | 10s              | Fail orphaned jobs whose lease expired.                       |

Tuning knobs (intervals, batch sizes, leases, enable flags) are in the
[configuration reference](../reference/configuration.md).

## Error shapes

There is no global error middleware; routes return JSON inline with conventional
status codes:

| Status | Shape                                   | When                                     |
| ------ | --------------------------------------- | ---------------------------------------- |
| 400    | `{ error, issues }`                     | Zod validation failure                   |
| 401    | `{ error: "Unauthorized", permission }` | No/invalid credential                    |
| 403    | `{ error: "Forbidden", permission }`    | Authenticated but lacks permission/scope |
| 404    | `{ error: "... not found" }`            | Missing or out-of-scope resource         |
| 409    | `{ error: "..." }`                      | e.g. job not claimable                   |
| 503    | `{ error: "... unavailable" }`          | Store/DB unavailable                     |

Typed auth error codes (`auth-errors.ts`, e.g. `invalid_credentials`,
`user_disabled`) are surfaced as the audit `reason` and mapped to statuses by the
calling route.
