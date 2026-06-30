---
title: Scheduling
description: Human-friendly recurring recordings — recurrence modes, buffers, pauses, exceptions, timezones, and schedule-owned metadata.
sidebar:
  order: 4
---

# Scheduling

Schedules create recording jobs automatically. Rakkr's scheduler is deliberately
**human-friendly: no cron syntax is ever exposed.** Schedules are managed under
`schedule:read` (view) and `schedule:manage` (create/edit/control).

## Recurrence modes

A schedule has one recurrence mode plus shared timing options:

| Mode        | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `manual`    | No automatic runs; run-now only.                |
| `once`      | A single one-off window.                        |
| `daily`     | Every day at a time.                            |
| `weekly`    | Selected days of the week.                      |
| `monthly`   | A day of the month (clamped on shorter months). |
| `always_on` | Continuous capture.                             |

The console also accepts quick natural-language phrases that compile to structured
recurrence, so operators rarely build rules by hand.

## Timing controls

- **Explicit timezone** per schedule — all windows are computed in it.
- **Start-early / stop-late buffers** — begin before and end after the nominal
  window to avoid clipping the start or end of a session.
- **Exceptions** — `skip` a single occurrence by date, or `pause` the schedule
  across a `startDate`–`endDate` range (a pause is an exception action, not a
  separate control).
- No arbitrary product limit on the number of schedules.

## Schedule-owned metadata

Scheduled recordings **inherit everything from the schedule**: filename and folder
templates, tags, recording profile, capture backend/interface (or node defaults),
watchdog policy, retention policy, and upload policy. This keeps a room's
recordings consistent without per-run configuration.

A schedule can also pin a **channel selection** and output mode on its interface
(the same picker as ad-hoc starts), so different schedules can own different channel
pairs of one device. When a due run's channels are already in use by another
recording on that interface, the scheduler **defers** that occurrence and opens a
`schedule.capture_channels_busy` health alert rather than failing — the recording
already holding the channels keeps running.

## How due runs become recordings

The controller's **schedule runner** (default every 30s) materializes due windows:

1. Compute the next due occurrence in the schedule's timezone, honoring buffers,
   pauses, and exceptions.
2. Create recording jobs under the `system:scheduler` service identity (audited),
   splitting long windows into **ordered track jobs** when the profile sets a
   maximum track length.
3. From there, jobs follow the normal [recording lifecycle](recording.md) —
   claimed by the node, captured, cached, health-synced, and upload-queued.

`run-now` and `skip-next` let operators force or skip the next occurrence on
demand; failures are retried after a configurable delay.

## Managing schedules

- **Schedules page** (`schedule:read`) — create/edit the full schedule (node,
  room, timezone, recurrence, buffers, pauses, templates, profile, policies,
  tags); filter and search by enabled state, node, backend, and interface with
  active chips; each card shows the recurrence summary, next run, upcoming runs,
  and a recent audit timeline.
- **Schedule detail** (`/schedules/$id`) — upcoming windows, the recordings and
  jobs the schedule produced (with quality timelines), health events, and the
  audit timeline. Linked cached recordings can be played and downloaded with
  RBAC-mirrored controls.

All write and control actions (create, update, run-now, skip-next, delete) require
`schedule:manage` and are audited; reads of related recordings, jobs, health, and
node context mirror their own granular permissions.

The checked scheduler contract is the `SCHEDULER_BASELINE`, including recurrence
tests for buffers, pauses, monthly clamping, overnight duration, and skip-next.
