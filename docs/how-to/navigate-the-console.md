---
title: Get around the console
description: Sign in, read the layout, use the navigation, and understand Rakkr's status colours.
sidebar:
  order: 1
---

# Get around the console

Everything in these guides happens in the **operator console** — Rakkr's web
app. This page gets you signed in and oriented.

> **Who can do this:** anyone with an account. What you see afterwards depends on
> your role and access.

## Sign in

1. Open the console URL your administrator gave you. On a local install that's
   `http://localhost:5173`.
2. The sign-in screen shows the **Rakkr** logo above **"Local controller sign
   in"**.
3. Sign in one of two ways:
   - **Email + Password**, then **Sign In**. A wrong local password shows
     *"Invalid email or password."*
   - **Sign In With Azure AD** — shown only if your organization uses Microsoft
     Entra ID single sign-on. Use this instead of a local password.

Your session lasts about 12 hours; after that, sign in again. For a fresh local
install the default admin is `admin@rakkr.local` (see the
[quick start](../getting-started/quick-start.md)).

If you ever see **"Controller unavailable,"** the app couldn't reach the
controller — your session is still valid, just press **Retry**.

## Read the layout

Once you're in, the screen has three parts:

- **Left navigation** — the list of pages. On a phone it collapses behind the
  **Open navigation** button.
- **Header** — the page title **"Operations,"** your controller's name beneath
  it, and on the right: your name and roles, a **dark-mode toggle**, a
  **Settings** shortcut, **Logout**, and a **Record** button.
- **Main area** — the current page.

The **Record** button (top-right) opens the **Quick Recording** panel from any
page — the fastest way to start an ad-hoc capture
([Record a session](record-a-session.md)). It's disabled with a tooltip if you
can't start recordings.

## The navigation map

The left nav only shows pages you're allowed to see, always in this order:

| Nav item       | What it's for                                                       | Needs            |
| -------------- | ------------------------------------------------------------------- | ---------------- |
| **Dashboard**  | At-a-glance operations overview.                                    | `node:read`      |
| **Nodes**      | Recorder-node inventory, status, meters, listen-in, configuration.  | `node:read`      |
| **Rooms**      | Rooms, their inventory, schedules, and access rosters.              | `node:read`      |
| **Health**     | The alert queue — events to acknowledge and resolve.               | `health:read`    |
| **Schedules**  | Recurring recordings (list) and the calendar view.                 | `schedule:read`  |
| **Recordings** | The recording library — browse, play, download, organize.          | `recording:read` |
| **Jobs**       | The capture-job workbench — queued, running, failed.               | `recording:read` |
| **Settings**   | Templates and policies: profiles, watchdog, uploads, and more.     | `settings:read`  |
| **Audit**      | The immutable record of every privileged action.                   | `audit:read`     |
| **Access**     | Users, groups, and access policies.                                | `auth:manage`    |

## Read status at a glance

Rakkr colour-codes status everywhere. The recurring vocabularies:

- **Node status** — `provisioning` (awaiting first contact), `online` /
  `recording` (green, healthy), `degraded` / `alerting` (amber, needs attention),
  `offline` (grey/red). A node goes **offline** automatically after it misses
  heartbeats.
- **Recording / job status** — `queued`, `running`, `stop_requested`,
  `completed`, `failed`, `cancelled`.
- **Health severity** — `info` (blue), `warning` (amber), `critical` (red).
- **Health status** — `open`, `acknowledged`, `suppressed`, `resolved`.

## Dark mode and the week start

The header's toggle switches light / dark / system. Calendar and week-based
views start on the day set under **Settings → Controller → Week starts on**
(default Monday).

## Why can't I see or do something?

Almost always one of three reasons, checked in this order:

1. **Role** — your role doesn't include the permission (e.g. a `viewer` can't
   start recordings). See the
   [role matrix](../reference/permissions.md#role--permission-matrix).
2. **Scope** — you have the permission but aren't in scope for that specific
   room/node/recording. An admin grants scope with a
   [room roster](grant-room-access.md) entry or an
   [access policy](manage-groups-and-access.md).
3. **Deny** — an explicit **deny** policy overrides everything else.

The console mirrors these rules, so a missing button is real — not a display
glitch.

## See also

- [Authentication & RBAC](../guides/authentication-and-rbac.md) — the full access model
- [Core concepts](../getting-started/concepts.md) — the vocabulary
