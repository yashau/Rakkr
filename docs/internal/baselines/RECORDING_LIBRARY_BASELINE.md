# Rakkr Recording Library Baseline

Status: MVP baseline checked.

## Behavior

- Recording library APIs and UI actions are RBAC-gated and audited.
- Recording metadata, job links, cache state, checksums, and waveform preview persist through Drizzle/Postgres with JSON fallback.
- Library browsing supports scoped search, filters, facets, sorting, pagination, and active filter chips.
- Metadata edits cover name, folder, tags, and notes; bulk folder/tag organization works for visible recordings.
- Recording cards show node, schedule, recording profile, upload policy, track group, job, interface, and channel-map context.
- Cached recordings support playback, download, manifest export, bulk upload queueing, and terminal-recording delete.
- Cache attach stores SHA-256, duration, and WAV or decoded waveform preview data.
- Per-recording health timeline and upload queue state are visible when permissions allow.
- Optional generated transcode derivatives are deferred; waveform preview is the current MVP preview asset.

## Checked By

| Check                                                                    | Evidence                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Listing, facets, filters, sorting, pagination, bulk organization, delete | `apps/api/test/recording-routes.test.ts`              |
| Bulk metadata organization                                               | `apps/api/test/recording-routes-metadata.test.ts`     |
| Bulk and single recording delete                                         | `apps/api/test/recording-routes-delete.test.ts`       |
| Ad-hoc recording lifecycle                                               | `apps/api/test/agent-routes-recording-lifecycle.test.ts` |
| Route RBAC                                                               | `apps/api/test/recording-route-permissions.test.ts`   |
| Cache checksum and waveform preview                                      | `apps/api/test/recording-cache.test.ts`               |
| CSV manifest export                                                      | `apps/api/test/recording-export-routes.test.ts`       |
| Operator notes                                                           | `apps/api/test/recording-metadata-routes.test.ts`     |
| Cache-state filtering                                                    | `apps/api/test/recording-listing.test.ts`             |
| Upload queue actions                                                     | `apps/api/test/recording-upload-queue-routes.test.ts` |
| Ad-hoc lifecycle                                                         | `apps/api/test/agent-routes.test.ts`                  |
| Scheduled lifecycle                                                      | `apps/api/test/schedule-runner.test.ts`               |
| UI permissions, playback, relationship badges, waveform helpers          | `apps/web/src/lib/recording-page-helpers.test.ts`     |

`mise run recordings:check` validates this baseline, and `mise run check` runs it.
