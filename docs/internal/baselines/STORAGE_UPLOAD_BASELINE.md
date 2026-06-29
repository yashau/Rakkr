# Rakkr Storage Upload Baseline

Status: MVP baseline checked.

## Behavior

- Local recorder/controller cache remains the reliable source until an upload is confirmed.
- The controller performs direct SMB and S3 uploads over the network with no OS mounts or external binaries; `stub` remains an API/test-only provider hidden from the UI.
- SMB uploads connect with server/share/domain/username/password (no mount), create directories as needed, write the file, and verify the written bytes with SHA-256.
- S3 uploads use an explicitly configured provider preset, region/endpoint, bucket/prefix, and access/secret keys, and send `ChecksumSHA256`.
- SMB passwords and S3 secret access keys are encrypted at rest (AES-256-GCM keyed from `RAKKR_SECRET_KEY`, with a development fallback) and are write-only: never returned in API responses or audit events.
- Provider readiness reports enabled, disabled, not-configured, and implemented state.
- Upload policies choose provider, trigger, retry budget, and cache-retention behavior.
- Cached recordings can be queued manually, in bulk, or automatically when policy trigger is `on_recording_cached`.
- Replayed cache attach requests reuse an already-succeeded upload queue item when the cached artifact, provider, policy, and target are unchanged.
- Started upload attempts are leased via `nextAttemptAt` so concurrent runners do not duplicate in-flight work and controller crash/power-loss recovery makes stranded `retrying` items due again after the lease expires.
- Upload queue entries are visible, filterable, retryable, audited, metric-exported, and resource-scoped.
- Upload runner processes due queue items on interval or run-now and writes system audit events.
- Controller cache deletion happens only after confirmed non-stub upload and matching policy.
- Settings and runner UI mirror `settings:*` and `recording:*` RBAC decisions.
- Provider, policy, and queue persistence is Postgres-backed with JSON fallback.

## Checked By

| Check                                                                                        | Evidence                                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Stub, SMB, S3, checksum, retry budget, in-flight lease recovery                              | `apps/api/test/upload-executor.test.ts`                                                      |
| Runner audit, run-now, cache retention                                                       | `apps/api/test/upload-runner.test.ts`                                                        |
| Provider readiness                                                                           | `apps/api/test/upload-providers.test.ts`                                                     |
| Policy templates and auto-queue input                                                        | `apps/api/test/upload-policies.test.ts`                                                      |
| Queue retries, duplicate completed-upload attach idempotency, and retrying-item lease expiry | `apps/api/test/upload-queue.test.ts`, `apps/api/test/agent-cache-idempotency-routes.test.ts` |
| Recording queue routes and scoped filters                                                    | `apps/api/test/recording-upload-queue-routes.test.ts`                                        |
| Settings route RBAC                                                                          | `apps/api/test/settings-routes.test.ts`                                                      |
| Upload metrics                                                                               | `apps/api/test/metrics.test.ts`                                                              |
| Agent cache auto-queue lifecycle                                                             | `apps/api/test/agent-routes.test.ts`                                                         |
| Upload runner UI RBAC                                                                        | `apps/web/src/lib/upload-runner-panel-helpers.test.ts`                                       |

`mise run storage:check` validates this baseline, and `mise run check` runs it.
