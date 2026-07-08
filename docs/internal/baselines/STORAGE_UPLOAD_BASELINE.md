# Rakkr Storage Upload Baseline

Status: MVP baseline checked.

## Behavior

- Local recorder/controller cache remains the reliable source until an upload is confirmed.
- The controller performs direct SMB and S3 uploads over the network with no OS mounts or external binaries; `stub` remains an API/test-only provider kind hidden from the UI.
- Operators configure multiple named SMB and S3 destinations; each destination owns its own server/share or bucket/prefix plus credentials, and upload policies select a destination by id.
- A policy may add a subfolder override appended to the destination's path/prefix; the executor honors it in the SMB path and S3 key.
- SMB uploads connect with server/share/domain/username/password (no mount), create directories as needed, write the file, and verify the written bytes with SHA-256.
- S3 uploads use an explicitly configured provider preset, region/endpoint, bucket/prefix, and access/secret keys, and send `ChecksumSHA256`.
- SMB passwords and S3 secret access keys are encrypted at rest (AES-256-GCM keyed from `RAKKR_SECRET_KEY`, with a development fallback) and are write-only: never returned in API responses or audit events.
- Provider readiness reports enabled, disabled, not-configured, and implemented state.
- Upload policies choose a destination, trigger, retry budget, and cache-retention behavior.
- Schedules and ad hoc recordings carry a list of upload policies; when a recording is cached the controller fans out one upload queue item per enabled `on_recording_cached` policy, each pinned to its destination.
- Destinations upload independently: one destination failing does not fail the others. Once every item for a recording is terminal the controller reconciles the recording to `uploaded` (all succeeded) or `partial` (at least one succeeded and at least one failed), leaving it cached when all failed.
- Replayed cache attach requests reuse an already-succeeded upload queue item when the cached artifact, destination, policy, and target are unchanged.
- Started upload attempts are leased via `nextAttemptAt` so concurrent runners do not duplicate in-flight work and controller crash/power-loss recovery makes stranded `retrying` items due again after the lease expires.
- Upload queue entries are visible, filterable, retryable, audited, metric-exported, and resource-scoped.
- Upload runner processes due queue items on interval or run-now and writes system audit events.
- Controller cache deletion happens only after confirmed non-stub upload and matching policy, and only once every destination for the recording is terminal so a delete-cache policy never removes the source while another destination still needs it.
- Settings and runner UI mirror `settings:*` and `recording:*` RBAC decisions.
- Provider, policy, and queue persistence is Postgres-backed with JSON fallback.

## Checked By

| Check                                                                                        | Evidence                                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Stub, SMB, S3, checksum, retry budget, in-flight lease recovery                              | `apps/api/test/upload-executor.test.ts`                                                      |
| Runner audit, run-now, cache retention, partial fan-out reconciliation                       | `apps/api/test/upload-runner.test.ts`, `apps/api/test/upload-runner-routes.test.ts`          |
| Destination readiness and CRUD                                                               | `apps/api/test/upload-destinations.test.ts`                                                  |
| Policy templates and auto-queue input                                                        | `apps/api/test/upload-policies.test.ts`                                                      |
| Queue retries, duplicate completed-upload attach idempotency, and retrying-item lease expiry | `apps/api/test/upload-queue.test.ts`, `apps/api/test/agent-cache-idempotency-routes.test.ts` |
| Recording queue routes and scoped filters                                                    | `apps/api/test/recording-upload-queue-routes.test.ts`                                        |
| Settings route RBAC                                                                          | `apps/api/test/settings-routes.test.ts`                                                      |
| Upload metrics                                                                               | `apps/api/test/metrics.test.ts`                                                              |
| Agent cache auto-queue lifecycle                                                             | `apps/api/test/agent-routes.test.ts`, `apps/api/test/agent-routes-recording-lifecycle.test.ts` |
| Upload runner UI RBAC                                                                        | `apps/web/src/lib/upload-runner-panel-helpers.test.ts`                                       |

`mise run storage:check` validates this baseline, and `mise run check` runs it.
