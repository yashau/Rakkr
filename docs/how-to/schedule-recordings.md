---
title: Schedule recordings
description: Create recurring or one-off scheduled recordings, use buffers and exceptions, run or skip the next occurrence, and reschedule from the calendar.
sidebar:
  order: 3
---

# Schedule recordings

Schedules capture a room's regular sessions **automatically**, so nobody has to
remember to press record. Rakkr's scheduler is deliberately **human-friendly —
there is no cron syntax anywhere.**

> **Who can do this:** viewing needs `schedule:read`; creating and editing needs
> `schedule:manage`, or the `book` capability on the room.

## Create a schedule

1. Open **Schedules** in the left nav and click **Add schedule**.
2. Choose a **recurrence** mode:

   | Mode         | Meaning                                         |
   | ------------ | ----------------------------------------------- |
   | `manual`     | No automatic runs — run-now only.               |
   | `once`       | A single one-off window.                        |
   | `daily`      | Every day at a time.                            |
   | `weekly`     | Selected days of the week.                      |
   | `monthly`    | A day of the month (clamped on short months).   |
   | `always_on`  | Continuous capture.                             |

3. Set the timing and target:
   - **Timezone** — windows are computed in the schedule's own timezone.
   - **Start-early / stop-late buffers** — begin a little before and end a little
     after the nominal time so you never clip the start or end of a session.
   - **Node**, **interface**, and optionally **channels** — the same channel
     picker as [ad-hoc recording](record-a-session.md#record-part-of-a-device-channels),
     so different schedules can own different channel pairs of one device.
   - **Room** — every schedule belongs to a [room](manage-rooms.md).
4. Set the **metadata and policies** the schedule will own: name/folder
   templates, tags, recording **profile**, watchdog policy, retention, and
   **upload policies**. Every recording this schedule makes inherits these, so a
   room's recordings stay consistent without per-run setup.
5. Save.

> **Assignments become room access.** The users and groups you assign to a
> schedule are automatically added to that schedule's room roster with
> `view + operate` access, so they can see and run the session. See
> [Grant access to a room](grant-room-access.md).

## Run, skip, pause, disable

From the **Schedules** page:

- **Run now** — force the next occurrence immediately.
- **Skip next** — skip only the upcoming occurrence.
- **Exceptions** — **skip** a single date, or **pause** the schedule across a
  date range.
- **Enabled** toggle — turn the whole schedule on or off.

If a due run's channels are already busy, the scheduler **defers** that
occurrence (and raises an alert) rather than failing — whatever already holds the
channels keeps running.

## Reschedule from the calendar

1. Open **Schedules → calendar** (`/schedules/calendar`). It lays every
   schedule's occurrences on a month grid with room and assignee context.
2. Navigate months with the arrows. The week starts on the day set under
   **Settings → Controller → Week starts on**.
3. **Drag an occurrence to another day** to reschedule it:
   - A **one-off** schedule simply moves.
   - A **recurring** instance is moved by skipping that instance and cloning a
     duration-preserving one-off at the new time (rolled back automatically if
     the clone fails).

## Review a schedule

Click a schedule's name to open its detail page: upcoming windows, the
recordings and jobs it has produced (with quality timelines), its health events,
and its audit history.

## See also

- [Record a session](record-a-session.md) — one-off ad-hoc capture
- [Configure recording profiles](configure-recording-profiles.md) — the encode preset a schedule uses
- [Scheduling guide](../guides/scheduling.md) — recurrence internals and the scheduler runner
