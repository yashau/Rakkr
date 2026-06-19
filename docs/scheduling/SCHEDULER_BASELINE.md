# Rakkr Scheduler Baseline

Status: MVP baseline checked.

## Behavior

- Human-friendly scheduler UI; no cron language is exposed.
- Structured recurrence modes: manual, one-off, daily, weekly, monthly, and always-on.
- Daily, weekly, and monthly schedules support interval spacing.
- Each schedule stores an explicit timezone.
- Start-early and stop-late buffers are part of recurrence data.
- Skip-next and pause ranges are structured exceptions.
- Scheduled recordings own filename, folder, tags, profile, node target, watchdog policy, and upload policy.
- Long scheduled windows split into ordered track jobs when the recording profile has a maximum track length.
- Due schedule execution runs as `system:scheduler` and writes audit events.
- Schedule read/manage APIs are RBAC-gated and successful create, update, run-now, and skip-next actions are audited.

## Operator Workflow

1. Create or edit a schedule with a recurrence mode and timezone.
2. Use quick phrases for common rules such as weekdays, one-off, monthly day, and always-on.
3. Preview upcoming occurrences before relying on the schedule.
4. Use run-now for an immediate scheduled recording.
5. Use skip-next or pause ranges for exceptions.
6. Review schedule detail for linked recordings, jobs, health, and audit timeline.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Recurrence engine | `apps/api/test/schedule-engine.test.ts` |
| Due-run and schedule-owned recordings | `apps/api/test/schedule-runner.test.ts` |
| Route RBAC and operator controls | `apps/api/test/schedule-routes.test.ts` |
| UI permissions | `apps/web/src/lib/schedule-page-helpers.test.ts` |
| Detail permissions | `apps/web/src/lib/schedule-detail-page-helpers.test.ts` |
| Quick phrase parsing | `apps/web/src/lib/schedule-draft.test.ts` |

`mise run scheduler:check` validates this baseline, and `mise run check` runs it.
