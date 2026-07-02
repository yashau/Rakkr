# Rakkr Scheduler Baseline

Status: MVP baseline checked.

## Behavior

- Human-friendly scheduler UI; no cron language is exposed.
- Structured recurrence modes: manual, one-off, daily, weekly, monthly, and always-on.
- Daily, weekly, and monthly schedules support interval spacing.
- Each schedule stores an explicit timezone.
- Start-early and stop-late buffers are part of recurrence data.
- Skip-next and pause ranges are structured exceptions.
- Scheduled recordings own filename, folder, tags, profile, node target, optional capture backend/interface selection, watchdog policy, upload policy, and retention policy.
- Each occurrence creates one recording + one job; when the recording profile sets a chunk length, the continuous capture is segmented into chunks that upload as they record (pre-splitting into separate per-track recordings is retired).
- Due schedule execution runs as `system:scheduler` and writes audit events.
- Schedule list/detail/read/manage APIs are RBAC-gated and successful create, update, run-now, and skip-next actions are audited.
- Schedules can assign users and access groups (`assignedUserIds` / `assignedGroupIds`); assignment grants scoped room access per the RBAC baseline and is captured in audit snapshots.
- A calendar view lists scheduled-recording occurrences across a date window; occurrences are draggable to reschedule — a one-off moves in place, and a single recurring instance is moved by skipping it and creating a duration-preserving one-off.
- One-off schedules may carry an explicit recording duration so a moved timed occurrence keeps its length.

## Operator Workflow

1. Create or edit a schedule with a recurrence mode and timezone.
2. Use quick phrases for common rules such as weekdays, one-off, monthly day, and always-on.
3. Preview upcoming occurrences before relying on the schedule.
4. Use run-now for an immediate scheduled recording.
5. Use skip-next or pause ranges for exceptions.
6. Review schedule detail for linked recordings, jobs, health, and audit timeline.

## Checked By

| Check                                                               | Evidence                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Recurrence engine                                                   | `apps/api/test/schedule-engine.test.ts`                                                                              |
| Due-run, backend/interface selection, and schedule-owned recordings | `apps/api/test/schedule-runner.test.ts`, `apps/api/test/schedule-routes.test.ts`                                     |
| Retention assignment                                                | `packages/db/drizzle/0021_true_midnight.sql`, `apps/api/src/schedule-store.ts`, `apps/web/src/lib/schedule-draft.ts` |
| Route RBAC and operator controls                                    | `apps/api/test/schedule-routes.test.ts`                                                                              |
| Calendar occurrences and occurrence moves                           | `apps/api/test/schedule-engine.test.ts`, `apps/api/test/schedule-occurrence-routes.test.ts`                          |
| Assignment payload and calendar occurrences                         | `apps/api/test/schedule-occurrence-routes.test.ts`                                                                   |
| UI permissions                                                      | `apps/web/src/lib/schedule-page-helpers.test.ts`                                                                     |
| Detail permissions                                                  | `apps/web/src/lib/schedule-detail-page-helpers.test.ts`                                                              |
| Quick phrase parsing                                                | `apps/web/src/lib/schedule-draft.test.ts`                                                                            |

`mise run scheduler:check` validates this baseline, and `mise run check` runs it.
