---
title: Authentication & RBAC
description: How Rakkr authenticates users and recorder nodes, and how default-deny RBAC with roles, resource scope, and access policies decides access.
sidebar:
  order: 1
---

# Authentication & RBAC

Rakkr is **default-deny**: nothing is permitted unless a role grants the
permission _and_ the actor is in scope for the specific resource. The console
mirrors these rules for usability, but the **API is the only enforcement point**.

## Who authenticates

| Actor                           | Credential                         | Used for                                   |
| ------------------------------- | ---------------------------------- | ------------------------------------------ |
| Operators / admins              | User **session token** (bearer)    | The console and all `/api/v1` user routes  |
| Recorder agents                 | Node **credential token** (bearer) | Agent service routes, scoped to one node   |
| Automation (scheduler, runners) | Service identity                   | Background actions, audited like any actor |

### Local sign-in

`POST /api/v1/auth/login` takes `{ email, password }`, verified against a
DB-persisted user (scrypt) or the env-configured local admin. On success
the controller mints `rakkr_<random>`, stores only its SHA-256 hash, and returns
a token with a 12-hour TTL. Disabling, deleting, or password-resetting a user
revokes their active sessions.

Configure the local admin with `RAKKR_LOCAL_ADMIN_EMAIL` / `_PASSWORD` / `_NAME`
/ `_ID`. **In production (`NODE_ENV=production`) a password is mandatory** — the
controller refuses to start with the dev default.

### Azure AD / OIDC

OIDC is an optional Authorization Code + PKCE flow, **disabled by default**. When
enabled, `GET /api/v1/auth/oidc/login` redirects to Entra, and the callback
exchanges the code, syncs the user into RBAC, and returns a session. Group and
app-role claims can sync into Rakkr roles and scoped grants. Setup steps and all
`RAKKR_OIDC_*` variables are in the
[configuration reference](../reference/configuration.md#oidc--azure-ad); the
checked behavior baseline is `AZURE_AD_OIDC_BASELINE`.

### Node credentials

Nodes are enrolled from the console (`node:manage`), which issues a one-time token
stored only as a hash. The agent presents it as a bearer token; agent routes
verify the credential and enforce that it matches the node in the path. Rotate
tokens from the Nodes page. Credentials are scoped strictly to their own node's
jobs, recordings, meters, and events.

## The permission model

A user's effective access is computed in layers:

```text
role permissions  ─┐
resource grants    ├─►  allow?  ──►  unless an explicit DENY policy applies
access policies   ─┘
```

1. **Roles → permissions.** Each role maps to a fixed permission set (defined in
   `@rakkr/shared`). `owner` has everything; `admin` has everything except
   `system:admin`; `operator`, `viewer`, and `auditor` are progressively narrower.
   See the [permissions reference](../reference/permissions.md).
2. **Resource scope.** Having a permission isn't enough — the actor must be in
   scope for the target. `owner`/`admin` bypass scope; everyone else needs a
   matching **resource grant** or an **allow access policy**.
3. **Explicit deny wins.** A `deny` access policy overrides any role grant or
   inherited visibility.

### Hierarchical scope

Scope expands through the resource hierarchy, so a grant at any level applies
downward:

| Scope               | Examples                                      |
| ------------------- | --------------------------------------------- |
| Global              | auth settings, roles, system settings         |
| Site / Room         | site-wide inventory; room health, live listen |
| Node                | enroll, configure, control                    |
| Interface / Channel | meters, channel maps, listen, record          |
| Schedule            | create, edit, run-now, delete                 |
| Recording           | playback, download, rename, tag, delete       |
| Alert               | acknowledge, suppress, resolve                |

A recording, for instance, expands to its schedule, node, room, and site — a grant
on the node covers the recordings captured there. A recorder-level **deny** blocks
node access, its recordings, meters, live listen, and controls together.

## Access policies and grants

Administrators (`auth:manage`) manage access on the **Access** page:

- **Access policies** — structured `allow | deny` rules for a **subject** (user,
  group, or everyone) on a **resource** (type + id), with a reason. The composer
  builds these; explicit deny always takes precedence.
- **Resource grants** — direct per-user scope grants (e.g. "this user can act on
  `node_x32_test`").
- **Users, roles, groups** — create local users, assign roles and access
  groups (chosen from a searchable picker), reset passwords, enable/disable, and
  delete (you cannot disable or delete your own account).
- **Access groups** — create, rename/describe, manage membership, and delete
  access groups from the Access page. A group can be assigned to schedules, room
  rosters, and access policies; deleting a group removes it from all of them.

For local development you can seed grants and policies with
`RAKKR_LOCAL_RESOURCE_GRANTS` and `RAKKR_LOCAL_ACCESS_POLICIES`.

## Room rosters & capabilities

Beyond roles and scope, each room carries a **roster** that grants a subject (a
user or a group) a subset of per-action **capabilities** on that room. A
capability unlocks the catalog permissions below **only when the request target
resolves to that room** — it never adds a new global permission.

| Capability | Unlocks (when the target is this room)                             |
| ---------- | ------------------------------------------------------------------ |
| `view`     | `node:read`, `recording:read`, `recording:playback`, `schedule:read`, `health:read` |
| `listen`   | `listen:monitor`                                                   |
| `download` | `recording:download`                                               |
| `operate`  | `recording:create`, `recording:control`                           |
| `book`     | `schedule:manage`                                                  |
| `edit`     | `recording:edit`                                                   |
| `delete`   | `recording:delete`                                                 |

Rules:

- A capability authorizes only when the request target resolves to that room.
- A subject's **effective capabilities** are the union across their direct roster
  entry and any group roster entries for that room.
- An explicit **deny** access policy still wins over any roster capability.
- Rosters introduce **no new global permissions**. Node, settings, and onboarding
  actions stay role-based and are never room-granted.
- `node:control` (recorder-service lifecycle) is deliberately **not** part of
  `operate`; `operate` covers start/stop recordings only.

Calendar meeting-assignments auto-grant `view` + `operate` on the room to the
schedule's assigned users and groups. Manage rosters and see how they combine
from the room's page — see [Rooms](../guides/rooms.md).

## Audit

Every privileged route writes an audit event — **including denied attempts and
automated service actions**. Events capture actor, permission, target, outcome
(`allowed`/`denied`/`failed`/`succeeded`/`partial`), reason, correlation IDs, and
before/after snapshots for writes. The **Audit** page (`audit:read`) filters by
actor, action, permission, target, outcome, reason, and time, expands before/after
detail, and exports scoped CSV.

The checked RBAC/audit contract is the `RBAC_AUDIT_BASELINE`. The console's
permission mirroring is itself regression-tested so privileged controls can't be
exposed by UI state alone.
