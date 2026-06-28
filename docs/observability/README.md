---
title: Observability
description: Live metrics and investigation-grade event trails — the controller /metrics endpoint, Prometheus alerts, Mimir, Grafana, and node health logs.
sidebar:
  order: 2
---

# Observability

Rakkr exposes both **live metrics** and **investigation-grade event trails**.
Prometheus handles fast operational signals, Grafana gives operators one board to
scan, and central health/audit events keep the story attached to recordings,
nodes, jobs, and settings.

## The operator promise

When something degrades, Rakkr should answer three questions quickly:

1. **What changed?**
2. **Which node, recording, or job is affected?**
3. **Is there enough evidence to recover without guessing?**

## Signal map

| Surface            | Artifact                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| Controller metrics | `GET /metrics` (see the [metrics reference](../reference/metrics.md))    |
| Prometheus alerts  | `docs/observability/rakkr-alerts.yml`                                    |
| Prometheus + Mimir | `docs/observability/prometheus-mimir.example.yml`                        |
| Grafana dashboard  | `docs/observability/grafana-dashboard.example.json`                      |
| Agent local log    | Rotating JSONL health log or SQLite health-event store on recorder nodes |
| Controller events  | Central health and audit event tables                                    |

## Operator path

1. Scrape the controller `GET /metrics` endpoint with TLS enabled.
2. Load `docs/observability/rakkr-alerts.yml` into Prometheus.
3. Send long-term metrics to Mimir with
   `docs/observability/prometheus-mimir.example.yml`.
4. Import `docs/observability/grafana-dashboard.example.json` into Grafana.
5. Use central health/audit events for incident context (the **Health** and
   **Audit** pages in the console).
6. Fall back to the rotating JSONL health log or SQLite health-event store on
   recorder nodes when a node is isolated.

## What to watch

| Category             | Examples                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| Recorder health      | Node liveness, xrun/device faults, clipping, flatline, low signal, channel correlation |
| Recording flow       | Active recordings, cached recordings, watchdog alerts, upload failures                 |
| Controller health    | API availability, audit totals, health-event totals, queue state                       |
| Capacity and storage | Recording duration, cache bytes, upload queue pressure                                 |

The metric names behind these are in the
[metrics reference](../reference/metrics.md); the watchdog rules that raise
alerts are in the [health watchdog guide](../guides/health-watchdog.md).

## Checked artifacts

These example configs are validated as part of `mise run check`:

| Check                   | Command                                 |
| ----------------------- | --------------------------------------- |
| Alert rules             | `mise run ops:check-alerts`             |
| Prometheus/Mimir config | `mise run ops:check-prometheus`         |
| Grafana dashboard       | `mise run ops:check-grafana`            |
| Runbook links           | `mise run ops:check-observability-docs` |
