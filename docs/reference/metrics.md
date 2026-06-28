---
title: Metrics
description: The Prometheus metrics exported by the Rakkr controller and what each one measures.
sidebar:
  order: 5
---

# Metrics

The controller exposes Prometheus metrics at **`GET /metrics`** (gated by
`metrics:read`, served at the root path, not under `/api/v1`). This page lists the
metric names; for the alerting, scrape, and dashboard artifacts see
[Observability](../observability/README.md).

## Nodes

| Metric                             | Meaning                             |
| ---------------------------------- | ----------------------------------- |
| `rakkr_node_online`                | Whether a node is currently online. |
| `rakkr_node_offline_alerts_active` | Active node-offline alerts.         |

## Audio input quality

Per-node/interface audio quality, derived from meter frames:

| Metric                              | Meaning                               |
| ----------------------------------- | ------------------------------------- |
| `rakkr_input_rms_dbfs`              | Input RMS level (dBFS).               |
| `rakkr_input_peak_dbfs`             | Input peak level (dBFS).              |
| `rakkr_input_clipping_ratio`        | Fraction of samples clipping.         |
| `rakkr_input_speech_score`          | Speech-presence score.                |
| `rakkr_input_noise_score`           | Noise score.                          |
| `rakkr_input_broadband_noise_score` | Broadband-noise score.                |
| `rakkr_input_estimated_snr_db`      | Estimated signal-to-noise ratio (dB). |
| `rakkr_input_intelligibility_score` | First-pass intelligibility score.     |

## Live listen monitor

| Metric                                        | Meaning                                |
| --------------------------------------------- | -------------------------------------- |
| `rakkr_listen_monitor_chunk_age_seconds`      | Age of the latest monitor audio chunk. |
| `rakkr_listen_monitor_chunk_duration_seconds` | Duration of the latest chunk.          |

## Recordings & jobs

| Metric                                  | Meaning                        |
| --------------------------------------- | ------------------------------ |
| `rakkr_recording_active`                | Active recordings.             |
| `rakkr_recording_duration_seconds`      | Recording duration.            |
| `rakkr_recording_bytes_written`         | Bytes written for a recording. |
| `rakkr_recording_watchdog_alerts_total` | Watchdog alerts raised.        |
| `rakkr_device_xruns_total`              | Audio device xruns.            |

## Uploads

| Metric                                  | Meaning                            |
| --------------------------------------- | ---------------------------------- |
| `rakkr_upload_queue_depth`              | Items waiting in the upload queue. |
| `rakkr_upload_queue_oldest_due_seconds` | Age of the oldest due queue item.  |
| `rakkr_upload_failures_total`           | Upload failures.                   |

## Events

| Metric                      | Meaning                 |
| --------------------------- | ----------------------- |
| `rakkr_audit_events_total`  | Audit events recorded.  |
| `rakkr_health_events_total` | Health events recorded. |

## What's exported overall

The exposition covers controller availability, node status, recording
duration/cache bytes, meter quality, listen-monitor freshness, audit and
health-event totals/active counts, watchdog alerts, xruns, and upload queue
depth/overdue/failures. The checked Prometheus alert rules, Mimir remote-write
example, and Grafana dashboard live under
[`docs/observability/`](../observability/README.md).
