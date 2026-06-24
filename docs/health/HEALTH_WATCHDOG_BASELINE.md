# Rakkr Health Watchdog Baseline

Status: Partial baseline checked.

## Behavior

- Scheduled recording watchdog evaluates active recordings with configurable grace, window, metric, dBFS threshold, cumulative signal time, and repeat interval.
- Low-signal events open, repeat, and auto-resolve, then sync recording health and write system audit events.
- Speech-required policies can alert when audio is loud but not speech-like.
- Channel-correlation policies can alert when scheduled audio channels remain suspiciously same-phase or inverted for enough cumulative time.
- Clipping policies can alert when scheduled audio clips for enough cumulative time and auto-resolve after recovery.
- Flatline policies can alert when scheduled audio remains digitally flatlined below a configurable dBFS threshold for enough cumulative time and auto-resolve after recovery.
- Quality anomaly policies can alert when scheduled audio has sustained high broadband noise, noise, hum, or static likelihood and auto-resolve after recovery.
- Node liveness creates and resolves offline health events with node alias, room, IP, and heartbeat details.
- Recorder nodes write lifecycle-managed local JSONL health logs and sync health events to the controller.
- Agent health coverage includes meter capture failure/recovery, device unavailable/xrun, clipping, flatline, configurable low-signal, first-pass channel correlation, disk/CPU/audio backend pressure, capture growth failure, render failure, cache upload failure, and terminal job state.
- Upload runner terminal queue failures create controller health events and sync recording health.
- Disk pressure sampling can use an explicit `df` command path for constrained recorder environments and deterministic smoke coverage.
- Fake-controller smoke coverage exercises controller-synced meter xrun, device-unavailable, and recovery health with synthetic fallback without audio hardware.
- Fake-controller smoke coverage exercises controller-synced agent disk-pressure, stalled-capture, and render-failure health without audio hardware.
- Fake-controller smoke coverage exercises controller-synced listen-monitor chunk failure and recovery without audio hardware.
- Synthetic PCM calibration fixtures assert voice, silence, estimated SNR, intelligibility, hum/static likelihood, broadband-noise likelihood, and independent-channel behavior for local quality scoring.
- A clean multi-speaker speech fixture is checked in at `fixtures/audio/rakkr-golden-dialogue-clean.wav`; the ALSA loopback fixture smoke replays healthy delayed-stereo speech, clipped/noisy speech, low-volume speech, and duplicated-channel speech, then asserts current-agent speech/noise quality fields plus daemon health-log clipping, low-signal, and channel-correlation behavior.
- A full-agent ALSA loopback job smoke records looped speech through `arecord`, uploads the captured WAV to a fake controller, and asserts recorder-cache cleanup health without synthetic capture.
- RBAC/audited field calibration can recommend and optionally apply watchdog thresholds from recent room meter history.
- Settings UI exposes RBAC-mirrored watchdog calibration controls for visible nodes.
- Health APIs are RBAC-gated, resource-scoped, lifecycle managed, searchable and filterable by opened/resolved date range and incident fields, export scoped filtered CSV incident lists, and audited.
- Central health workbench lists, searches, filters by opened/resolved date range and incident fields, summarizes, shows active filter chips, exports, and manages visible health events with RBAC-mirrored relationship lookups plus single and bulk lifecycle controls.
- Node health panels expose RBAC-mirrored acknowledge, one-hour suppress, resolve, and reopen lifecycle controls.
- UI exposes live meter speech/noise/broadband-noise/SNR/intelligibility/hum/static/clipping/channel correlation cues plus recording and schedule quality timelines with event-specific watchdog and upload-failure evidence.
- Prometheus export covers health totals, active watchdog alerts, node-offline alerts, xrun totals, clipping, speech score, noise score, broadband-noise score, estimated SNR, intelligibility score, hum score, static score, and channel correlation score.
- Remaining gaps: long-duration real-room validation is not complete.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Scheduled low-signal, repeat, auto-resolve, speech-required, channel-correlation, clipping, flatline, quality anomaly, node offline | `apps/api/test/watchdog-runner.test.ts` |
| Health route RBAC, scoped CSV export, and lifecycle denials | `apps/api/test/health-routes.test.ts` |
| Health event search and date/type filtering | `apps/api/test/health-store.test.ts` |
| Upload runner terminal-failure health event sync | `apps/api/test/upload-runner.test.ts` |
| Health/watchdog/xrun Prometheus metrics | `apps/api/test/metrics.test.ts` |
| Watchdog field calibration route | `apps/api/test/watchdog-calibration-routes.test.ts` |
| Watchdog calibration UI gating | `apps/web/src/lib/settings-page-helpers.test.ts` |
| Central health workbench and bulk lifecycle controls | `apps/api/test/health-routes.test.ts`, `apps/web/src/pages/health.tsx`, `apps/web/src/lib/health-page-helpers.test.ts`, `apps/web/src/lib/root-layout-helpers.test.ts` |
| Node health lifecycle controls | `apps/web/src/components/node-health-events.tsx`, `apps/web/src/lib/node-page-helpers.test.ts` |
| Meter speech/noise/broadband-noise/SNR/intelligibility/hum/static/clipping UI helpers | `apps/web/src/lib/meter-helpers.test.ts` |
| Recording and schedule quality timelines with clipping, flatline, quality anomaly, and upload-failure evidence | `apps/web/src/components/quality-timeline.tsx`, `apps/web/src/lib/quality-timeline-helpers.test.ts` |
| Clean multi-speaker speech source fixture and loopback clipped/noisy fault smoke | `fixtures/audio/rakkr-golden-dialogue-clean.wav`, `fixtures/audio/rakkr-golden-dialogue-clean.json`, `scripts/agent-loopback-fixture-smoke.sh` |
| Full-agent ALSA loopback capture/upload job smoke | `scripts/agent-loopback-job-smoke.sh` |
| Agent local health log rotation | `crates/recorder-agent/src/health_log.rs` |
| Agent meter quality, speech/noise/broadband-noise/SNR/intelligibility/hum/static/channel correlation, clipping, synthetic PCM calibration | `crates/recorder-agent/src/telemetry.rs` |
| Agent clipping, flatline, low-signal, channel correlation, xrun, system health sync | `crates/recorder-agent/src/main.rs` and `crates/recorder-agent/src/system_health.rs` |
| Agent capture growth, cache upload, stalled-capture, render-failure, and system-health smoke | `scripts/agent-fake-controller-smoke.mjs` |

`mise run health:check-watchdog` validates this partial baseline, and `mise run check` runs it.
