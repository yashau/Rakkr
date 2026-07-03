---
title: Permissions & roles
description: The complete RBAC permission set, the built-in roles, and the role → permission matrix.
sidebar:
  order: 4
---

# Permissions & roles

Permissions and roles are defined once in `@rakkr/shared` and are the source of
truth for RBAC across the API and console. For how access is actually decided
(roles + resource scope + access policies, default-deny, explicit-deny-wins), see
[Authentication & RBAC](../guides/authentication-and-rbac.md).

## Permissions

| Permission           | Grants                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- |
| `audit:read`         | Read and export the audit log.                                                     |
| `auth:manage`        | Manage users, groups, roles, access policies, resource grants, room rosters, and OIDC discovery. |
| `health:read`        | View health events and quality timelines.                                          |
| `health:acknowledge` | Acknowledge, suppress, resolve, reopen health events.                              |
| `listen:monitor`     | Start/stream/stop live listen-in on a node.                                        |
| `metrics:read`       | Read the Prometheus `/metrics` endpoint.                                           |
| `node:read`          | View node inventory, meters, and status.                                           |
| `node:control`       | Service-level node control (used by agent credentials: config, heartbeat, jobs).   |
| `node:manage`        | Enroll/edit nodes and interfaces, rotate credentials, run lifecycle actions.       |
| `recording:read`     | Browse the recording library and jobs.                                             |
| `recording:create`   | Start ad-hoc recordings.                                                           |
| `recording:control`  | Stop recordings; retry/stop jobs; queue and run uploads.                           |
| `recording:edit`     | Edit recording metadata; bulk-organize.                                            |
| `recording:playback` | Play recordings.                                                                   |
| `recording:download` | Download recording files.                                                          |
| `recording:delete`   | Delete terminal recordings.                                                        |
| `schedule:read`      | View schedules and occurrences.                                                    |
| `schedule:manage`    | Create/edit/delete schedules; run-now; skip-next.                                  |
| `settings:read`      | View settings and templates.                                                       |
| `settings:manage`    | Edit profiles, watchdog/upload/retention policies, channel maps.                   |
| `switcher:read`      | View audio-matrix switcher config and mappings.                                                 |
| `switcher:map`       | Assign switcher inputs to rooms and outputs to users.                              |
| `switcher:manage`    | Create/edit/delete switchers; test/snapshot/restore the device.                    |
| `system:admin`       | Reserved highest-privilege capability (owner only).                                |

## Roles

Roles are fixed bundles of permissions:

- **`owner`** — every permission.
- **`admin`** — every permission **except** `system:admin`.
- **`operator`** — day-to-day operations (no access/audit/delete/settings-manage).
- **`viewer`** — read, playback, and download only.
- **`auditor`** — audit, health, metrics, and recording reads.

## Role → permission matrix

| Permission           | owner | admin | operator | viewer | auditor |
| -------------------- | :---: | :---: | :------: | :----: | :-----: |
| `audit:read`         |   ✓   |   ✓   |          |        |    ✓    |
| `auth:manage`        |   ✓   |   ✓   |          |        |         |
| `health:read`        |   ✓   |   ✓   |    ✓     |   ✓    |    ✓    |
| `health:acknowledge` |   ✓   |   ✓   |    ✓     |        |         |
| `listen:monitor`     |   ✓   |   ✓   |    ✓     |        |         |
| `metrics:read`       |   ✓   |   ✓   |    ✓     |   ✓    |    ✓    |
| `node:read`          |   ✓   |   ✓   |    ✓     |   ✓    |         |
| `node:control`       |   ✓   |   ✓   |    ✓     |        |         |
| `node:manage`        |   ✓   |   ✓   |          |        |         |
| `recording:read`     |   ✓   |   ✓   |    ✓     |   ✓    |    ✓    |
| `recording:create`   |   ✓   |   ✓   |    ✓     |        |         |
| `recording:control`  |   ✓   |   ✓   |    ✓     |        |         |
| `recording:edit`     |   ✓   |   ✓   |    ✓     |        |         |
| `recording:playback` |   ✓   |   ✓   |    ✓     |   ✓    |         |
| `recording:download` |   ✓   |   ✓   |    ✓     |   ✓    |         |
| `recording:delete`   |   ✓   |   ✓   |          |        |         |
| `schedule:read`      |   ✓   |   ✓   |    ✓     |   ✓    |         |
| `schedule:manage`    |   ✓   |   ✓   |    ✓     |        |         |
| `settings:read`      |   ✓   |   ✓   |    ✓     |   ✓    |         |
| `settings:manage`    |   ✓   |   ✓   |          |        |         |
| `switcher:read`      |   ✓   |   ✓   |    ✓     |   ✓    |         |
| `switcher:map`       |   ✓   |   ✓   |    ✓     |        |         |
| `switcher:manage`    |   ✓   |   ✓   |          |        |         |
| `system:admin`       |   ✓   |       |          |        |         |

> Roles set the _ceiling_ of what a user can do. The actual decision also requires
> the user to be **in scope** for the specific resource (via a resource grant or
> allow policy), and any explicit **deny** policy overrides everything. The
> checked contract is the `RBAC_AUDIT_BASELINE`.

## Room capabilities

A room roster grants a subject a subset of per-room **capabilities**. Each
capability unlocks catalog permissions **only when the request target resolves
to that room** — they are not global grants. See the
[Rooms guide](../guides/rooms.md) for how rosters are managed.

| Capability | Unlocks                                                              |
| ---------- | ------------------------------------------------------------------- |
| `view`     | `node:read`, `recording:read`, `recording:playback`, `schedule:read`, `health:read` |
| `listen`   | `listen:monitor`                                                    |
| `download` | `recording:download`                                                |
| `operate`  | `recording:create`, `recording:control` (start/stop recordings only; not `node:control`) |
| `book`     | `schedule:manage`                                                   |
| `edit`     | `recording:edit`                                                    |
| `delete`   | `recording:delete`                                                  |

Rules:

- A capability authorizes an action **only when the target resolves to that
  room**; it grants no access to other rooms or global resources.
- Effective capabilities are the **union** across a subject's direct and group
  roster entries for that room.
- An explicit **deny** policy still wins over any room capability.
- No new global permissions are introduced. `node`, `settings`, onboarding, and
  credential permissions stay **role-based** and are never room-granted.
