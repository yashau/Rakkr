# Rakkr Transport Security Baseline

Status: MVP baseline checked; certificate rotation and mutual TLS remain future hardening.

## Policy

- Controller-to-recorder traffic must use transport-layer encryption on non-loopback networks.
- The controller can serve HTTPS when TLS certificate and key paths are configured.
- The recorder agent accepts HTTPS controller URLs by default.
- The recorder agent rejects non-loopback `http://` controller URLs by default.
- Localhost HTTP remains available for local development and smoke tests.
- Non-loopback plaintext requires an explicit development exception.

## Controller Configuration

| Variable | Purpose |
| -------- | ------- |
| `RAKKR_API_TLS_CERT_PATH` | PEM certificate path for HTTPS listener |
| `RAKKR_API_TLS_KEY_PATH` | PEM private key path for HTTPS listener |
| `RAKKR_API_TLS_CA_PATH` | Optional CA bundle path |

`RAKKR_API_TLS_CERT_PATH` and `RAKKR_API_TLS_KEY_PATH` must be set together.

## Agent Configuration

| Variable | Purpose |
| -------- | ------- |
| `RAKKR_CONTROLLER_URL` | Controller URL; use `https://` for LAN nodes |
| `RAKKR_ALLOW_INSECURE_CONTROLLER` | Explicit development override for non-loopback `http://` |

## Encrypted Flows

- Enrollment.
- Heartbeat and status.
- Commands and acknowledgements.
- Meter frames.
- Live monitor audio.
- Recording and job metadata.
- Health and alert updates.
- Local event log sync.

## Evidence

| Check | Evidence |
| ----- | -------- |
| HTTPS controller listener | `apps/api/src/transport-security.ts`, `apps/api/test/transport-security.test.ts` |
| Agent plaintext guard | `crates/recorder-agent/src/config.rs` |
| Prometheus scrape example uses HTTPS | `docs/observability/prometheus-mimir.example.yml` |

## Checked By

| Check | Command |
| ----- | ------- |
| Transport security baseline | `mise run security:check-transport` |

`mise run check` runs the transport security baseline check.
