---
title: Configure channel maps
description: Build reusable templates that map capture channels to outputs, assign them in bulk, stage an apply step, and roll back.
sidebar:
  order: 16
---

# Configure channel maps

A **channel map** is a reusable template that decides how a device's capture
channels become the outputs of a recording — mono, stereo, grouped, or a
mono-to-stereo mix. Maps let you apply the same routing to many nodes at once
instead of configuring each recording by hand.

> **Who can do this:** viewing needs `settings:read`; creating and editing need
> `settings:manage`.

## Where to find them

Open **Settings** and scroll to **Channel Maps** (*"Reusable node and interface
routing."*).

## Create or edit a channel map

1. Click **New** (or the pencil on an existing map).
2. Choose the **node and interface** it targets.
3. Define how each capture channel maps to an output (the output mode — mono,
   stereo pair, grouped, or mono-to-stereo).
4. Save.

## Assign, stage, and roll back

Channel maps are built for fleet management:

- **Bulk-assign** a map to many node/interface targets at once.
- Changes are **staged behind an explicit apply step**, so nothing changes on the
  hardware until you apply it.
- Maps are **versioned** and can be **rolled back** if an apply causes trouble.

Because inventory reconcile matches interfaces by a stable identity, a map's
assignment **survives node restarts and hardware re-discovery** — see
[Enroll & configure nodes](enroll-and-configure-nodes.md#bring-a-node-online).

## See also

- [Record a session](record-a-session.md#record-part-of-a-device-channels) — picking channels for one capture
- [Enroll & configure nodes](enroll-and-configure-nodes.md) — per-channel room assignment
