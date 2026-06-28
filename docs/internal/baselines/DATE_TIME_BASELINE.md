# Date/Time Baseline

Rakkr stores exact times as UTC ISO 8601 strings and displays operator-facing dates in the browser timezone with year-first formatting.

## MVP Baseline Checked

- API timestamps use ISO 8601 strings generated from `Date#toISOString()`.
- Web display helpers use the browser locale/timezone and render `YYYY-MM-DD` or `YYYY-MM-DD HH:mm`.
- Local date filters convert browser-local calendar days into UTC ISO start/end bounds before calling the API.
- Local datetime-local controls round-trip through ISO timestamps.
- Schedule definitions store an explicit timezone and recurrence calculations use that timezone.
- Scheduled recording name/folder templates receive year-first `{{date}}` and compact `{{time}}` tokens.
- Generated ad-hoc, recording-export, and audit-export filenames start with ISO/year-first date material.

## Evidence

| Area                        | Files                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Web helpers                 | `apps/web/src/lib/dates.ts`, `apps/web/src/lib/dates.test.ts`                                                               |
| Schedule timezone/rendering | `apps/api/src/schedule-engine.ts`, `apps/api/test/schedule-engine.test.ts`, `apps/api/test/schedule-runner.test.ts`         |
| Schedule UI controls        | `apps/web/src/lib/schedule-draft.ts`, `apps/web/src/lib/schedule-draft.test.ts`                                             |
| Recording filters/exports   | `apps/web/src/lib/recording-page-helpers.ts`, `apps/api/src/recording-routes.ts`, `apps/api/src/recording-start-targets.ts` |
| Audit exports               | `apps/api/src/audit-routes.ts`                                                                                              |

## Verification

Run:

```sh
mise run time:check
```

`mise run check` includes this baseline verifier.
