---
title: Audio matrix switcher routing
description: Auto-route a room's live meeting to a listener's desk on an external audio matrix switcher, driven from the schedule and roster.
sidebar:
  order: 11
---

# Audio matrix switcher routing

Rakkr can drive an external **audio matrix switcher** so that when a room's
scheduled meeting is live and assigned to a user, the room's audio is
automatically routed to that user's desk. It is an alternative to listening
inside Rakkr directly — the listener just hears the room on their existing
workstation feed.

The first supported device is the **AVPro Edge AC-MAX** family (validated
against a live AC-MAX-24). The driver layer is modular: supporting a new model
is a new driver plus a catalog entry.

## The model

A switcher exposes N audio **inputs** (room feeds) and N audio **outputs**
(listener desks). You optionally:

- assign a **room to each input** — "input 5 is the audio from Committee Room A";
- assign a **user to each output** — "output 24 is Fathi's desk".

When a meeting for a mapped room is live and a mapped user is assigned to it,
the controller routes that room's input to that user's output.

## Configure a switcher

Settings → **Audio Matrix Switchers** → **New** (requires `switcher:manage`):

- **Host / IP** and **Port** — the switcher's control endpoint (AC-MAX defaults
  to TCP 23). All connection settings live on the controller, never in a `.env`.
- **Username / Password** — optional. The AC-MAX telnet control channel is open
  (its credentials guard the web GUI only), so they are unused by that driver;
  models whose control channel requires a login use them. The password is
  encrypted at rest and never returned to the console.
- **Mode** — the safety control:
  - **Disabled** — the controller never connects.
  - **Observe** — the controller computes and audits the routes it _would_ apply
    but never sends a change. New switchers start here so nothing moves until you
    are ready.
  - **Enforce** — the controller applies routing.

Use **Test** to confirm the controller can reach the device (it reports firmware
and the current route count). **Delete** removes the switcher and its mappings;
the device itself is left untouched.

## Map inputs and outputs

Open a switcher's **Map** dialog (requires `switcher:map`, which operators have).
Add a row per wired jack: pick the input number and the room it carries, and the
output number and the user whose desk it feeds. One room per input and one user
per output. Save writes the whole map at once.

## How routing behaves

An interval reconcile loop holds these invariants:

- **Owned outputs only.** The controller writes **only** outputs you have mapped
  to a user. Every other crosspoint — including a manual operator's routing — is
  never touched.
- **Live meeting only.** An output is routed only while its user's meeting is
  live. `always_on` schedules are always live; timed schedules are live between
  an occurrence's recording start and end; manual schedules do not drive routing.
- **Leave idle desks alone.** When a mapped user has no live meeting, their
  output is left exactly as it was — the controller only changes an owned output
  while that user's meeting is live.
- **Conflicts.** If a user is live in more than one mapped room at once, the
  lowest input wins and the clash is recorded.
- **Reachability.** A switcher that goes unreachable opens a single health event
  that resolves automatically on recovery.

Every configuration change and every reconcile pass is audited (reconcile passes
under the `system:switcher-router` actor).

## Rollout suggestion

1. Add the switcher in **observe** mode and map inputs/outputs.
2. Watch the audit trail: `switchers.reconcile.observed` events show the exact
   routes it would apply, without touching the device.
3. When the plan looks right, switch the mode to **enforce**.
