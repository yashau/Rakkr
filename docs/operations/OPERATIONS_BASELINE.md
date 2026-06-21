# Rakkr Operations Baseline

Status: MVP baseline checked.

## Behavior

- Recording organization supports search, facets, filters, folder/tag edits, operator notes, bulk organization, manifest CSV export, cache state, upload queue state, playback, download, and delete controls.
- Settings templates cover recording profiles, watchdog policies, upload providers, upload policies, channel map templates, channel map assignments, revision promotion, and rollback.
- Operational settings routes are RBAC-gated and audit before/after snapshots for successful changes plus denials for missing permissions.
- Audit routes support filtered search by action, actor, target, outcome, permission, reason, and date range, plus filter facets and filtered/selected CSV export.
- Upload operations support stub, mounted-share SMB, and S3 provider configuration, provider readiness, policy templates, auto/manual queueing, retries, run-now, metrics, and cache-retention behavior.
- UI pages mirror granular RBAC for recording organization, Settings templates, upload runner controls, and Audit read/export.
- This baseline is controller-local; external SSO, non-stub storage hardening, and real test-rig validation are tracked separately.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Recording organization, facets, bulk metadata, delete | `apps/api/test/recording-routes.test.ts` |
| Recording manifest CSV export | `apps/api/test/recording-export-routes.test.ts` |
| Recording metadata notes | `apps/api/test/recording-metadata-routes.test.ts` |
| Recording UI organization helpers | `apps/web/src/lib/recording-page-helpers.test.ts` |
| Settings template reads, writes, RBAC, succeeded audits | `apps/api/test/settings-routes.test.ts` |
| Settings page RBAC helpers | `apps/web/src/lib/settings-page-helpers.test.ts` |
| Audit filtering and CSV export | `apps/api/test/audit-routes.test.ts` |
| Audit page RBAC helpers | `apps/web/src/lib/audit-page-helpers.test.ts` |
| Upload provider readiness | `apps/api/test/upload-providers.test.ts` |
| Upload policy templates | `apps/api/test/upload-policies.test.ts` |
| Upload runner and queue operations | `apps/api/test/upload-runner.test.ts` and `apps/api/test/recording-upload-queue-routes.test.ts` |
| Upload runner UI RBAC | `apps/web/src/lib/upload-runner-panel-helpers.test.ts` |

`mise run operations:check` validates this baseline, and `mise run check` runs it.
