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
- **Location:** site, building, floor, and a default room. Room ownership is
  per-channel (see Hardware), so `room` here is the node's install location /
  default room, not the sole owner of its channels.
- **Network:** hostname and IP addresses.
- **Runtime:** agent version, uptime, last-seen, OS/kernel, audio backends.
- **Hardware:** audio interfaces with USB/hardware paths and serials where
  available, plus per-channel aliases and each channel's owning **room** (assign
  channels to rooms from the node's Configure dialog; a node's channels can be
  split across several rooms, each channel owned by one room).
- **Status:** `provisioning` / `online` / `offline` / `recording` / `degraded` /
  `alerting`. A newly enrolled node stays `provisioning` (shown as "Awaiting
  first contact") until its first heartbeat — it is **excluded from offline
  liveness alerting** until then, since it has never been online.

## Enrolling a node

From **Nodes → Enroll Recorder Node** (`node:manage`), enter just the node's
**identity** (alias, hostname, site, room) — **interfaces are not entered by
hand**. On save the dialog mints a single-use **bootstrap token** and shows the
copy-paste [`rakkr.org/agent.sh`](node-onboarding.md) installer one-liner. Run it
on the fresh host and the node installs the agent, registers, and provisions
itself hands-free — see [Node onboarding](node-onboarding.md) for the full flow.

Until its first contact the node stays **provisioning** ("Awaiting first
contact") and is excluded from offline alerting. Once the agent heartbeats it
reports its real hardware, goes live, and becomes available for jobs and metering.

To provision without the installer, rotate a **controller token** from the node
card and start the agent yourself:

```powershell
cargo run -p rakkr-recorder-agent -- `
  --controller-url https://controller.example.com `
  --controller-token <node-token> `
  --node-id <node-id>
```

See the [recorder agent reference](../reference/recorder-agent.md) for all agent
options.

## Heartbeats, liveness, and status

Each heartbeat updates last-seen, status, OS/kernel/runtime, IPs, and audio
backends. A node that has **never** heartbeated stays `provisioning` and is not
subject to offline derivation. Once it has made contact, the controller derives
**offline** automatically after a missed heartbeat threshold
(`RAKKR_NODE_OFFLINE_AFTER_SECONDS`, default 120s), and the watchdog
opens/auto-resolves a central health event when a node goes stale or recovers. Node and dashboard UI color-code status and summarize
connectivity/disk/CPU/audio health.

## Audio inventory

The agent discovers capture interfaces from ALSA (`arecord -l`, falling back to
`/proc/asound/pcm` and then ALSA hw-params metadata), preferring Linux sysfs
device paths and serials when exposed. It also reports PipeWire and JACK
availability so the right backend presets are offered.

**The agent is the source of truth for hardware.** On every startup it reconciles
its discovered inventory with the controller (`POST /nodes/:id/inventory`):
interfaces are matched by stable system ref so persisted ids — and any channel-map
assignment keyed on them — survive, operator labels (interface + channel aliases)
are preserved, and devices the agent no longer reports are flagged **absent**
(not deleted), preserving channel-map history. Real changes audit
`nodes.inventory.reconciled`; an unchanged report is a no-op.

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
  controller meter-preview when chunks are stale. A **Raw / Enhanced** toggle
  switches between the untouched stream and on-demand DeepFilterNet3 noise
  suppression; see [Audio enhancement](/guides/audio-enhancement/).

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
