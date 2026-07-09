---
title: Track recording jobs
description: Use the Jobs workbench to see what's queued, running, or failed, read failure reasons, and retry or stop jobs.
sidebar:
  order: 6
---

# Track recording jobs

Where the [Recordings](manage-recordings.md) page shows finished results, the
**Jobs** page shows the *work that produces them*. Use it when something is stuck
or has failed.

> **Who can do this:** viewing needs `recording:read`; stopping and retrying need
> `recording:control` (or the room's `operate` capability).

## See what's happening

1. Open **Jobs** in the left nav (titled **"Recording Jobs"**).
2. The **status tiles** summarize active / queued / completed / failed jobs.
3. **Filter** by status, capture backend, node, interface, and created date to
   focus on what matters.
4. Each job row shows its capture settings, a claimed-by/lease badge, a
   created / started / completed timeline, and — if it failed — the **failure
   reason**.

## Retry or stop a job

- **Stop** an active job (needs `recording:control`). The partial is finalized as
  a completed recording.
- **Retry** a failed or cancelled job to run it again.
- Do either **individually or in bulk**, and **export** the filtered/selected
  jobs as CSV.

## Understand the lifecycle

A job moves through these states:

1. **queued** — created, waiting for a node.
2. **running** — a node has leased it (its **claimed-by** badge shows which) and
   is capturing, heartbeating to the controller.
3. **stop_requested** — a stop was requested while it was running; the node is
   wrapping up.
4. **completed** / **failed** / **cancelled** — terminal.

**claimed** is not a status — it's a lease phase, tracked via the job's
`claimedBy` field as a job starts running. A controller safety net automatically
fails orphaned "running" jobs whose lease expired, so a crashed agent never leaves
a recording stranded. The full sequence is in the
[Recording guide](../guides/recording.md#the-job-lifecycle).

## See also

- [Find & manage recordings](manage-recordings.md) — the finished output
- [Respond to health alerts](respond-to-health-alerts.md) — quality problems, not just job failures
