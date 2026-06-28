---
title: Storage & uploads
description: Local cache, upload providers (stub/SMB/S3), upload policies, the retry queue, the runner, and cache retention.
sidebar:
  order: 6
---

# Storage & uploads

Rakkr treats the **local cache as the reliable source of record** and moves
recordings to durable storage afterward. Cache cleanup only runs _after_ a
confirmed upload, so an upload problem never costs you a recording.

## The flow

```text
capture → controller cache (checksum + waveform) → upload queue → provider (SMB/S3) → cache retention
```

1. A finished recording is cached on the controller with a SHA-256 checksum and a
   waveform preview.
2. If an enabled upload policy's trigger is `on_recording_cached`, the recording
   is **auto-queued** for upload. Operators can also enqueue manually (single or
   bulk) and retry failed items.
3. The **upload runner** processes due queue items against provider readiness and
   a retry budget.
4. On a confirmed non-stub upload, **retention policies** may delete the
   controller cache.

## Upload providers

| Provider | Target                                                             | Notes                                                                                 |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Stub** | `stub://queue-only`                                                | Dry-run queue processing; never deletes cache.                                        |
| **SMB**  | A mounted share, e.g. `/mnt/rakkr-recordings` or `file:///mnt/...` | The target must be OS-mounted; copied bytes are verified with SHA-256.                |
| **S3**   | `s3://bucket/prefix`                                               | Uses the standard AWS SDK environment for credentials/region; sends `ChecksumSHA256`. |

Providers expose enabled state, target, credential reference, readiness, and
implementation status. There are no `RAKKR_`-prefixed S3 variables — S3 reads the
normal `AWS_*` environment; SMB targets must be mounted on the host.

## Upload policies

A policy chooses the provider, the trigger (`on_recording_cached` or manual), a
retry budget (`maxAttempts`), and whether to **delete the controller cache after a
confirmed upload**. Schedules and recordings carry an `uploadPolicyId` so the
right destination is selected automatically.

## The queue and runner

- **Upload queue** — auditable, visible, and retryable. Filter by status,
  provider, and recording; see scoped item detail and action summaries. The
  Recordings page summarizes visible queue counts by status; Settings exposes a
  full upload-queue workbench with filters and scoped retry controls.
- **Upload runner** — runs on an interval (default 60s, batched), executing due
  items and auditing per-summary and per-item outcomes. Its status/read mirror
  `recording:read`; `run-now` mirrors `recording:control`. Tuning knobs
  (`RAKKR_UPLOAD_RUNNER_*`, lease, max attempts) are in the
  [configuration reference](../reference/configuration.md#background-runners--leases).

## Cache retention

Retention has two sides:

- **Controller cache** — the retention runner (default 300s) executes max-age and
  max-bytes cleanup with audit events; upload policies can delete cache after a
  confirmed upload.
- **Recorder cache** — policies are pushed to nodes via node config. The agent
  deletes after successful controller attach (delete-after-upload, with
  delete-failure reporting) and, when idle, sweeps by max-age, max-bytes, and
  min-free-disk using a local uploaded-cache manifest.

## Observability

Upload health is on `/metrics`: `rakkr_upload_queue_depth`,
`rakkr_upload_queue_oldest_due_seconds`, and `rakkr_upload_failures_total`,
covered by the checked Prometheus alert rules. See
[Observability](../observability/README.md).

The checked contract is the `STORAGE_UPLOAD_BASELINE`; operator-facing
organization and runner behavior are also covered by the `OPERATIONS_BASELINE`.
