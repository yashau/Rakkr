# Settings/Templates Baseline

Rakkr centralizes operator-managed recording settings and reusable channel-map templates. This is a checked partial baseline for the current settings workflow.

## Partial Baseline Checked

- Recording profiles can be read and updated through RBAC-gated settings routes.
- Watchdog policies can be read and updated through RBAC-gated settings routes.
- Channel-map templates can be created, updated, versioned, assigned to targets, and rolled back.
- Channel-map templates can be bulk-assigned to many node/interface targets in one audited operation.
- Bulk deployment is available for channel-map assignments.
- Staged rollout is available for channel-map assignments through a pending plan and explicit apply step.
- Upload providers and upload policies share the same settings read/manage permission boundary.
- Upload policies include cache-retention behavior through `deleteCacheAfterUpload`.
- Upload-policy cache retention remains the currently executed cache-retention path.
- Retention policy templates can be created and updated through RBAC-gated settings routes.
- Settings writes audit before/after snapshots when the route has an existing resource.
- Missing `settings:read` and `settings:manage` permissions are denied and audited.
- Settings data persists through Postgres stores with JSON fallback stores for MVP development.
- Settings UI mirrors read/manage permissions and hides node target lookup unless `node:read` is present.

## Remaining Gaps

- Retention policy assignment and cleanup-worker execution remain pending.

## Evidence

| Area | Files |
| ---- | ----- |
| Shared contracts | `packages/shared/src/index.ts` |
| Database schema | `packages/db/src/schema.ts` |
| API routes | `apps/api/src/settings-routes.ts` |
| Stores | `apps/api/src/settings-store.ts`, `apps/api/src/recording-profile-settings.ts` |
| Rollout plans | `apps/api/src/channel-map-assignment-plans.ts` |
| API coverage | `apps/api/test/settings-routes.test.ts` |
| UI permissions | `apps/web/src/lib/settings-page-helpers.ts`, `apps/web/src/lib/settings-page-helpers.test.ts` |
| Upload retention | `apps/api/src/upload-policies.ts`, `apps/api/src/upload-runner.ts`, `apps/api/test/upload-policies.test.ts`, `apps/api/test/upload-runner.test.ts`, `apps/web/src/components/upload-policy-panel.tsx` |
| Retention templates | `apps/api/src/retention-policies.ts`, `apps/api/src/retention-policy-routes.ts`, `apps/api/test/retention-policy-routes.test.ts`, `apps/web/src/components/retention-policy-panel.tsx` |
| UI workflow | `apps/web/src/pages/settings.tsx`, `apps/web/src/components/recording-profile-settings-card.tsx`, `apps/web/src/components/watchdog-policy-card.tsx` |
| Agent pinning | `apps/api/src/recording-job-targets.ts`, `apps/api/src/recording-jobs.ts`, `apps/api/src/agent-routes.ts`, `apps/api/test/agent-routes.test.ts`, `crates/recorder-agent/src/channel_map.rs` |

## Verification

Run:

```sh
mise run settings:check
```

`mise run check` includes this verifier.
