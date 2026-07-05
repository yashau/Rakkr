---
title: Tune watchdog policies
description: Set the thresholds that decide when health alerts open and auto-resolve, and calibrate them from a node's real meter history.
sidebar:
  order: 14
---

# Tune watchdog policies

The [watchdog](respond-to-health-alerts.md) turns sustained audio problems into
health alerts. **Watchdog policies** are where you decide *how sensitive* it is —
thresholds are configuration, not code.

> **Who can do this:** viewing needs `settings:read`; creating and editing need
> `settings:manage`.

## Where to find them

Open **Settings** and scroll to **Watchdog Policies** (*"Scheduled signal health
thresholds."*).

## Create or edit a policy

1. Click **New** (or the pencil on an existing policy).
2. Set the thresholds that decide when alerts open and auto-resolve for sustained:
   - **low signal** (the flagship scheduled-window rule),
   - **clipping**,
   - **digital flatline** (stuck samples),
   - **high channel correlation** (a sign of a mis-wired/duplicated channel),
   - **high broadband-noise / noise / hum / static likelihood**,
   - and **loud non-speech audio** (for speech-required policies).
3. Save.

Use **Set default** on a policy to make it the one **pre-selected** for new
schedules and ad-hoc recordings (it shows a **Default** badge); there is one
default per type.

## Calibrate from real audio

Rather than guessing thresholds, you can **calibrate** a policy from a node's
recent meter history: Rakkr analyzes what that room actually sounds like and
recommends thresholds you can review and apply. This is the reliable way to avoid
both false alarms and missed problems.

## Good practice

- Start from the defaults, then calibrate per room where the acoustics differ.
- Remember the low-signal rule watches the **live recording** after a grace
  period — it is deliberately *not* simple silence detection, so set the
  cumulative-time and threshold to match how a real session behaves.

## See also

- [Respond to health alerts](respond-to-health-alerts.md) — working the alerts these policies raise
- [Health watchdog guide](../guides/health-watchdog.md) — signals and lifecycle in depth
