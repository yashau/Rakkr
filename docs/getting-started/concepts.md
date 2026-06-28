---
title: Core concepts
description: The vocabulary of Rakkr — nodes, interfaces, recordings, jobs, schedules, channel maps, health events, and more.
sidebar:
  order: 3
---

# Core concepts

A glossary of the domain objects Rakkr works with. Most map directly to shared
contracts in `packages/shared` and to tables in the
[data model](../architecture/data-model.md).

## Topology

**Node** — a Linux machine running the recorder agent. Identified by a stable ID
and described by alias, site/building/floor/room, hostname and IPs, agent
version, OS/kernel, audio backends, tags, notes, and a live status
(`online` / `offline` / `recording` / `degraded` / `alerting`). Nodes derive
`offline` automatically after a missed-heartbeat threshold.

**Audio interface** — a capture device on a node (e.g. an ALSA card). Carries a
backend, channel count, hardware path, serial, system reference, and supported
sample rates.

**Audio channel** — a single channel within an interface, with an operator-facing
alias.

## Capture

**Recording** — the logical record of a captured session: name, folder, tags,
source (`ad_hoc` or `schedule`), status, health status, duration, cache path,
checksum, and relationships to its node, schedule, and profile. Recordings are
the unit you browse in the recording library.

**Recording job** — the unit of _work_ that produces a recording. It carries the
capture command (backend, device, format, rate, channels, codec) and a lifecycle:
queued → claimed (leased by a node) → running (heartbeating) → completed /
failed / cancelled. Jobs are how the controller and agent coordinate; one
scheduled window may produce several jobs when split into tracks.

**Ad-hoc recording** — a recording started on demand from the console against a
chosen node, profile, and (optionally) capture backend/interface.

**Schedule** — a rule that creates recording jobs automatically. Human-friendly
recurrence (`manual`, `once`, `daily`, `weekly`, `monthly`, `always_on`), an
explicit timezone, start-early/stop-late buffers, pause ranges, and exceptions.
Schedules _own_ the metadata of the recordings they create (name, folder, tags,
profile, watchdog policy, retention, upload policy). No cron syntax is ever
exposed.

## Quality and metering

**Meter frame** — a per-channel snapshot of live audio: RMS and peak in dBFS,
clipping ratio, and quality scores (speech, noise, estimated SNR, intelligibility,
hum/static/broadband-noise, channel correlation). The agent posts these
continuously, even when idle, so operators can see signal before recording.

**Health event** — a lifecycle record of something noteworthy: low signal,
clipping, flatline, channel-correlation, device unavailable, xrun, disk/CPU
pressure, sync failure, capture/upload failure, and their recoveries. Each has a
type, severity (`info` / `warning` / `critical`), status, and is attached to a
node, recording, and/or schedule.

**Watchdog** — the controller-side runner that opens, repeats, and auto-resolves
health events from meter/quality telemetry against tunable **watchdog policies**.
The flagship rule is _scheduled low-signal_: during a recording window, after a
grace period, alert if the signal never exceeds a configurable dBFS threshold for
enough cumulative time. This is deliberately **not** simple silence detection.

## Templates and settings

**Recording profile** — the encode preset: codec (MP3/FLAC/WAV), bitrate, channel
mode, VBR, optional silence handling, and a maximum track length used for
auto-splitting.

**Channel map** — a template that maps capture channels to outputs (mono, stereo,
grouped, mono-to-stereo). Channel maps are versioned, can be bulk-assigned to many
node/interface targets, staged behind an explicit apply step, and rolled back.

**Watchdog policy / retention policy / upload policy** — tunable rule sets for,
respectively, health alerting thresholds, cache cleanup, and where/when/how
recordings are uploaded.

## Access and audit

**Permission** — a fine-grained capability string such as `node:read`,
`recording:create`, or `settings:manage`. The full set is the source of truth for
RBAC; see the [permissions reference](../reference/permissions.md).

**Role** — a named bundle of permissions: `owner`, `admin`, `operator`,
`viewer`, `auditor`.

**Resource scope / access policy** — Rakkr is default-deny. Beyond role
permissions, access is narrowed (or widened) by per-resource grants and
allow/deny **access policies** for users, groups, or everyone. An explicit deny
always wins. Scope is hierarchical: a recording inherits its schedule/node/room/
site context.

**Audit event** — the immutable record of an action: actor, permission, target,
outcome (`allowed` / `denied` / `failed` / `succeeded` / `partial`), reason,
correlation IDs, and before/after snapshots where relevant.

## Storage and lifecycle

**Cache** — the local copy of a recording on the recorder node and/or the
controller. Cache retention only runs _after_ a confirmed upload.

**Upload provider / upload queue** — the destinations (`stub`, SMB, S3) and the
retry queue that moves cached recordings to them.

**Node lifecycle action** — an allowlisted remote operation run against a node's
host over SSH via the Ansible runner: `install_dependencies`, `update_binary`,
`restart_service`, `rotate_trust`, `smoke_check`.

---

With the vocabulary in hand, continue to the
[architecture overview](../architecture/overview.md).
