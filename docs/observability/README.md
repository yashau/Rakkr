# Rakkr Observability

Status: MVP baseline checked.

## Surfaces

| Surface | Artifact |
| ------- | -------- |
| Controller metrics | `GET /metrics` |
| Prometheus alerts | `docs/observability/rakkr-alerts.yml` |
| Prometheus + Mimir | `docs/observability/prometheus-mimir.example.yml` |
| Grafana dashboard | `docs/observability/grafana-dashboard.example.json` |
| Agent local log | Rotating JSONL health log on recorder nodes |
| Controller events | Central health and audit event tables |

## Operator Path

1. Scrape the controller `/metrics` endpoint with TLS enabled.
2. Load `rakkr-alerts.yml` into Prometheus.
3. Send long-term metrics to Mimir with `remote_write`.
4. Import `grafana-dashboard.example.json` into Grafana.
5. Use central health/audit events for investigation and local node logs when a recorder is isolated.

## Checked By

| Check | Command |
| ----- | ------- |
| Alert rules | `mise run ops:check-alerts` |
| Prometheus/Mimir config | `mise run ops:check-prometheus` |
| Grafana dashboard | `mise run ops:check-grafana` |
| Runbook links | `mise run ops:check-observability-docs` |

`mise run check` runs all observability checks.
