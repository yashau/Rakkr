# Rakkr Transport Security Baseline

Status: MVP baseline plus certificate-rotation and mutual TLS scaffold checked; live certificate reload and deployed mutual TLS validation remain integration hardening.

## Policy

- Controller-to-recorder traffic must use transport-layer encryption on non-loopback networks.
- The controller can serve HTTPS when TLS certificate and key paths are configured.
- The controller can load active and next TLS certificate material for planned certificate rotation.
- The controller can request or require recorder client certificates when a client CA is configured.
- The recorder agent accepts HTTPS controller URLs by default.
- The recorder agent can trust an internal controller CA bundle for all controller requests.
- The recorder agent rejects non-loopback `http://` controller URLs by default.
- Localhost HTTP remains available for local development and smoke tests.
- Non-loopback plaintext requires an explicit development exception.

## Controller Configuration

| Variable                         | Purpose                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `RAKKR_API_TLS_CERT_PATH`        | PEM certificate path for HTTPS listener                                               |
| `RAKKR_API_TLS_KEY_PATH`         | PEM private key path for HTTPS listener                                               |
| `RAKKR_API_TLS_CA_PATH`          | Optional CA bundle path                                                               |
| `RAKKR_API_TLS_NEXT_CERT_PATH`   | Optional next PEM certificate path for planned rotation                               |
| `RAKKR_API_TLS_NEXT_KEY_PATH`    | Optional next PEM private key path for planned rotation                               |
| `RAKKR_API_TLS_NEXT_NOT_BEFORE`  | Optional ISO timestamp documenting when next certificate material should become valid |
| `RAKKR_API_TLS_CLIENT_CA_PATH`   | Optional client CA bundle used to verify recorder client certificates                 |
| `RAKKR_API_TLS_CLIENT_CERT_MODE` | `off`, `optional`, or `required` recorder client certificate mode                     |

`RAKKR_API_TLS_CERT_PATH` and `RAKKR_API_TLS_KEY_PATH` must be set together.
`RAKKR_API_TLS_NEXT_CERT_PATH` and `RAKKR_API_TLS_NEXT_KEY_PATH` must be set together.
`RAKKR_API_TLS_CLIENT_CERT_MODE=optional` or `required` requires `RAKKR_API_TLS_CLIENT_CA_PATH` or `RAKKR_API_TLS_CA_PATH`.

## Agent Configuration

| Variable                          | Purpose                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `RAKKR_CONTROLLER_URL`            | Controller URL; use `https://` for LAN nodes                               |
| `RAKKR_CONTROLLER_CA_CERT_PATH`   | Optional PEM CA certificate path trusted by the agent for controller HTTPS |
| `RAKKR_ALLOW_INSECURE_CONTROLLER` | Explicit development override for non-loopback `http://`                   |

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

| Check                                         | Evidence                                                                                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS controller listener                     | `apps/api/src/transport-security.ts`, `apps/api/test/transport-security.test.ts`                                                                                                                                             |
| Certificate rotation and mutual TLS scaffold  | `apps/api/src/transport-security.ts`, `apps/api/test/transport-security.test.ts`                                                                                                                                             |
| Local TLS fixtures                            | `apps/api/test/fixtures/tls/active-cert.pem`, `apps/api/test/fixtures/tls/active-key.pem`, `apps/api/test/fixtures/tls/next-cert.pem`, `apps/api/test/fixtures/tls/next-key.pem`, `apps/api/test/fixtures/tls/client-ca.pem` |
| Agent plaintext guard and controller CA trust | `crates/recorder-agent/src/config.rs`, `crates/recorder-agent/src/controller_http.rs`                                                                                                                                        |
| Prometheus scrape example uses HTTPS          | `docs/observability/prometheus-mimir.example.yml`                                                                                                                                                                            |

## Checked By

| Check                       | Command                             |
| --------------------------- | ----------------------------------- |
| Transport security baseline | `mise run security:check-transport` |

`mise run check` runs the transport security baseline check.
