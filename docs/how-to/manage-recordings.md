---
title: Find & manage recordings
description: Browse and filter the recording library, play back raw or enhanced audio, download, edit metadata, delete, and do bulk actions and CSV export.
sidebar:
  order: 5
---

# Find & manage recordings

The **Recordings** page is your library — every captured session, searchable and
playable.

> **Who can do this:** browsing needs `recording:read`; individual actions need
> their own rights (playback, download, edit, delete) or the matching room
> capability.

## Find a recording

1. Open **Recordings** in the left nav.
2. Narrow the list with the filters: **folder, tags, node, profile, upload
   policy, track group, cache state,** and **date range**. Clickable facets show
   counts, and active-filter chips show what's applied.
3. **Sort** and **paginate** (10 / 25 / 50 / 100 per page) to work through large
   libraries.

## Open one recording

Click a recording to see:

- **Relationship badges** — its node, schedule, profile, and upload policy,
  resolved to friendly names where your access allows.
- **Waveform preview** and **SHA-256 checksum**.
- **Operator notes** and any transcript snippets (searchable).
- Its **jobs** and **upload-queue items**.
- A **quality timeline** — the health events plotted across the recording's
  duration, so you can see exactly when signal dropped, clipping occurred, and so
  on.

## Play, download, edit, delete

| Action              | Needs                | Notes                                              |
| ------------------- | -------------------- | -------------------------------------------------- |
| **Play**            | `recording:playback` | Opens the playback dock. If both renditions exist, an **Enhanced / Raw** toggle chooses what you hear (enhanced by default). |
| **Download**        | `recording:download` | Downloads the audio file.                          |
| **Edit metadata**   | `recording:edit`     | Rename, change folder, edit tags.                  |
| **Delete**          | `recording:delete`   | Only **terminal** (finished) recordings.           |
| **Queue upload**    | `recording:control`  | Push it to a destination now.                      |

## Bulk actions & export

Select several recordings to:

- **organize** them (folder / tag),
- **delete** them (terminal only),
- **queue** them for upload, or
- **export** the filtered or selected set as an audited **CSV** manifest.

## See also

- [Record a session](record-a-session.md) · [Schedule recordings](schedule-recordings.md) — how recordings are made
- [Track recording jobs](track-recording-jobs.md) — the work behind each recording
- [Recording library guide](../guides/recording.md#the-recording-library) — full library reference
