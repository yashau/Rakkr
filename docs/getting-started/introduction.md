---
title: Introduction
description: What Rakkr is, who it is for, and the principles that shape it.
sidebar:
  order: 1
---

# Introduction

Rakkr is a centrally managed platform for **reliable voice recording** across
rooms — meeting rooms, council chambers, studios, long-running halls. It is
designed for the case where "we probably got it" is not good enough: when a
recording matters, you want to know it is working _while_ it is happening.

## The problem Rakkr solves

Most room recording setups fail silently. A cable is half-seated, a channel is
muted, an interface drops to a stuck digital flatline, a disk fills up — and
nobody finds out until someone tries to play back an empty file the next day.

Rakkr treats the recording itself as something to be **measured and proven**, not
assumed:

- It samples live audio meters even when idle, so an operator can see signal
  before pressing record.
- It scores every recording for clipping, low signal, flatline, channel
  correlation, noise, and speech presence _as it captures_.
- It raises health events the moment something looks wrong, attached to the node,
  recording, schedule, or job in question.
- It keeps a local cache and a tamper-evident audit trail, so you can recover and
  explain what happened.

## Who it is for

- **Operators** who start, schedule, and monitor recordings from one console.
- **AV / IT teams** who manage a fleet of Linux recorder nodes and need
  inventory, health, and remote lifecycle management.
- **Auditors and administrators** who need every privileged action recorded with
  actor, permission, target, outcome, and before/after values.

## What's in the box

| Component                 | What it does                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Controller API**        | The brain: authentication, RBAC, audit, node inventory, recordings, jobs, schedules, settings/templates, health events, uploads, and Prometheus metrics. Hono on Node.                                             |
| **Operator console**      | The face: a React/Vite single-page app for dashboards, live meters, recording control, scheduling, the recording library, health, settings, access, and audit.                                                     |
| **Recorder agent**        | The hands: a Rust service on each Linux node that discovers audio interfaces, samples meters, runs capture jobs, scores audio quality, manages local cache, writes health evidence, and syncs with the controller. |
| **Database**              | Postgres via Drizzle ORM, with JSON/in-memory fallback stores so the controller still runs for many features without a database.                                                                                   |
| **Node lifecycle runner** | An optional Dockerized Ansible service that provisions and updates recorder nodes over SSH.                                                                                                                        |
| **Observability**         | A `/metrics` endpoint plus checked Prometheus alert rules, a Mimir remote-write example, and a Grafana dashboard.                                                                                                  |

## Product principles

These are the non-negotiables that shape every design decision. The full list
lives in the [source of truth](../RAKKR_SOURCE_OF_TRUTH.md); the ones worth
internalizing first:

- **Recording reliability beats cleverness.** A boring path that always works
  wins over a clever one that sometimes does.
- **UI state never replaces server-side authorization.** The console mirrors
  permissions for usability; the API is the enforcement point.
- **Every privileged action is RBAC-gated and audited.** Reads of sensitive data,
  writes, denied attempts, and service/automation actions all leave a record.
- **Live listening and recording control are privileged.** Hearing a room or
  controlling capture is never incidental access.
- **Defaults are profiles and templates, not hard-coded engine behavior.** Codec,
  bitrate, channel maps, watchdog thresholds, and retention are configuration.
- **ALSA-direct capture is the dependable default**, with PipeWire and JACK as
  first-class options. Hardware specifics (like the X32) must never make Rakkr
  device-specific.

## How Rakkr is built

Rakkr is developed **evidence-first**: capture, measure, explain, recover. That
discipline shows up in the codebase as a large suite of machine-checked
_baselines_ — documents whose claims are verified against the actual source by
scripts in the test gate. See
[Baselines & verification](../contributing/baselines.md) for how that works.

Next: [Quick start](quick-start.md) to run it locally, or
[Core concepts](concepts.md) for the vocabulary.
