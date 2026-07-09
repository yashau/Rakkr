---
title: Manage rooms
description: Create, edit, and delete first-class rooms, and understand how nodes, channels, schedules, and recordings bind to them.
sidebar:
  order: 8
---

# Manage rooms

A **room** is a first-class thing in Rakkr, not a free-text label. Its stable ID
is the **access-control scope target** — it's what access grants and rosters
point at — so getting rooms right is the foundation for who can reach what.

> **Who can do this:** viewing needs `node:read`; creating, editing, and deleting
> rooms needs `node:manage` (rooms are inventory-adjacent). Granting *access* to a
> room is a separate task — see [Grant access to a room](grant-room-access.md).

## Why rooms matter

- **They are the access scope.** You grant people access *to a room*, and that
  access follows the room's schedules and recordings.
- **A room is made of channels.** A room owns one or more of a node's audio
  **channels**. A node usually has many more channels than any single room needs,
  so its channels are divided among rooms — each channel belongs to at most one
  room (a channel with no room of its own inherits the node's default). Because
  different channels of one node can belong to different rooms, that node can feed
  several rooms at once, and two rooms can record from it at the same time on their
  own channels.
- **They're unique per site + name**, so two sites can each have a "Committee
  Room A" without collision.

## Create a room

1. Open **Rooms** in the left nav and click **Add room**.
2. Fill in the dialog (*"Add a first-class room. Nodes and schedules can then be
   assigned to it."*):
   - **Name** (required)
   - **Site** (required)
   - **Building**, **Floor** (optional)
   - **Description**, **Notes** (optional operator context)
3. Click **Create**.

## Edit or delete a room

1. On the **Rooms** page, click a room to open its detail page.
2. Use **Edit** (pencil) to change the identity fields, or **Delete** (trash) to
   remove it.
   - Deleting a room clears it from any node or channel that pointed at it, drops
     any recording's room attribution, and removes its access-roster entries.
   - A room that is still referenced by a **schedule** cannot be deleted — the
     delete is refused until you reassign or remove those schedules first.

## What's on the room detail page

- The editable **identity** (name, site, building, floor, description, notes).
- The room's **node inventory**.
- Its **upcoming scheduled occurrences** — with who booked each.
- Its **recent recordings**.
- Its **access roster** — edited here; see
  [Grant access to a room](grant-room-access.md).

## Assign channels and nodes to a room

Channel-to-room ownership is set on the **node**, not the room. Open a node's
**Configure** dialog and assign each channel's owning room. See
[Enroll & configure nodes](enroll-and-configure-nodes.md#configure-a-node).

## See also

- [Grant access to a room](grant-room-access.md) — the room's roster and capabilities
- [Rooms & access rosters guide](../guides/rooms.md) — the full room model
