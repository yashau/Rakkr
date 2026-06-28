---
title: Health watchdog
description: How Rakkr detects bad recordings while they happen — signals, the scheduled low-signal rule, watchdog policies, and health-event lifecycle.
sidebar:
  order: 5
---

# Health watchdog

The watchdog exists to **catch bad recordings while they are still happening**,
not afterward. It combines on-node quality scoring with controller-side rules that
open, repeat, and auto-resolve health events.

## Signals it watches

The recorder agent scores live audio and the watchdog reasons over it to detect:

- **No meaningful signal** during a scheduled window;
- **Input too quiet** (low signal);
- **Digital flatline / stuck samples**;
- **Clipping**;
- **Excessive noise, hum, static likelihood**;
- **Device disconnects and audio-backend xruns**;
- **Encoder / file-writer failure**;
- **Recording file not growing**;
- **Channel mapping / correlation issues**;
- **Controller upload failures**.

Meter frames carry RMS/peak dBFS, clipping ratio, speech vs noise, estimated SNR,
first-pass intelligibility, hum/static/broadband-noise scores, and same/inverted
channel correlation — the raw material for these rules.

## The default scheduled voice rule

The flagship rule is **scheduled low-signal**:

> During the scheduled recording window, after a grace period, alert if the signal
> does not exceed a configurable dBFS threshold for enough cumulative time.

This is intentionally **not** simple silence detection and **not** a preflight
check — it watches the actual recording as it runs, so a room that goes silent
mid-session (a dead mic, a pulled cable) is caught while you can still react.

## Watchdog policies

Thresholds are configuration, not code. **Watchdog policies** (in
[Settings](../reference/configuration.md)) tune when alerts open and auto-resolve
for sustained:

- low signal,
- clipping,
- digital flatline,
- high channel correlation (suspicious mapping),
- high broadband-noise / noise / hum / static likelihood,
- and loud non-speech audio (for speech-required policies).

You can **calibrate** a policy from a node's recent meter history — the watchdog
calibration route recommends thresholds and can apply them, with RBAC-mirrored
controls in the Settings UI.

## Health-event lifecycle

The controller's **watchdog runner** (default every 30s) turns sustained problems
into **health events** and resolves them on recovery. Events also come directly
from the agent (capture/upload failures, device faults, disk/CPU pressure) and
from controller runners (stale-heartbeat nodes, failed uploads). Each event has a
type, severity (`info`/`warning`/`critical`), status, and is attached to a node,
recording, and/or schedule.

Operators work events on the **Health** page (`health:read`):

- Search/filter by status, severity, type, node, schedule, recording, and
  opened/resolved date ranges, with active chips.
- **Acknowledge**, **suppress** (mute), **resolve**, and **reopen** — individually
  or in bulk — all requiring `health:acknowledge`.
- Export scoped/selected events as CSV.

Per-recording and per-schedule **quality timelines** show event-specific evidence
(signal, speech, correlation, clipping, flatline, anomaly, upload-failure) laid
out across the recording's duration.

## On-node evidence

Even when a node is isolated from the controller, the agent keeps a local health
log — rotating JSONL by default, or a SQLite store — so an investigation can
reconstruct what happened. Once connectivity returns, events sync to the
controller. See the [recorder agent](../architecture/recorder-agent.md) for the
event families and the [CLI reference](../reference/recorder-agent.md) for the
threshold and log-rotation knobs.

## Metrics

Watchdog and audio-quality data is exported on `/metrics`
(`rakkr_input_*`, `rakkr_recording_watchdog_alerts_total`,
`rakkr_device_xruns_total`, …) for Prometheus alerting. See
[Metrics](../reference/metrics.md) and
[Observability](../observability/README.md).

The checked contract — including which signals are validated and which
long-duration real-room validations remain — is the `HEALTH_WATCHDOG_BASELINE`.
