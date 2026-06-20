# Rakkr Health Watchdog Baseline

Status: Partial baseline checked.

## Behavior

- Scheduled recording watchdog evaluates active recordings with configurable grace, window, metric, dBFS threshold, cumulative signal time, and repeat interval.
- Low-signal events open, repeat, and auto-resolve, then sync recording health and write system audit events.
- Speech-required policies can alert when audio is loud but not speech-like.
- Channel-correlation policies can alert when scheduled audio channels remain suspiciously same-phase or inverted for enough cumulative time.
- Clipping policies can alert when scheduled audio clips for enough cumulative time and auto-resolve after recovery.
- Node liveness creates and resolves offline health events with node alias, room, IP, and heartbeat details.
- Recorder nodes write lifecycle-managed local JSONL health logs and sync health events to the controller.
- Agent health coverage includes meter capture failure/recovery, device unavailable/xrun, clipping, flatline, first-pass channel correlation, disk/CPU/audio backend pressure, capture growth failure, render failure, cache upload failure, and terminal job state.
- Disk pressure sampling can use an explicit `df` command path for constrained recorder environments and deterministic smoke coverage.
- Fake-controller smoke coverage exercises controller-synced agent disk-pressure system health and stalled-capture health without audio hardware.
- Synthetic PCM calibration fixtures assert voice, silence, hum/static likelihood, and independent-channel behavior for local quality scoring.
- RBAC/audited field calibration can recommend and optionally apply watchdog thresholds from recent room meter history.
- Settings UI exposes RBAC-mirrored watchdog calibration controls for visible nodes.
- Health APIs are RBAC-gated, resource-scoped, lifecycle managed, filterable, and audited.
- UI exposes live meter speech/noise/hum/static/clipping/channel correlation cues plus recording and schedule quality timelines with event-specific evidence.
- Prometheus export covers health totals, active watchdog alerts, node-offline alerts, xrun totals, clipping, speech score, noise score, hum score, static score, and channel correlation score.
- Remaining gaps: long-duration real-room validation is not complete.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Scheduled low-signal, repeat, auto-resolve, speech-required, channel-correlation, clipping, node offline | `apps/api/test/watchdog-runner.test.ts` |
| Health route RBAC and lifecycle denials | `apps/api/test/health-routes.test.ts` |
| Health event type filtering | `apps/api/test/health-store.test.ts` |
| Health/watchdog/xrun Prometheus metrics | `apps/api/test/metrics.test.ts` |
| Watchdog field calibration route | `apps/api/test/watchdog-calibration-routes.test.ts` |
| Watchdog calibration UI gating | `apps/web/src/lib/settings-page-helpers.test.ts` |
| Meter speech/noise/hum/static/clipping UI helpers | `apps/web/src/lib/meter-helpers.test.ts` |
| Recording and schedule quality timelines | `apps/web/src/components/quality-timeline.tsx`, `apps/web/src/lib/quality-timeline-helpers.test.ts` |
| Agent local health log rotation | `crates/recorder-agent/src/health_log.rs` |
| Agent meter quality, speech/noise/hum/static/channel correlation, clipping, synthetic PCM calibration | `crates/recorder-agent/src/telemetry.rs` |
| Agent clipping, flatline, channel correlation, xrun, system health sync | `crates/recorder-agent/src/main.rs` and `crates/recorder-agent/src/system_health.rs` |
| Agent capture growth, cache upload, stalled-capture, and system-health smoke | `scripts/agent-fake-controller-smoke.mjs` |

`mise run health:check-watchdog` validates this partial baseline, and `mise run check` runs it.
