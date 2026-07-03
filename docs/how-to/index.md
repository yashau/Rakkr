---
title: How-to guides
description: Step-by-step, task-oriented guides for operating and administering Rakkr from the operator console.
sidebar:
  order: 0
---

# How-to guides

Short, step-by-step guides for the things you actually do in Rakkr — each one a
single task, start to finish. If you are new, read
[Get around the console](navigate-the-console.md) first; after that, jump to
whatever you need.

These pages tell you **what to click**. When you want to understand **how a
feature works** underneath, each guide links to its deeper reference under
[Guides](../guides/authentication-and-rbac.md).

## Operating Rakkr

Everyday tasks for operators — capturing, monitoring, and shipping audio.

| I want to…                              | Guide                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| Record a session right now              | [Record a session](record-a-session.md)                   |
| Set up recurring / scheduled recordings | [Schedule recordings](schedule-recordings.md)             |
| Listen to and watch a room live         | [Monitor a room live](monitor-rooms-live.md)              |
| Find, play, download, or organize files | [Find & manage recordings](manage-recordings.md)          |
| See what's queued/running, retry a fail | [Track recording jobs](track-recording-jobs.md)           |
| Handle an alert about a bad recording   | [Respond to health alerts](respond-to-health-alerts.md)   |

## Administering Rakkr

Setup and governance for administrators — rooms, access, hardware, and the
templates that shape every recording.

| I want to…                                  | Guide                                                       |
| ------------------------------------------- | ---------------------------------------------------------- |
| Create and edit rooms                       | [Manage rooms](manage-rooms.md)                            |
| Give a person or group access to a room     | [Grant access to a room](grant-room-access.md)             |
| Bring a recorder node online and set it up  | [Enroll & configure nodes](enroll-and-configure-nodes.md)  |
| Add, edit, disable, or reset a user         | [Manage users](manage-users.md)                            |
| Manage groups and allow/deny access policies| [Manage groups & access policies](manage-groups-and-access.md) |
| Define codecs, quality, and enhancement     | [Configure recording profiles](configure-recording-profiles.md) |
| Tune when bad-audio alerts fire             | [Tune watchdog policies](tune-watchdog-policies.md)        |
| Send recordings to SMB/S3 storage           | [Set up storage & uploads](set-up-uploads.md)              |
| Map capture channels to outputs             | [Configure channel maps](configure-channel-maps.md)        |
| Auto-route room audio to listener desks     | [Set up switcher routing](set-up-switcher-routing.md)      |
| Review who did what, and when               | [Read the audit log](read-the-audit-log.md)                |

## A note on permissions

Rakkr is **default-deny**: you can only do something if your role grants the
permission **and** you are in scope for the specific room, node, or recording.
The console hides controls you can't use, so a missing button means you
genuinely lack that right — see
[Why can't I see or do something?](navigate-the-console.md#why-cant-i-see-or-do-something).
Each guide below opens with a **Who can do this** note.

For the whole access model — roles, room rosters, scope, and how an explicit
**deny** wins — see [Authentication & RBAC](../guides/authentication-and-rbac.md)
and the [permissions reference](../reference/permissions.md).
