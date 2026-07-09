---
title: Record a session
description: Start an ad-hoc recording on demand, share one device across recordings, stop a capture, and know what happens next.
sidebar:
  order: 2
---

# Record a session

An **ad-hoc** recording is one you start by hand, right now (as opposed to a
[schedule](schedule-recordings.md), which runs automatically). This is the
fastest way to capture something unplanned.

> **Who can do this:** anyone with `recording:create`, or the `operate`
> capability on the room you're recording. You also need to be able to see the
> node (`node:read`) and settings (`settings:read`).

## Start a recording

1. Click **Record** in the top-right header — or use the **Quick Recording**
   panel on the Dashboard, or the Recordings page. A panel titled **Quick
   Recording** / *"Ad-hoc recording job"* opens.
2. Fill in the fields:

   | Field              | What to set                                                                                   |
   | ------------------ | --------------------------------------------------------------------------------------------- |
   | **Node**           | The recorder node to capture on (only nodes you're scoped to appear).                          |
   | **Backend**        | The capture backend, or leave **Node default** (usually correct).                             |
   | **Interface**      | The audio device, or **Node default** for the node's default input.                           |
   | **Channels / mode**| *(when you pin an interface)* pick specific channels and how they combine — see below.         |
   | **Name**           | Optional label to find it by later.                                                            |
   | **Folder**         | Optional folder to file it under.                                                              |
   | **Tags**           | Optional tags for filtering later.                                                             |
   | **Profile**        | The encode preset (codec, quality, enhancement). See [Recording profiles](configure-recording-profiles.md). |
   | **Upload Policies**| Zero or more destinations to ship it to when it finishes — pick several to fan out.            |

3. Click **Start**. The capture appears under **Active Recordings** on the
   Dashboard and on the [Jobs](track-recording-jobs.md) page.

## Record part of a device (channels)

When you pin a specific **Interface**, a channel picker appears. Select a subset
of channels and an **output mode** — a stereo pair, mono, a mono-to-stereo mix,
or multichannel — instead of the whole device. Leave the selection empty to
record the whole interface.

Because you can pick channels, **several recordings can run on the same
interface at once**, each on its own channels — for example sixteen independent
stereo recordings on a 32-channel interface. If you pick channels another
recording is already using, Rakkr refuses with **"Requested channels are already
in use"**; recordings on non-overlapping channels run simultaneously.

## Stop a recording

Stop a running capture from any of:

- the **Dashboard** → **Active Recordings** → **Stop**;
- the **Jobs** page → **Stop**;
- the **Recordings** page.

Stopping needs `recording:control` (or the room's `operate` capability). A stop
is honored even mid-capture, and the partial is finalized as a normal completed
recording — you never lose what was captured up to that point.

## What happens after you stop

You don't have to do anything else. Behind the scenes Rakkr:

1. applies the channel map and encodes to the profile's codec (and produces the
   [enhanced rendition](configure-recording-profiles.md#voice-enhancement) if the
   profile enables it);
2. uploads the file to the controller cache, which computes a checksum and a
   waveform preview;
3. queues it for storage if an upload policy says so.

Find the finished file on the [Recordings](manage-recordings.md) page.

## See also

- [Schedule recordings](schedule-recordings.md) — capture on a recurring basis
- [Find & manage recordings](manage-recordings.md) — play, download, organize
- [Recording guide](../guides/recording.md) — the full capture lifecycle
