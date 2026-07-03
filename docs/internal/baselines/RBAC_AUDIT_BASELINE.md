# Rakkr RBAC And Audit Baseline

Status: MVP baseline checked.

## Policy Rules

- Default deny for authenticated and unauthenticated requests.
- Exact permission is required before a protected action can run.
- Resource-scoped allow and deny policies apply to targeted node, schedule, recording, health, and settings actions.
- Explicit deny wins across user, group, and everyone subjects.
- Rooms are first-class: room grants and the room roster key on a stable roomId, and a per-room roster grants independently-toggled per-action capabilities to users/groups without changing roles or adding permissions.
- The API enforces RBAC; UI helpers mirror permissions for operator ergonomics.
- Privileged reads, writes, service actions, and denied attempts write audit events.

## Permission Matrix

| Permission           | Protected Surface                                                                           | Primary Evidence                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `audit:read`         | Audit trail reads, detail/action summaries, filter facets, and filtered/selected CSV export | `apps/api/src/audit-routes.ts`, `apps/web/src/lib/audit-page-helpers.ts`                                                    |
| `auth:manage`        | Users, groups, access policies, OIDC discovery/actions                                      | `apps/api/src/index.ts`, `apps/api/src/auth-lifecycle-routes.ts`, `apps/api/src/auth-oidc-routes.ts`                        |
| `health:acknowledge` | Health event create, acknowledge, suppress, resolve, reopen                                 | `apps/api/src/health-routes.ts`, `apps/api/src/watchdog-runner.ts`                                                          |
| `health:read`        | Health event timelines, filtered and selected CSV export, and node health panels            | `apps/api/src/health-routes.ts`, `apps/web/src/lib/schedule-detail-page-helpers.ts`                                         |
| `listen:monitor`     | Live listen monitor start and stream                                                        | `apps/api/src/node-routes.ts`, `apps/web/src/lib/node-page-helpers.ts`                                                      |
| `metrics:read`       | Prometheus metrics export                                                                   | `apps/api/src/metrics-routes.ts`                                                                                            |
| `node:control`       | Recorder-node service lifecycle actions                                                     | `apps/api/src/agent-routes.ts`                                                                                              |
| `node:manage`        | Node enrollment, identity edits, interface edits, channel-room assignment, credential rotation | `apps/api/src/node-routes.ts`, `apps/api/src/channel-room-routes.ts`, `apps/web/src/lib/node-page-helpers.ts`            |
| `node:read`          | Nodes, inventory export, meters, status, dashboard inventory                                | `apps/api/src/node-routes.ts`, `apps/api/src/status-routes.ts`, `apps/web/src/lib/dashboard-page-helpers.ts`                |
| `recording:control`  | Stop, upload queue, upload runner, job retry, job lifecycle control                         | `apps/api/src/recording-routes.ts`, `apps/api/src/recording-upload-queue-routes.ts`, `apps/api/src/upload-runner-routes.ts` |
| `recording:create`   | Ad-hoc recording starts                                                                     | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/root-layout-helpers.ts`                                               |
| `recording:delete`   | Single and bulk recording deletes                                                           | `apps/api/src/recording-routes.ts`, `apps/api/src/recording-delete.ts`                                                      |
| `recording:download` | Recording download prepare and file routes                                                  | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/recording-page-helpers.ts`                                            |
| `recording:edit`     | Recording metadata and bulk organization                                                    | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/recording-page-helpers.ts`                                            |
| `recording:playback` | Playback sessions and cached media streams                                                  | `apps/api/src/recording-routes.ts`, `apps/web/src/lib/recording-page-helpers.ts`                                            |
| `recording:read`     | Library, facets, manifests, jobs, job export, upload queue reads                            | `apps/api/src/recording-routes.ts`, `apps/api/src/recording-upload-queue-routes.ts`                                         |
| `schedule:manage`    | Schedule create, update, run-now, skip-next, delete, due-run service audit                  | `apps/api/src/schedule-routes.ts`, `apps/api/src/schedule-runner.ts`                                                        |
| `schedule:read`      | Schedule list, occurrences, detail context                                                  | `apps/api/src/schedule-routes.ts`, `apps/web/src/lib/schedule-page-helpers.ts`                                              |
| `settings:manage`    | Recording profiles, watchdog policies, channel maps, upload settings writes                 | `apps/api/src/settings-routes.ts`, `apps/web/src/lib/settings-page-helpers.ts`                                              |
| `settings:read`      | Settings reads and Settings shell visibility                                                | `apps/api/src/settings-routes.ts`, `apps/web/src/lib/settings-page-helpers.ts`                                              |
| `switcher:manage`    | Audio matrix switcher config create/update/delete, test-connection, config snapshot/restore | `apps/api/src/switcher-routes.ts`, `apps/api/src/switcher-store.ts`                                                         |
| `switcher:map`       | Switcher input→room and output→user channel mapping writes                                  | `apps/api/src/switcher-mapping-routes.ts`, `apps/api/src/switcher-mapping-store.ts`                                        |
| `switcher:read`      | Switcher list/detail, channel mappings, and live route/signal reads                         | `apps/api/src/switcher-routes.ts`, `apps/api/src/switcher-mapping-routes.ts`                                              |
| `system:admin`       | Owner-only system super permission; no public route grants it directly                      | `packages/shared/src/index.ts`                                                                                              |

## Room Roster Capabilities

- Access to a room's resources is granted per-room via a ROSTER: each entry is a user or access group with an independently-toggled set of per-action capabilities — `view`, `listen`, `download`, `operate`, `book`, `edit`, `delete`. A subject's effective capabilities are the union across their direct and group entries for that room.
- Each capability maps to existing controller permissions scoped to the room (e.g. `operate` → `recording:create`/`recording:control`; `view` → `recording:read`/`recording:playback`/`schedule:read`/`node:read`/`health:read`; `book` → `schedule:manage`). No new global permissions are added, and `auth:manage`, `node:manage`, `settings:*`, `metrics:read`, `audit:read`, `system:admin`, and `node:control` (recorder-service lifecycle) are deliberately NOT room capabilities — they stay role-based.
- Room identity is a stable `roomId`; room grants, deny policies, and the roster all key on `roomId`, not the free-text `<site>/<room>` string.
- Room ownership is per-channel: a channel's owning room is `audio_channels.room_id`, falling back to the node default (`nodes.room_id`) when unset (`apps/api/src/room-resolution.ts`). Scope resolves a channel to its OWN room, an interface and a node to the UNION of their channels' rooms (`apps/api/src/scope-targets.ts`); recordings and schedules carry their own persisted `roomId`.
- A shared node (channels owned by different rooms) is visible to a user holding access in ANY of its channels' rooms, but per-channel data stays strict: meter levels are filtered per channel and recordings/health follow the recording's persisted room, so one room's channels, meters, or recordings never leak to another room's roster on the same node. A recording or schedule captures exactly one room's channels; a selection spanning rooms is rejected.
- A calendar meeting-assignment is one grant SOURCE: a schedule's assigned users/groups reconcile into `source='calendar'` roster rows for the schedule's room (default capabilities view+operate), separate from `source='manual'` operator grants.
- Group roster entries are evaluated dynamically against live membership; no reconciliation runs on membership change.
- Access groups are first-class and managed under `auth:manage`: create (name-derived immutable slug id), rename/describe, membership, and delete via `/api/v1/auth/groups` (`apps/api/src/auth-management-routes.ts`, `apps/api/src/auth-service.ts`). Deleting a group cascade-cleans it from access policies, room rosters, and schedule `assignedGroupIds`, and audits the removal; membership/rename changes only refresh affected sessions.
- Two invariants bound a roster grant: an explicit deny access-policy always overrides it, and it only authorizes a permission when the request target resolves to that room, so collection/global targets are never authorized via the roster. The authorization decision records `grantedViaRoomCapability` and the `roomCapability`.
- Evidence: `apps/api/src/room-roster-store.ts`, `apps/api/src/room-store.ts`, `apps/api/src/index.ts`, `packages/shared/src/room-capabilities.ts`.

## Checked By

| Check               | Command                        |
| ------------------- | ------------------------------ |
| RBAC/audit baseline | `mise run security:check-rbac` |

`mise run check` runs the RBAC/audit baseline check.
