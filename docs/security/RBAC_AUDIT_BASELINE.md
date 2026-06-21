# Rakkr RBAC And Audit Baseline

Status: MVP baseline checked.

## Policy Rules

- Default deny for authenticated and unauthenticated requests.
- Exact permission is required before a protected action can run.
- Resource-scoped allow and deny policies apply to targeted node, schedule, recording, health, and settings actions.
- Explicit deny wins across user, group, and everyone subjects.
- The API enforces RBAC; UI helpers mirror permissions for operator ergonomics.
- Privileged reads, writes, service actions, and denied attempts write audit events.

## Permission Matrix

| Permission | Protected Surface | Primary Evidence |
| ---------- | ----------------- | ---------------- |
| `audit:read` | Audit trail reads, detail/action summaries, and CSV export | `apps/api/src/audit-routes.ts`, `apps/web/src/lib/audit-page-helpers.ts` |
| `auth:manage` | Users, groups, access policies, OIDC discovery | `apps/api/src/index.ts`, `apps/api/src/auth-lifecycle-routes.ts`, `apps/api/src/auth-oidc-routes.ts` |
| `health:acknowledge` | Health event create, acknowledge, suppress, resolve, reopen | `apps/api/src/health-routes.ts`, `apps/api/src/watchdog-runner.ts` |
| `health:read` | Health event timelines, filtered and selected CSV export, and node health panels | `apps/api/src/health-routes.ts`, `apps/web/src/lib/schedule-detail-page-helpers.ts` |
| `listen:monitor` | Live listen monitor start and stream | `apps/api/src/node-routes.ts`, `apps/web/src/lib/node-page-helpers.ts` |
| `metrics:read` | Prometheus metrics export | `apps/api/src/metrics-routes.ts` |
| `node:control` | Recorder-node service lifecycle actions | `apps/api/src/agent-routes.ts` |
| `node:manage` | Node enrollment, identity edits, interface edits, credential rotation | `apps/api/src/node-routes.ts`, `apps/web/src/lib/node-page-helpers.ts` |
| `node:read` | Nodes, inventory export, meters, status, dashboard inventory | `apps/api/src/node-routes.ts`, `apps/api/src/status-routes.ts`, `apps/web/src/lib/dashboard-page-helpers.ts` |
| `recording:control` | Stop, upload queue, upload runner, job retry, job lifecycle control | `apps/api/src/recording-routes.ts`, `apps/api/src/recording-upload-queue-routes.ts`, `apps/api/src/upload-runner-routes.ts` |
| `recording:create` | Ad-hoc recording starts | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/root-layout-helpers.ts` |
| `recording:delete` | Single and bulk recording deletes | `apps/api/src/recording-routes.ts`, `apps/api/src/recording-delete.ts` |
| `recording:download` | Recording download prepare and file routes | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/recording-page-helpers.ts` |
| `recording:edit` | Recording metadata and bulk organization | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/recording-page-helpers.ts` |
| `recording:playback` | Playback sessions and cached media streams | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/recording-page-helpers.ts` |
| `recording:read` | Library, facets, manifests, jobs, job export, upload queue reads | `apps/api/src/recording-routes.ts`, `apps/api/src/recording-upload-queue-routes.ts` |
| `schedule:manage` | Schedule create, update, run-now, skip-next, delete, due-run service audit | `apps/api/src/schedule-routes.ts`, `apps/api/src/schedule-runner.ts` |
| `schedule:read` | Schedule list, occurrences, detail context | `apps/api/src/schedule-routes.ts`, `apps/web/src/lib/schedule-page-helpers.ts` |
| `settings:manage` | Recording profiles, watchdog policies, channel maps, upload settings writes | `apps/api/src/settings-routes.ts`, `apps/web/src/lib/settings-page-helpers.ts` |
| `settings:read` | Settings reads and Settings shell visibility | `apps/api/src/settings-routes.ts`, `apps/web/src/lib/settings-page-helpers.ts` |
| `system:admin` | Owner-only system super permission; no public route grants it directly | `packages/shared/src/index.ts` |

## Checked By

| Check | Command |
| ----- | ------- |
| RBAC/audit baseline | `mise run security:check-rbac` |

`mise run check` runs the RBAC/audit baseline check.
