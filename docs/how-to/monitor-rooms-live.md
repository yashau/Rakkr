---
title: Monitor a room live
description: Read live audio meters and listen in on a room in real time, including the raw/enhanced toggle.
sidebar:
  order: 4
---

# Monitor a room live

Rakkr lets you *see* and *hear* a room in real time — before and during a
recording — so you can confirm there's good signal before you commit. Live
metering and listening are **privileged**; they are never incidental access.

> **Who can do this:** meters need node/meter read rights; live listen-in needs
> `listen:monitor`, or the `listen` capability on the room.

## Read live meters

1. Open **Nodes** in the left nav.
2. Expand a node with the chevron on its row.
3. The **meter bank** shows a live bar per channel. Meters run **even when the
   node is idle**, so you can check signal before recording.

What the numbers mean:

| Reading         | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| **RMS / peak**  | Loudness in dBFS. 0 dBFS is the digital ceiling; speech normally sits well below it.     |
| **Clipping**    | The signal is hitting the ceiling and distorting.                                        |
| **Quality cues**| Speech vs noise, estimated SNR, intelligibility, hum/static, and channel correlation.    |

A flat meter where you expect speech, or constant clipping, is exactly what the
[watchdog](respond-to-health-alerts.md) is built to catch automatically.

## Listen in

1. On the expanded node, click **Listen** (shown if you have the right).
2. A live listen-in session opens and you hear the room from your browser.
3. Use the **Raw / Enhanced** toggle to switch between the untouched feed and
   on-demand noise suppression. Enhanced audio takes a few seconds to kick in
   after you flip it, because the node only spends CPU denoising while someone is
   actually listening enhanced.

## Prefer a physical desk? Use switcher routing

Instead of listening in the browser, an administrator can wire an external
**audio matrix switcher** so a live room's audio is auto-routed to a listener's
existing workstation feed whenever their meeting is live. See
[Set up switcher routing](set-up-switcher-routing.md).

## See also

- [Audio enhancement](../guides/audio-enhancement.md) — how raw vs enhanced works
- [Nodes & inventory](../guides/nodes-and-inventory.md) — meters and listen-in in depth
- [Respond to health alerts](respond-to-health-alerts.md) — when Rakkr flags bad audio for you
