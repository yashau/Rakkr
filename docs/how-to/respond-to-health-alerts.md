---
title: Respond to health alerts
description: Understand what the watchdog catches, then acknowledge, suppress, resolve, or reopen health events from the Health page.
sidebar:
  order: 7
---

# Respond to health alerts

Rakkr's **watchdog** catches bad recordings **while they are still happening**,
not the next day. As an operator you mostly *respond* to what it raises;
administrators *tune* it (see [Tune watchdog policies](tune-watchdog-policies.md)).

> **Who can do this:** viewing needs `health:read`; acknowledging, suppressing,
> resolving, and reopening need `health:acknowledge`.

## What the watchdog catches

It flags: no meaningful signal during a scheduled window, input too quiet, a
digital flatline (stuck samples), clipping, excessive noise/hum/static, device
disconnects and audio-backend glitches, encoder/file-writer failures, a recording
file that stops growing, channel-mapping/correlation problems, and upload
failures.

Its flagship rule is **scheduled low-signal**: during a recording window, after a
grace period, it alerts if the signal never rises above a set level for enough
cumulative time. This is *not* simple silence detection and *not* a one-time
preflight — it watches the live recording, so a mic that dies mid-session is
caught while you can still fix it.

## Work the Health page

1. Open **Health** in the left nav. Each event has a type, **severity**
   (`info` / `warning` / `critical`), **status**, and the node/recording/schedule
   it's attached to.
2. **Filter** by status, severity, type, node, schedule, recording, and
   opened/resolved date ranges.
3. Act on an event with the always-visible inline buttons in its **Actions**
   column:

   | Action      | Use it when…                                                          |
   | ----------- | --------------------------------------------------------------------- |
   | **Ack**     | You've seen it and are working on it.                                 |
   | **Mute 1h** | It's expected (e.g. known maintenance) — a fixed one-hour suppression. |
   | **Resolve** | It's handled / recovered.                                             |
   | **Reopen**  | It came back or was resolved prematurely.                             |

4. You can act on many events at once (bulk), and **export** the filtered or
   selected events as CSV.

## Where alerts also show up

You don't have to live on the Health page — alerts surface in context too:

- the **Dashboard → Active Incidents** panel (with quick Acknowledge / Resolve);
- a node's expanded card on the **Nodes** page;
- the **quality timelines** on individual recordings and schedules.

## See also

- [Tune watchdog policies](tune-watchdog-policies.md) — change when alerts fire (admin)
- [Monitor a room live](monitor-rooms-live.md) — catch problems yourself, live
- [Health watchdog guide](../guides/health-watchdog.md) — signals and lifecycle in depth
