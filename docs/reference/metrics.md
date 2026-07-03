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

Most series carry labels — the common ones are `node_id`, `channel` (and
`interface_id`) on per-channel audio metrics, `severity`/`status`/`event_type` on
health metrics, `action`/`outcome`/`permission`/`actor_type` on audit, and
`provider`/`status` on uploads. Counters end in `_total`; everything else is a
gauge.

## Controller

| Metric                                | Meaning                            |
| ------------------------------------- | ---------------------------------- |
| `rakkr_controller_started_at_seconds` | Controller process start timestamp. |
| `rakkr_database_unavailable`          | Controller database reachability (1 = unavailable); emitted so `/metrics` degrades instead of returning 503 during a database outage. |

## Nodes

| Metric                             | Meaning                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `rakkr_node_online`                | Whether a recorder node is reachable.                      |
| `rakkr_node_offline_alerts_active` | Unresolved node-offline health events (by node/severity/status). |

## Audio input quality

Per-channel audio quality, derived from the latest meter frame (labelled by
`node_id`/`interface_id`/`channel`):

| Metric                                   | Meaning                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `rakkr_input_rms_dbfs`                   | Latest RMS input level (dBFS).                     |
| `rakkr_input_peak_dbfs`                  | Latest peak input level (dBFS).                    |
| `rakkr_input_clipping_ratio`             | Latest clipping state.                             |
| `rakkr_input_speech_score`               | Speech-likelihood score.                           |
| `rakkr_input_noise_score`                | Non-speech noise score.                            |
| `rakkr_input_broadband_noise_score`      | Broadband-noise likelihood score.                  |
| `rakkr_input_hum_score`                  | Hum-likelihood score.                              |
| `rakkr_input_static_score`               | Static-likelihood score.                           |
| `rakkr_input_estimated_snr_db`           | Estimated signal-to-noise ratio (dB).              |
| `rakkr_input_intelligibility_score`      | First-pass voice intelligibility score.            |
| `rakkr_input_channel_correlation_score`  | Strongest same-interface channel correlation score. |

## Live listen monitor

| Metric                                        | Meaning                                |
| --------------------------------------------- | -------------------------------------- |
| `rakkr_listen_monitor_chunk_age_seconds`      | Age of the latest monitor audio chunk. |
| `rakkr_listen_monitor_chunk_duration_seconds` | Duration of the latest chunk.          |

## Recordings & jobs

| Metric                                   | Meaning                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `rakkr_recording_active`                 | Active recording jobs by node.                           |
| `rakkr_recording_cached`                 | Cached recordings by node.                               |
| `rakkr_recording_duration_seconds`       | Recording duration by recording.                         |
| `rakkr_recording_bytes_written`          | Controller-cached recording bytes by recording.          |
| `rakkr_recording_jobs`                   | Recording jobs by node and status.                       |
| `rakkr_recording_watchdog_alerts_active` | Unresolved watchdog health events (by severity).         |
| `rakkr_recording_watchdog_alerts_total`  | Watchdog health events raised (by severity).             |
| `rakkr_device_xruns_active`              | Unresolved audio-xrun health events.                     |
| `rakkr_device_xruns_total`               | Audio-xrun health events (by severity).                  |

## Uploads

| Metric                                  | Meaning                                          |
| --------------------------------------- | ------------------------------------------------ |
| `rakkr_upload_queue_depth`              | Upload queue items by provider and status.       |
| `rakkr_upload_queue_oldest_due_seconds` | Age of the oldest due queue item.                |
| `rakkr_upload_failures_total`           | Upload failures.                                 |

## Events

| Metric                       | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `rakkr_audit_events_total`   | Audit events by action, outcome, permission, and actor type.  |
| `rakkr_health_events_active` | Unresolved health events by severity and status.              |
| `rakkr_health_events_total`  | Health events by event type, severity, and status.            |

The checked Prometheus alert rules, Mimir remote-write example, and Grafana
dashboard live under [`docs/observability/`](../observability/README.md).
