# 📈 Rakkr Observability

Status: MVP baseline checked.

Rakkr exposes both live metrics and investigation-grade event trails. Prometheus handles fast operational signals, Grafana gives operators a single board to scan, and central health/audit events keep the story attached to recordings, nodes, jobs, and settings.

## ✨ Operator Promise

When something degrades, Rakkr should answer three questions quickly:

1. What changed?
2. Which node, recording, or job is affected?
3. Is there enough evidence to recover without guessing?

## 🧭 Signal Map

| Surface | Artifact |
| ------- | -------- |
| Controller metrics | `GET /metrics` |
| Prometheus alerts | `docs/observability/rakkr-alerts.yml` |
| Prometheus + Mimir | `docs/observability/prometheus-mimir.example.yml` |
| Grafana dashboard | `docs/observability/grafana-dashboard.example.json` |
| Agent local log | Rotating JSONL health log on recorder nodes |
| Controller events | Central health and audit event tables |

## 🧑‍💻 Operator Path

1. Scrape the controller `GET /metrics` endpoint with TLS enabled.
2. Load `docs/observability/rakkr-alerts.yml` into Prometheus.
3. Send long-term metrics to Mimir with `docs/observability/prometheus-mimir.example.yml`.
4. Import `docs/observability/grafana-dashboard.example.json` into Grafana.
5. Use central health/audit events for incident context.
6. Fall back to the Rotating JSONL health log on recorder nodes when a node is isolated.

## 🚨 What To Watch

| Category | Examples |
| -------- | -------- |
| Recorder health | Node liveness, xrun/device faults, clipping, flatline, low signal, channel correlation |
| Recording flow | Active recordings, cached recordings, watchdog alerts, upload failures |
| Controller health | API availability, audit totals, health-event totals, queue state |
| Capacity and storage | Recording duration, cache bytes, upload queue pressure |

## ✅ Checked By

| Check | Command |
| ----- | ------- |
| Alert rules | `mise run ops:check-alerts` |
| Prometheus/Mimir config | `mise run ops:check-prometheus` |
| Grafana dashboard | `mise run ops:check-grafana` |
| Runbook links | `mise run ops:check-observability-docs` |

`mise run check` runs all observability checks.
