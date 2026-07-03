---
title: Rooms & access rosters
description: First-class rooms as the RBAC scope target, how nodes and schedules bind to them, and the per-room capability roster that grants access.
sidebar:
  order: 2
---

# Rooms & access rosters

A **room** is a first-class entity in Rakkr, not a free-text label. Each room has
a stable `roomId` that is **the RBAC scope target** for everything captured or
scheduled there. Rooms are unique per `site` + `name`, with optional `building`,
`floor`, `description`, and `notes` for operator context.

## What a room is

- **Stable identity.** `roomId` never changes and is what access grants,
  policies, and rosters point at. A room carries `name`, a required `site`, and
  optional `building`, `floor`, `description`, and `notes`.
- **Unique per site.** The `(site, name)` pair is unique, so two sites can each
  have a "Committee Room A" without collision.

## How nodes and schedules bind to a room

`roomId` is the source of truth for room identity and RBAC scope. Both nodes and
schedules bind to a room by id:

- **Nodes** carry a nullable `roomId` (`nodes.roomId`, set-null on room delete).
  It is **operator-set via node management** — the **agent never sets it**. The
  legacy `location` field is retained only for display of building/floor.
- **Schedules** carry a `roomId` (`schedules.roomId`, restricted on delete) that
  is the source of truth for the schedule's room identity and RBAC scope. The
  legacy `room` column is retained for display and templates.

On migration, existing **free-text node/schedule locations were backfilled** into
first-class rooms so nothing loses its scope. From then on `roomId` is
authoritative and the legacy `location`/`room` columns are display-only.

## The Rooms pages

- **Rooms list** (`/rooms`) — every room in the deployment.
- **Room detail** (`/rooms/$roomId`) — shows the editable room identity (**name, site, building, floor,
  description, notes**), the room's **node inventory**, its **upcoming scheduled occurrences**
  (with who booked each one), and its **recent recordings**. The room's roster is
  edited here as well.

## The per-room roster

Access to a room is granted by its **roster**. Each roster entry maps a subject —
a user or a group — to a subset of capabilities. Each capability unlocks specific
catalog permissions **only when the request target resolves to that room**:

| Capability | Unlocks (scoped to that room)                                            |
| ---------- | ------------------------------------------------------------------------ |
| `view`     | `node:read`, `recording:read`, `recording:playback`, `schedule:read`, `health:read` |
| `listen`   | `listen:monitor`                                                         |
| `download` | `recording:download`                                                     |
| `operate`  | `recording:create`, `recording:control` (start/stop recordings only)     |
| `book`     | `schedule:manage`                                                        |
| `edit`     | `recording:edit`                                                         |
| `delete`   | `recording:delete`                                                       |

### Rules

- **Room-scoped only.** A capability authorizes **only when the target resolves
  to that room**.
- **Effective access is a union.** A subject's effective access is the **union of
  their direct roster entries and their group roster entries** for that room.
- **Explicit deny still wins.** An explicit deny access policy overrides any
  capability grant.
- **No new global permissions.** Node, settings, and onboarding/credential
  permissions stay **role-based** (AV/IT) and are **never room-granted**.
- **`operate` is recordings only.** `node:control` (recorder-service lifecycle) is
  deliberately **not** part of `operate`.

## Manual vs calendar-derived entries

Roster entries come from two sources:

- **Manual** entries are added directly in the roster editor.
- **Calendar-derived** entries are populated automatically from schedules: when a
  schedule assigns users or groups, they become roster entries on that schedule's
  room with `source=calendar` and the default `[view, operate]` capabilities. They
  are reconciled when schedules change, and removing the assignment or schedule
  removes the entry.

The **roster editor edits only manual entries** — calendar-derived entries are
managed through their schedules, not here.

## Who manages what

Room identity and access are governed by two different permissions, on purpose:

- **Room identity edits** (create, rename, edit identity fields, delete) require
  `node:manage` — rooms are inventory-adjacent.
- **Roster edits** (who can access the room and with which capabilities) require
  `auth:manage` — the roster is access control.

## See also

- [Authentication & RBAC](../guides/authentication-and-rbac.md) — roles,
  resource scope, access policies, and how deny wins.
- [Scheduling](../guides/scheduling.md) — how a schedule binds to a room and
  auto-populates its roster.
- [Audio matrix switcher routing](../guides/switcher-routing.md) — routing a
  room's live meeting to a listener's desk.
