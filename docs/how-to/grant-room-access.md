---
title: Grant access to a room
description: Use a room's roster to give a user or group scoped capabilities — view, listen, download, operate, book, edit, delete.
sidebar:
  order: 9
---

# Grant access to a room

A room's **roster** is how you give people access to *that room* without making
them global administrators. Each entry maps a user or group to a set of
capabilities that apply **only when the target is this room**.

> **Who can do this:** editing a roster needs `auth:manage` — the roster is
> access control (distinct from editing the room's identity, which needs
> `node:manage`).

## The capabilities

| Capability | Lets the subject… (only for this room)               |
| ---------- | ---------------------------------------------------- |
| `view`     | see the room, its recordings, schedules, and health  |
| `listen`   | live-listen to the room                               |
| `download` | download the room's recordings                        |
| `operate`  | start and stop recordings in the room                 |
| `book`     | create and edit the room's schedules                  |
| `edit`     | edit recording metadata                               |
| `delete`   | delete the room's recordings                          |

## Add or change a roster entry

1. Open **Rooms** and click the room to open its detail page.
2. Find the **roster editor**.
3. Add a **user or group** with the searchable picker, then toggle the
   capabilities they should have.
4. Save. Remove an entry the same way to revoke access.

## How access combines

- **Room-scoped only.** A capability authorizes an action *only* when the target
  resolves to this room — it grants nothing elsewhere.
- **Union.** A person's effective access is the **union** of their own roster
  entry and any group entries they belong to, for this room.
- **Deny still wins.** An explicit **deny** access policy overrides any roster
  capability. See [Manage groups & access policies](manage-groups-and-access.md).
- **Never node/settings.** Rosters never grant node, settings, or credential
  management — those stay role-based.

## Manual vs calendar-derived entries

The roster editor edits **manual** entries. Entries with `source = calendar` are
created automatically when a [schedule](schedule-recordings.md) assigns users or
groups (they get `view + operate` by default) — manage those through the
schedule, not the roster editor. They're removed automatically when the
assignment or schedule goes away.

## See also

- [Manage rooms](manage-rooms.md) — creating and editing the room itself
- [Manage users](manage-users.md) · [Manage groups & access policies](manage-groups-and-access.md)
- [Rooms & access rosters guide](../guides/rooms.md) — the full model
