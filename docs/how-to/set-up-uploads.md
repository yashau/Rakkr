---
title: Set up storage & uploads
description: Add SMB/S3 destinations, create upload policies that ship recordings to them, watch the upload queue, and configure cache retention.
sidebar:
  order: 15
---

# Set up storage & uploads

Rakkr keeps a finished recording in its **local cache** and then ships it to
durable storage. This guide sets up where recordings go and when the cache is
cleaned up. Cleanup only runs **after a confirmed upload**, so an upload problem
never costs you a recording.

> **Who can do this:** viewing needs `settings:read`; creating and editing
> destinations, policies, and retention need `settings:manage`.

All three sections below are on the **Settings** page.

## 1. Add an upload destination

Under **Upload Destinations** (*"Named SMB and S3 storage targets."*), the
controller uploads **directly** over the network — no OS mounts, no external
tools.

1. Click **New**.
2. Choose the kind and fill in its connection details:

   | Kind    | You provide                                                            |
   | ------- | --------------------------------------------------------------------- |
   | **SMB** | server, share, domain, username, password, upload path (+ port)       |
   | **S3**  | provider preset, region/endpoint, bucket, upload path, access & secret key |

   S3 works with AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, DigitalOcean
   Spaces, and custom endpoints.
3. Save. Uploaded bytes are read back and **checksum-verified**.

> Passwords and secret keys are **encrypted at rest and write-only** — the
> console only ever tells you whether a secret is *set*, never its value. To
> change one, enter a new value.

## 2. Create an upload policy

Under **Upload Policies** (*"Provider selection for ad hoc and scheduled
queues."*), a policy connects recordings to a destination.

1. Click **New**.
2. Set:
   - the **destination** (from step 1, **required** — every policy uploads to a
     real SMB/S3 target) and an optional **subfolder**;
   - the **trigger** — `on_recording_cached` (automatic) or manual;
   - a **retry budget** (max attempts);
   - whether to **delete the controller cache after a confirmed upload**.
3. Save.

Use **Set default** on a policy to make it the one **pre-selected** for new
schedules and ad-hoc recordings (it shows a **Default** badge); there is one
default per type, and leaving it unset means new recordings default to no upload.

Schedules and the ad-hoc start panel carry a **list** of upload policies, so one
recording can fan out to several destinations as independent queue items —
reconciled to **`uploaded`** (all succeeded) or **`partial`** (some failed). The
cache is only deleted once every destination is done and a succeeded policy asked
for deletion.

## 3. Watch the upload queue

The **Upload Runner** panel on the Settings page shows the background runner (its
batch size and interval), the current queue, and — with the right rights —
run-now and retry controls. A `partial` recording means you should retry the
failed items here.

## 4. Configure retention

Under **Retention Policies** (*"Cleanup templates for controller and recorder
caches."*), set cleanup rules. Retention has two sides:

- **Controller cache** — max-age / max-bytes cleanup, plus delete-after-upload.
- **Recorder cache** (on each node) — pushed via node config; swept by age, size,
  and free disk.

Cleanup never runs before a confirmed upload.

Use **Set default** on a retention policy to pre-select it for new schedules and
ad-hoc recordings (it shows a **Default** badge); there is one default per type.

## See also

- [Find & manage recordings](manage-recordings.md) — queue an upload by hand
- [Storage & uploads guide](../guides/storage-and-uploads.md) — the full flow, runner, and metrics
