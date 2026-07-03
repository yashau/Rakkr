---
title: Set up switcher routing
description: Drive an external audio matrix switcher so a live room's audio is auto-routed to a listener's desk, with a safe observe-first rollout.
sidebar:
  order: 17
---

# Set up switcher routing

Rakkr can drive an external **audio matrix switcher** so that when a room's
scheduled meeting is live and assigned to a user, the room's audio is
automatically routed to that user's desk — an alternative to
[listening in the browser](monitor-rooms-live.md). The first supported device is
the **AVPro Edge AC-MAX** family.

> **Who can do this:** viewing needs `switcher:read`; mapping inputs/outputs needs
> `switcher:map` (operators have this); creating, editing, testing, and deleting
> switchers need `switcher:manage`.

## 1. Add the switcher

Open **Settings** and scroll to **Audio Matrix Switchers**, then click **New**:

- **Host / IP** and **Port** — the device's control endpoint (AC-MAX defaults to
  TCP 23). Connection settings live on the controller, never in a `.env`.
- **Username / Password** — optional; used only by models whose control channel
  requires a login. The password is encrypted at rest and never shown back.
- **Mode** — the safety control:

  | Mode         | Behaviour                                                            |
  | ------------ | ------------------------------------------------------------------- |
  | **Disabled** | The controller never connects.                                      |
  | **Observe**  | Computes and **audits** the routes it *would* apply, but changes nothing. New switchers start here. |
  | **Enforce**  | Actually applies routing.                                           |

Use **Test** to confirm the controller can reach the device.

## 2. Map inputs and outputs

Open the switcher's **Map** dialog. Add a row per wired jack:

- assign each **input** to the **room** it carries ("input 5 is Committee Room A");
- assign each **output** to the **user** whose desk it feeds ("output 24 is
  Fathi's desk").

One room per input, one user per output. Save writes the whole map at once.

## 3. Roll out safely

1. Leave the switcher in **observe** mode with the map in place.
2. Watch the [audit log](read-the-audit-log.md) — `switchers.reconcile.observed`
   events show the exact routes it *would* apply, without touching the device.
3. When the plan looks right, change the mode to **enforce**.

Once enforcing, Rakkr only ever writes the outputs you mapped, and only while
that user's meeting is live — idle desks and manual routing are never touched.

## See also

- [Monitor a room live](monitor-rooms-live.md) — the in-browser listening alternative
- [Switcher routing guide](../guides/switcher-routing.md) — routing behaviour and invariants in full
