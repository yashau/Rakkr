---
title: Storage & uploads
description: Local cache, named SMB/S3 upload destinations, upload policies, the retry queue, the runner, and cache retention.
sidebar:
  order: 6
---

# Storage & uploads

Rakkr treats the **local cache as the reliable source of record** and moves
recordings to durable storage afterward. Cache cleanup only runs _after_ a
confirmed upload, so an upload problem never costs you a recording.

## The flow

```text
capture → controller cache (checksum + waveform) → upload queue (one item per policy) → destination (SMB/S3) → cache retention
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

## Upload destinations

The controller uploads **directly** over the network — no OS mounts, no external
binaries. Operators add **multiple named SMB and S3 destinations** in **Settings →
Upload Destinations**; each destination owns its own connection details and
credentials.

| Kind     | Configured in the UI                                                              | Notes                                                                                                            |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **SMB**  | server, share, domain, username, password, upload path (+ port)                  | Direct SMB 2.1/3.x — no mount. Written bytes are read back and verified with SHA-256.                           |
| **S3**   | provider preset, region/endpoint, bucket, upload path, access key, secret key (+ path-style) | Direct S3 / S3-compatible (AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, DigitalOcean Spaces, custom). Sends `ChecksumSHA256`. |

`stub` is an internal API/test-only provider kind; it is never selectable or
visible in the UI.

SMB passwords and S3 secret access keys are **encrypted at rest** (AES-256-GCM
keyed from `RAKKR_SECRET_KEY`) and are **write-only** — the API and UI only
report whether a secret is set, never its value. There are no `RAKKR_`-prefixed
S3 variables and no `AWS_*` environment dependency: credentials come entirely
from the destination configuration.

## Upload policies

A policy selects a **destination** (or the built-in queue-only stub), an optional
**subfolder** appended to the destination's path/prefix, the trigger
(`on_recording_cached` or manual), a retry budget (`maxAttempts`), and whether to
**delete the controller cache after a confirmed upload**. Schedules and the manual
Start-Recording flow carry a **list** of upload policies (`uploadPolicyIds`), so a
single recording can fan out to several destinations.

When a recording is cached, the controller enqueues **one independent upload item
per enabled `on_recording_cached` policy**, each pinned to its destination. The
destinations upload independently — one failing does not fail the others. Once
every item is terminal the recording is reconciled to **`uploaded`** (all
succeeded) or **`partial`** (some succeeded, some failed); it stays `cached` if all
failed. The controller cache is deleted only after every destination is terminal
and a succeeded policy requested deletion, so a delete-cache policy never removes
the source while another destination still needs it.

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
