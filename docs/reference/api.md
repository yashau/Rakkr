---
title: API endpoints
description: Curated reference of the Rakkr controller HTTP API by route family, with methods, paths, and required permissions.
sidebar:
  order: 3
---

# API endpoints

A curated reference of the controller's `/api/v1` surface, grouped by family. For
the authentication model, the RBAC + audit pattern, and error shapes, see
[Controller API](../architecture/controller-api.md).

Conventions:

- All application routes are under `/api/v1`; `GET /metrics` and `GET /healthz`
  are at the root.
- Successful responses are `{ "data": ... }`; some writes return 201/202; deletes
  and logout return 204.
- **Perm** is the exact RBAC permission checked. Agent rows are authenticated by a
  **node credential**, not a user permission (the listed label is the audit
  permission).

## Auth & session — `/api/v1/auth`

| Method & path       | Perm | Purpose                              |
| ------------------- | ---- | ------------------------------------ |
| `POST /auth/login`  | —    | Issue a session token.               |
| `POST /auth/logout` | —    | Revoke the current session.          |
| `GET /auth/me`      | —    | Current user + resolved permissions. |

## OIDC — `/api/v1/auth/oidc`

| Method & path              | Perm          | Purpose                               |
| -------------------------- | ------------- | ------------------------------------- |
| `GET /auth/oidc/config`    | —             | Public OIDC config.                   |
| `GET /auth/oidc/login`     | —             | Start the login redirect.             |
| `GET /auth/oidc/callback`  | —             | Complete login (redirect with token). |
| `GET /auth/oidc/discovery` | `auth:manage` | Fetch IdP discovery doc.              |

## Access / RBAC — `/api/v1/auth/*`

| Method & path                                                           | Perm          | Purpose                                  |
| ----------------------------------------------------------------------- | ------------- | ---------------------------------------- |
| `GET /auth/users` · `POST /auth/users`                                  | `auth:manage` | List / create users.                     |
| `GET /auth/users/:id`                                                   | `auth:manage` | User detail + action states.             |
| `PATCH /auth/users/:id/access`                                          | `auth:manage` | Update roles/grants/groups.              |
| `PATCH /auth/users/:id/password` · `/status` · `DELETE /auth/users/:id` | `auth:manage` | Lifecycle (reset/enable-disable/delete). |
| `GET /auth/groups`                                                      | `auth:manage` | List groups.                             |
| `GET /auth/access-policies` · `PATCH /auth/access-policies`             | `auth:manage` | Read / replace access policies.          |

## Audit — `/api/v1/audit-events`

| Method & path                    | Perm         | Purpose                       |
| -------------------------------- | ------------ | ----------------------------- |
| `GET /audit-events`              | `audit:read` | List/filter events.           |
| `GET\|POST /audit-events/export` | `audit:read` | Export (filtered / selected). |
| `GET /audit-events/facets`       | `audit:read` | Filter facets.                |
| `GET /audit-events/:id`          | `audit:read` | Detail + before/after.        |

## Nodes — `/api/v1/nodes`

| Method & path                                                                   | Perm             | Purpose                              |
| ------------------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| `GET /nodes` · `GET\|POST /nodes/export`                                        | `node:read`      | List / export inventory (scoped).    |
| `GET /nodes/:id` · `/:id/actions`                                               | `node:read`      | Detail / action summaries.           |
| `GET /nodes/:id/meters` · `GET /meter-events`                                   | `node:read`      | Meter snapshot / SSE stream.         |
| `POST /nodes/enroll`                                                            | `node:manage`    | Enroll node (returns credential).    |
| `PATCH /nodes/:id` · `/:id/interfaces/:iid`                                     | `node:manage`    | Update node / interface.             |
| `POST /nodes/:id/credentials/rotate`                                            | `node:manage`    | Rotate node credential.              |
| `GET /nodes/:id/lifecycle-jobs`                                                 | `node:read`      | List lifecycle runs.                 |
| `POST /nodes/:id/lifecycle/:action`                                             | `node:manage`    | Run an allowlisted lifecycle action. |
| `POST /nodes/:id/listen` · `GET /:id/listen/stream` · `DELETE /:id/listen/:sid` | `listen:monitor` | Start / stream / stop live listen.   |

## Agent service routes (node-credential)

| Method & path                                     | Audit perm                           | Purpose                                   |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| `GET /nodes/:id/config`                           | `node:control`                       | Node config + cache policies + capacity.  |
| `GET /nodes/:id/channel-map-assignments`          | `node:control`                       | Assigned channel maps.                    |
| `POST /nodes/:id/heartbeat`                       | `node:control`                       | Node heartbeat.                           |
| `POST /nodes/:id/meter-frame`                     | —                                    | Push a meter frame.                       |
| `POST /nodes/:id/listen/chunk`                    | `node:control`                       | Ingest live-listen audio.                 |
| `POST /nodes/:id/health-events`                   | `health:acknowledge`                 | Sync a health event.                      |
| `POST /nodes/:id/recording-jobs/claim-next`       | `recording:control`                  | Claim the next queued job.                |
| `POST /recording-jobs/:jid/heartbeat`             | `recording:control`                  | Job heartbeat.                            |
| `GET /recording-jobs/:jid`                        | `recording:control`/`recording:read` | Read job (dual-mode auth).                |
| `POST /recording-jobs/:jid/cancelled` · `/failed` | `recording:control`                  | Terminal job state.                       |
| `PUT /recordings/:rid/cache-file`                 | `recording:control`                  | Upload captured audio; completes the job. |

## Recordings — `/api/v1/recordings`

| Method & path                                                            | Perm                 | Purpose                                |
| ------------------------------------------------------------------------ | -------------------- | -------------------------------------- |
| `GET /recordings` · `/facets` · `/:id` · `/:id/context` · `/:id/actions` | `recording:read`     | Library reads (scoped).                |
| `GET\|POST /recordings/export`                                           | `recording:read`     | Export manifest (filtered / selected). |
| `POST /recordings`                                                       | `recording:create`   | Start an ad-hoc recording.             |
| `POST /recordings/:id/stop`                                              | `recording:control`  | Stop a recording.                      |
| `POST /recordings/:id/playback` · `GET /:id/stream`                      | `recording:playback` | Start / stream playback.               |
| `POST /recordings/:id/download` · `GET /:id/file`                        | `recording:download` | Prepare / download file.               |
| `PATCH /recordings/:id/metadata` · `/bulk-metadata`                      | `recording:edit`     | Edit / bulk-organize.                  |
| `DELETE /recordings/:id` · `POST /recordings/bulk-delete`                | `recording:delete`   | Delete terminal recordings.            |

## Recording jobs & uploads

| Method & path                                                                               | Perm                | Purpose                  |
| ------------------------------------------------------------------------------------------- | ------------------- | ------------------------ |
| `GET /recording-jobs` · `/:id` · `/:id/actions` · `GET\|POST /export`                       | `recording:read`    | Job reads / export.      |
| `POST /recording-jobs/:id/retry` · `/bulk-retry` · `/bulk-stop`                             | `recording:control` | Retry / stop jobs.       |
| `GET /upload-queue` · `/:id` · `/:id/actions`                                               | `recording:read`    | Queue reads.             |
| `POST /recordings/:id/upload-queue` · `/bulk-upload-queue` · `POST /upload-queue/:id/retry` | `recording:control` | Enqueue / retry uploads. |
| `GET /upload-runner` · `/actions`                                                           | `recording:read`    | Runner status.           |
| `POST /upload-runner/run`                                                                   | `recording:control` | Trigger a runner pass.   |

## Schedules — `/api/v1/schedules`

| Method & path                                                                         | Perm              | Purpose                           |
| ------------------------------------------------------------------------------------- | ----------------- | --------------------------------- |
| `GET /schedules` · `/:id` · `/:id/occurrences` · `/:id/actions` · `GET\|POST /export` | `schedule:read`   | Reads / occurrences / export.     |
| `POST /schedules` · `PATCH /:id` · `DELETE /:id`                                      | `schedule:manage` | Create / update / delete.         |
| `POST /schedules/:id/run-now` · `/skip-next`                                          | `schedule:manage` | Force / skip the next occurrence. |

## Settings & retention — `/api/v1/settings/*`

Each settings family supports `GET` list, `GET /:id`, and `GET /:id/actions`
reads under `settings:read`. Mutations require `settings:manage`.

| Family                                      | Read            | Manage                                                                           |
| ------------------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| Recording profiles                          | `settings:read` | `PATCH /settings/recording-profiles/:id`                                         |
| Watchdog policies                           | `settings:read` | `PATCH /settings/watchdog-policies/:id` (+ calibrate)                            |
| Upload providers / policies                 | `settings:read` | `PATCH`/`POST` providers & policies                                              |
| Channel-map templates / assignments / plans | `settings:read` | create/update templates; `PUT` assignments (+ bulk, rollback); stage/apply plans |
| Retention policies                          | `settings:read` | `POST` / `PATCH /settings/retention-policies/:id`                                |

## Health — `/api/v1/health-events`

| Method & path                                                                | Perm                 | Purpose                  |
| ---------------------------------------------------------------------------- | -------------------- | ------------------------ |
| `GET /health-events` · `/:id` · `/:id/actions` · `GET\|POST /export`         | `health:read`        | Reads / export.          |
| `POST /health-events` · `/bulk-lifecycle`                                    | `health:acknowledge` | Create / bulk lifecycle. |
| `POST /health-events/:id/acknowledge` · `/suppress` · `/resolve` · `/reopen` | `health:acknowledge` | Single-event lifecycle.  |

## Status & metrics

| Method & path        | Perm           | Purpose                                                       |
| -------------------- | -------------- | ------------------------------------------------------------- |
| `GET /api/v1/status` | `node:read`    | Aggregated scoped status (nodes, recordings, health, uptime). |
| `GET /metrics`       | `metrics:read` | Prometheus exposition (root path).                            |
| `GET /healthz`       | —              | Liveness.                                                     |
