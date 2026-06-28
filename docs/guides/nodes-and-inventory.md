---
title: Nodes & inventory
description: Enrolling and managing recorder nodes, audio interfaces, channel aliases, heartbeats, status, and live metering.
sidebar:
  order: 2
---

# Nodes & inventory

A **node** is a Linux machine running the recorder agent. The controller keeps an
inventory of nodes, their audio interfaces and channels, and their live status —
all RBAC-gated by `node:read` (view) and `node:manage` (change).

## What a node record holds

- **Identity:** stable ID, alias, tags, notes.
- **Location:** site, building, floor, room.
- **Network:** hostname and IP addresses.
- **Runtime:** agent version, uptime, last-seen, OS/kernel, audio backends.
- **Hardware:** audio interfaces with USB/hardware paths and serials where
  available, plus per-channel aliases.
- **Status:** `online` / `offline` / `recording` / `degraded` / `alerting`.

## Enrolling a node

From **Nodes → Enroll Recorder Node** (`node:manage`), enroll a node to create its
record and a one-time **credential token**. Configure the agent with that token
and the node ID, point it at the controller, and start it:

```powershell
cargo run -p rakkr-recorder-agent -- `
  --controller-url https://controller.example.com `
  --controller-token <node-token> `
  --node-id <node-id>
```

The agent then heartbeats, reports inventory, and becomes available for jobs and
metering. Rotate the token any time from the node card; rotation revokes the old
credential. See the [recorder agent reference](../reference/recorder-agent.md) for
all agent options.

## Heartbeats, liveness, and status

Each heartbeat updates last-seen, status, OS/kernel/runtime, IPs, and audio
backends. The controller derives **offline** automatically after a missed
heartbeat threshold (`RAKKR_NODE_OFFLINE_AFTER_SECONDS`, default 120s), and the
watchdog opens/auto-resolves a central health event when a node goes stale or
recovers. Node and dashboard UI color-code status and summarize
connectivity/disk/CPU/audio health.

## Audio inventory

The agent discovers capture interfaces from ALSA (`arecord -l`, falling back to
`/proc/asound/pcm` and then ALSA hw-params metadata), preferring Linux sysfs
device paths and serials when exposed. It also reports PipeWire and JACK
availability so the right backend presets are offered.

You can edit identity, location, network, tags, notes, interface aliases,
hardware paths, serials, sample rates, and channel aliases — all `node:manage`,
all with audit history. You can also persist **per-node audio command defaults**
(capture backend, device, format, rate, channels, command templates), which the
controller pushes to the agent via node config and the agent applies live for
queued captures and idle metering.

## Finding and exporting nodes

The Nodes page and API support scoped filtering and search:

- Filter by status, last-seen range, site/building/floor/room, and audio backend.
- Search identity, location, network, tags, runtime, interfaces, and channel
  aliases.
- Removable active-filter chips show what's applied.
- Export the filtered set or a hand-picked selection as audited CSV.

Detail and action APIs operate **only on scoped visible nodes**, and expose action
summaries (live listen, meters, inventory edits, token rotation, health, ad-hoc
start readiness) so the console can reflect exactly what the current user may do.

## Live meters and listen-in

With the meters/listen permissions, operators get:

- **Meter bank** — live per-channel RMS/peak in dBFS, clipping, and quality cues
  (speech, noise, SNR, intelligibility, hum/static, correlation), available even
  while the node is idle.
- **Listen monitor** (`listen:monitor`) — a privileged, server-session live
  listen-in that prefers fresh agent-provided audio chunks and falls back to a
  controller meter-preview when chunks are stale.

## Node recording capacity

Each node advertises a recording capacity (`RAKKR_MAX_CONCURRENT_RECORDINGS`,
overridable from controller node config). The controller honors it when queuing
ad-hoc and scheduled jobs, and the agent runs bounded-concurrent capture workers
up to that limit.

## Remote lifecycle

Routine host operations — installing dependencies, deploying the agent binary,
restarting the service, rotating CA trust, and running a smoke check — can be run
remotely over SSH from the node card via the optional Ansible runner. See
[Node lifecycle](node-lifecycle.md).

The checked generic-device contract is the `GENERIC_DEVICE_BASELINE`; it also
records which Linux-hardware validations remain.
