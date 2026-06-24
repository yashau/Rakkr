# Rakkr First Reliable Recording Baseline

Status: MVP baseline checked.

## Behavior

- Ad-hoc recording start accepts node, profile, upload policy, folder, name, tags, and optional capture backend/interface targeting, then creates a node job with profile-driven output settings.
- Scheduled due runs create schedule-owned recordings and jobs with schedule-owned name, folder, tags, profile, watchdog policy, and upload policy.
- Recorder nodes can claim jobs, heartbeat running jobs, attach cached audio, complete jobs, and auto-queue cached recordings for upload.
- Long-running recorder agents can claim-next and run bounded simultaneous jobs from controller node capacity, with `RAKKR_MAX_CONCURRENT_RECORDINGS` as the local fallback.
- Cached recordings store checksum, duration, waveform preview, content type, file name, and cache path.
- Cached media supports playback sessions, download preparation, inline stream, and attachment file responses.
- Stop requests survive agent cancellation without falsely marking the recording unhealthy.
- Failed and unexpectedly cancelled jobs update recording health and create central health events.
- Recording jobs workbench shows scoped job status, status/search/node/backend/interface filters, node/recording relationships, capture settings, leases, heartbeats, and failures, plus filtered CSV export, RBAC-mirrored stop controls for active jobs, and audited retry controls for failed/cancelled jobs.
- Fake-controller smoke coverage proves agent job polling, claim-next/status-poll/control-plane/channel-map failure health, controller capacity override, bounded concurrent jobs, capture/render handoff, concurrent-safe local health logging, MP3 VBR output, cache upload, cache-upload failure, and controller stop handling without hardware.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Ad-hoc start metadata, profile, upload policy, and capture targeting | `apps/api/test/recording-start-routes.test.ts`, `apps/api/test/recording-routes.test.ts` |
| Ad-hoc claim, claim-next, heartbeat, cache attach, playback, download, stream, file | `apps/api/test/agent-routes.test.ts` |
| Scheduled due-run metadata, claim, cache attach, playback, download, stream, file | `apps/api/test/schedule-runner.test.ts` |
| Cache checksum, duration, waveform preview, file size | `apps/api/test/recording-cache.test.ts` |
| Failed/cancelled job health transitions | `apps/api/test/agent-routes.test.ts` |
| Stop-request lifecycle | `apps/api/test/agent-routes.test.ts` |
| Agent render/cache/stop/claim-next-status-poll-control-plane-channel-map failure/controller-capacity/concurrency smoke | `scripts/agent-fake-controller-smoke.mjs` |
| Playback/download UI readiness and cleanup | `apps/web/src/lib/recording-page-helpers.test.ts` |
| Schedule detail playback/download controls | `apps/web/src/lib/schedule-detail-page-helpers.test.ts` |
| Recording jobs workbench, export, stop, and retry controls | `apps/api/test/recording-job-export.test.ts`, `apps/api/test/recording-jobs.test.ts`, `apps/web/src/pages/jobs.tsx`, `apps/web/src/lib/jobs-page-helpers.test.ts`, `apps/web/src/lib/root-layout-helpers.test.ts` |

`mise run recordings:check-first-reliable` validates this baseline, and `mise run check` runs it.
