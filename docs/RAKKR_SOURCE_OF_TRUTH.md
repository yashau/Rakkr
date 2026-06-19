# Rakkr Source Of Truth

![Project](https://img.shields.io/badge/project-Rakkr-2563eb)
![Status](https://img.shields.io/badge/status-active%20development-f59e0b)
![Runtime](https://img.shields.io/badge/runtime-Linux%20%2B%20Docker-111827)
![Agent](https://img.shields.io/badge/agent-Rust-7c2d12)
![Controller](https://img.shields.io/badge/controller-Hono%20%2B%20React-16a34a)

Rakkr is a centrally managed Linux/Docker audio recorder platform for reliable voice capture across managed recorder nodes.

This document is the short source of truth: product intent, non-negotiables, current status, and next work.

---

## Executive Snapshot

| Area | Decision |
| ---- | -------- |
| Primary use | Reliable voice recording for meetings and long-running rooms |
| Controller | Hono API, React, TanStack Router, TanStack Query, shadcn/ui |
| Agent | Rust recorder node service |
| Database | Postgres with Drizzle |
| Auth | Local auth first; Azure AD OIDC-ready |
| Access | Default-deny RBAC plus resource-scoped allow/deny policies |
| Audit | Required for privileged reads, writes, denied attempts, and service actions |
| Transport | Encrypted controller/node HTTP/WebSocket on trusted LAN |
| Future remote | Prefer Iroh over libp2p for known-node QUIC dialing and relay fallback |
| Audio devices | Generic Linux audio interfaces; X32 Rack is only the first test fixture |
| Default profile | Voice, MP3 VBR, 128kbps target, fully configurable |
| Scheduling | Human-friendly rules; no cron language exposed |
| Storage | Local node cache plus SMB/S3 upload providers |
| Observability | Local lifecycle log, central events, Prometheus/Mimir path |
| Dates | Store UTC ISO 8601; display browser timezone in year-first format |

## Work Discipline

- One active implementation area at a time.
- Finish the slice: code, tests/checks, docs, commit, push.
- Do not expand scope mid-slice unless the current task is blocked.
- Keep this document concise; move deep design notes into separate docs when needed.

## Status Legend

| Mark | Meaning |
| ---- | ------- |
| ✅ | Complete and checked in |
| 🟦 | Scaffold only; structure exists but the workflow is not useful yet |
| 🟨 | Partial; real behavior exists but required scope remains |
| 🚧 | Current focus |
| ⏸️ | Paused on external state |
| ⏳ | Not started |
| 🧊 | Deferred intentionally |

Promotion rule: 🟦 scaffold, 🟨 useful checked workflow, ✅ full required scope.

## Progress Dashboard

| Workstream | Status | Current State |
| ---------- | ------ | ------------- |
| Product scope | ✅ | Requirements and technical direction captured |
| Monorepo | ✅ | `mise`, Docker Compose, CI, LF normalization, LOC guard |
| Controller API | 🟨 | Auth, RBAC, audit, nodes, recordings, jobs, lifecycle coverage, schedules, settings, metrics |
| Controller UI | 🟨 | Dashboard, access, nodes, recordings, schedules, settings, quality timelines |
| Recorder agent | 🟨 | Inventory, meters, jobs, capture growth guards, profile rendering, health log |
| Test rig | ⏸️ | Debian node reachable; X32 validation paused until hardware check |
| Generic devices | 🟨 | ALSA loopback path validates fake capture/rendering |
| Scheduler | 🟨 | Persistent schedules, recurrence, buffers, run-now, skip-next, metadata ownership |
| Recording library | 🟨 | Metadata, tags/folders/search, playback, download, checksum, waveform preview, encoded cache output |
| Health watchdog | 🟨 | Meter ingest, low-signal lifecycle alerts, speech/noise scores, timelines |
| Storage upload | 🟨 | Stub/SMB/S3 providers, policies, auto-queue, audited runner, API/UI control, metrics |
| OIDC | 🟨 | Azure AD login/callback with persistent PKCE state, logout cleanup, setup notes |
| Transport security | 🟨 | Optional controller HTTPS; agent blocks non-loopback plaintext unless explicitly allowed |
| Observability | 🟨 | Local node logs, central events, `/metrics`; OTel/Mimir later |

---

## Product Invariants

- Recording reliability beats cleverness.
- UI state never replaces server-side authorization.
- Every privileged action is RBAC-gated and audited.
- Live listening is privileged.
- Recording control is privileged.
- Recorder-level deny blocks node access, recordings, meters, live listen, and controls.
- Transport between controller and recorder nodes is encrypted.
- Defaults are profiles/templates, not hard-coded engine behavior.
- Nodes must be identifiable by alias, location, network, devices, channels, status, and notes.
- X32 support must not make Rakkr X32-specific.

## Core Architecture

```mermaid
flowchart LR
  Nodes["Recorder Nodes\nLinux + audio interfaces"] --> Agent["Rust Agent\ncapture + meters + cache + health log"]
  Agent <--> Transport["Encrypted LAN Transport\nHTTP/WebSocket first"]
  Transport <--> API["Hono Controller API"]
  API <--> DB["Postgres + Drizzle"]
  API <--> UI["React UI\nTanStack + shadcn/ui"]
  Agent --> Cache["Local Recording Cache"]
  API --> Events["Audit + Health Events"]
  API --> Metrics["Prometheus / future OTel"]
  Cache --> Storage["SMB / S3 Upload Providers"]
  Agent --> Quality["Local VAD / noise / speech scoring"]
  Transport -. later .-> Iroh["Iroh Remote Mode"]
```

## Technology Stack

| Layer | Choice |
| ----- | ------ |
| Workspace | `mise` is the canonical setup and task runner |
| Node | Node 24 in CI and local `mise` runtime |
| API | Hono |
| UI | React + Vite |
| Routing | TanStack Router |
| Server state | TanStack Query |
| Components | shadcn/ui components installed from the registry |
| Styling | Tailwind 4, oxlint-tailwindcss-compatible classes |
| TS lint/format | oxlint, oxlint-tailwindcss, oxfmt |
| Rust checks | clippy and miri via `mise` |
| Database | Postgres |
| ORM | Drizzle |
| Dev stack | Docker Compose |
| File limit | 1000 LOC per file enforced by `mise run check` |

---

## Recorder Requirements

- Multiple nodes.
- Multiple audio interfaces per node.
- Multiple simultaneous recordings per node.
- Configurable mono, stereo, grouped channel, and mono-to-stereo-mix output.
- Realtime meters even while idle.
- Central recording controls.
- Ad hoc and scheduled jobs.
- Auto file splitting by length.
- Local node cache with future upload.
- Playback, download, metadata editing, tags, folders, search.
- Silence detection/skip optional and disabled by default.

## Settings And Templates

Central settings must cover:

- recording profiles;
- channel maps;
- watchdog policies;
- schedule templates;
- cache/retention policies;
- future upload policies;
- node/interface/channel aliases;
- staged rollout and rollback;
- bulk deployment to similar recorders.

Current partial implementation:

- Drizzle/Postgres plus JSON fallback stores.
- Profile, watchdog, channel map, and assignment APIs.
- Channel map revisions, promotion metadata, assignment history, rollback.
- Jobs pin target/template/channel entries at creation.
- Agent fetches pinned maps first, live assignments second.
- Recording profiles can cap max track length for scheduled auto-splitting.

## Node Inventory

Nodes need:

- stable ID;
- alias;
- site/building/floor/room;
- hostname and IP addresses;
- agent version, uptime, last seen;
- OS/kernel/audio backend;
- interfaces, USB paths, serials when available;
- channel aliases;
- tags and notes;
- online/offline/recording/alert status.

Current partial implementation:

- RBAC-gated node list, enroll, credential rotation, status, and health routes.
- RBAC-gated node alias, site/building/floor/room, network, tag, and note edits with audit history.
- RBAC-gated interface aliases, hardware paths, serials, system refs, sample rates, and channel aliases with audit history.
- Node-authenticated heartbeat updates status, last seen, OS/kernel/runtime, IPs, and audio backends.
- Persisted nodes derive offline status after missed heartbeat threshold.
- Watchdog creates and resolves central health events when node heartbeats go stale/recover.
- Node UI summarizes connectivity/offline health alongside disk, CPU, and audio.
- Node and dashboard UI color-code online/offline/recording/degraded/alerting status.
- Node API and inventory UI can filter visible nodes by status.
- Node API and inventory UI can search node identity, location, network, tags, runtime, interfaces, and channel aliases.
- Agent interface inventory prefers Linux sysfs device paths and serials when exposed.
- Node credentials scoped to their own node/jobs/recordings/meters/events.
- ALSA loopback and fake-controller tasks can validate capture/meter/render and agent job lifecycle before X32 validation resumes.
- RBAC-gated listen monitor start/stream returns a controller meter-preview WAV for browser playback.

---

## Scheduler

Scheduler rules:

- Human-friendly UI; no cron language.
- One-off, daily, weekly, monthly, interval, always-on, paused ranges, exceptions.
- Explicit timezone per schedule.
- Start-early and stop-late buffers.
- No arbitrary product limit on schedule count.
- Scheduled recordings inherit schedule-owned filename, folder, tags, profile, targets, watchdog, retention, and future upload policy.

Current partial implementation:

- Drizzle/Postgres schedule store.
- Preview, create, edit, run-now, skip-next, delete.
- Recurrence tests for buffers, pauses, monthly clamping, overnight duration, and skip-next.
- Runner creates jobs under `system:scheduler` and audits outcomes.
- Scheduled run-now and due runs split long windows into ordered track jobs when profile limits require it.

## Health Watchdog

Health monitoring must catch bad recordings while they are happening.

Required signals:

- no meaningful signal during scheduled window;
- input too quiet;
- digital flatline or stuck samples;
- clipping;
- excessive noise, hum, static likelihood;
- device disconnects and audio backend xruns;
- encoder/file writer failure;
- recording file not growing;
- channel mapping/correlation issues;
- future upload failures.

Default scheduled voice rule:

- During the scheduled recording window, after a grace period, alert if the signal does not exceed a configurable dBFS threshold for enough cumulative time.
- This is not simple silence detection and not a preflight check.

Current partial implementation:

- Lifecycle health events in Postgres plus local node JSONL logs.
- Scheduled low-signal alerts open, repeat, and auto-resolve.
- Local meter frames include speech/noise scores; speech-required policies can alert on loud non-speech audio.
- Agent capture jobs fail and log health events for too-small/stalled output, render failures, cache upload failures, and terminal recording state.
- Health event APIs can filter by event type, node, recording, schedule, severity, and status.
- Node health summaries, recent events, trends, and recording/schedule quality timelines.
- Prometheus export for node, meter, recording, job, health, watchdog, and xrun data.

## Future Voice Quality AI

Keep AI optional and pluggable.

Future analysis targets:

- voice presence;
- noise vs speech ratio;
- estimated SNR;
- static/hum/broadband noise;
- intelligibility score;
- optional transcription snippets for search.

Current path: local DSP/VAD scores first; optional AI/classifier second opinion later.

---

## RBAC And Audit

RBAC rules:

- Default deny.
- Exact permission plus resource-scope check for targeted actions.
- Allow and deny policies for user, group, and everyone subjects.
- Explicit deny wins over role grants and inherited visibility.
- UI mirrors permissions, but the API enforces them.
- Service identities, including scheduler actions, are audited.

Scope model:

| Scope | Examples |
| ----- | -------- |
| Global | auth settings, roles, system settings |
| Site | site-wide inventory and policies |
| Room | room health, live listen |
| Node | enroll, rename, configure, control |
| Interface | meters, channel maps, templates |
| Channel | listen, record, rename |
| Schedule | create, edit, pause, run-now, delete |
| Recording | playback, download, rename, tag, delete |
| Alert | acknowledge, suppress, resolve |

Required permission families:

- node inventory;
- metering;
- live listening;
- recording control;
- recording library;
- schedules;
- templates/settings;
- alerts;
- audit;
- administration.

Audit events must capture actor, permission, target, outcome, reason, timestamp, correlation IDs, and before/after values where relevant.

Current partial implementation:

- Local users, groups, roles, scopes, access policies, passwords, status.
- Azure AD OIDC claims can sync users, groups, app roles, and scoped grants into RBAC.
- Access UI manages users, groups, policies, and scopes.
- Access UI includes a structured allow/deny policy composer for user, group, and everyone subjects.
- Access UI includes a structured resource-scope composer for local user grants.
- Access policy decisions enforce explicit deny precedence across user, group, and everyone subjects.
- Access policy update routes have regression coverage for before/after audit snapshots.
- Access policy denies have route coverage for protected recording metadata writes.
- Access policy denies have route coverage for live-listen monitor starts.
- Access policy denies have route coverage for recording stop controls.
- Access policy denies have route coverage for recording playback, download, and upload queue actions.
- Access policy denies have route coverage for recording delete actions.
- Recorder-level denies have route coverage for hiding attached recordings and blocking recording edits.
- Schedule-level denies have route coverage for hiding schedules and blocking run-now control.
- Node-level denies have route coverage for hiding health events and blocking alert acknowledgement.
- Disabled/deleted/password-reset users lose active sessions.
- Audit API/UI filters by actor, action, target, outcome, and time; CSV export is RBAC-gated.
- Audit API/UI can filter by permission and reason for denial investigations.
- Audit UI exposes event reasons, correlation IDs, details, and before/after snapshots.
- User, access, password, node credential, schedule, watchdog, health, and recording metadata actions are audited.
- Recording delete is RBAC-gated and audited, with active-recording protection.

## Security And Transport

- Local auth uses hashed passwords and bearer sessions.
- Azure AD OIDC uses Authorization Code + PKCE; Azure AD config remains disabled by default.
- Node enrollment uses one-time tokens and stores only hashes.
- Controller/node traffic must be transport-layer encrypted.
- Development can use a local CA or trusted dev certificates.
- Production should support certificate rotation and a path to mutual TLS or equivalent node identity.

Required encrypted flows:

- enrollment;
- heartbeat/status;
- commands and acknowledgements;
- meter frames;
- live monitor audio;
- recording/job metadata;
- local event log sync;
- health and alert updates.

Current partial implementation:

- Controller can start HTTPS when TLS cert/key paths are configured.
- Agent rejects non-loopback `http://` controller URLs unless explicitly allowed for development.
- Localhost HTTP remains available for local development.

---

## Recording Library

Required features:

- rename;
- folders;
- tags;
- schedule relationship;
- node/interface/channel relationship;
- recording profile relationship;
- health timeline;
- playback controls;
- download;
- waveform preview;
- search/filtering;
- checksums;
- cache/upload status;
- future preview/transcode assets.

Current partial implementation:

- Recording metadata and jobs persist through Drizzle/Postgres with JSON fallback.
- Scoped filters, metadata editing, playback, download, cache attach, and audit events.
- Recording library exposes scoped folder/tag facets with clickable UI filters.
- Recording library exposes relationship facets for nodes, profiles, upload policies, and split-track groups.
- Recording library supports browser-local date-range filters backed by UTC ISO query bounds.
- Recording library shows removable active filter chips for applied organization/search filters.
- Recording cards display node, schedule, profile, upload policy, and track relationship badges.
- Recording library can filter/search by recording profile and upload policy relationships.
- Recording job rows display capture interface, channel-map template, mode, and source channels.
- Recording library can display, search, and filter scheduled split recordings by track group.
- Recording library supports explicit server-side sorting with UI controls.
- Recording library supports paginated result sets with page-size and previous/next controls.
- Recording library action controls mirror RBAC for edit, stop, playback, download, and upload queue actions.
- Recording library API supports audited bulk folder/tag organization for scoped recordings.
- Recording library UI supports selecting visible recordings and bulk folder/tag organization.
- Recording library API deletes terminal recordings and cached files with audit snapshots.
- Recording library UI exposes RBAC-mirrored delete controls for terminal recordings.
- Recording library UI can bulk-delete selected terminal recordings.
- Schedule run-now materializes schedule-owned names, folders, tags, profile, watchdog policy.
- Ad-hoc starts accept target node, profile, upload policy, and optional metadata.
- Ad-hoc controller lifecycle coverage verifies start, node job claim, heartbeat, cache attach, auto-upload queue, playback, download, and file streaming.
- Scheduled lifecycle coverage verifies due-run metadata ownership through node claim, cache attach, auto-upload queue, playback, download, and file streaming.
- Stop-request lifecycle coverage verifies controller stop requests survive agent cancellation as completed recordings.
- Terminal health sync coverage verifies failed jobs become critical, unexpected cancellations become warning, controller-requested stops remain healthy, and cached recordings refresh health.
- `mise run check` includes fake-controller agent smoke coverage for `--run-next-job` without audio hardware.
- Agent job claim, capture, heartbeat, stop handling, cache upload, and leasing.
- Profile-driven jobs carry MP3/FLAC/WAV encoder targets; agent captures raw WAV then renders final cache output.
- Cache attach computes SHA-256 and WAV PCM waveform preview peaks.

## Storage Upload

Current rule:

- Local cache is the reliable source for now.
- SMB/S3 execution is early but functional; cache retention only runs after confirmed upload.

Current partial implementation:

- Failed upload retry queue for future SMB/S3 providers.
- Queue entries are auditable, visible, retryable, and metric-exported.
- Recording library can enqueue cached recordings and retry failed queue items.
- Upload providers expose enabled state, target, credential reference, readiness, and implementation status.
- Upload policy templates choose provider, target, trigger, and retry budget.
- Schedules and recordings carry `uploadPolicyId` for provider selection.
- Cache attach auto-queues recordings when enabled policy trigger is `on_recording_cached`.
- Executor processes due queue items through provider readiness and retry budgets.
- SMB copies cached files to mounted share targets; S3 sends cached files to `s3://` targets.
- SMB verifies copied bytes with SHA-256; S3 uploads send `ChecksumSHA256`.
- Controller upload runner executes due items on an interval and audits summary/item outcomes.
- Controller API and Settings UI expose upload runner status and run-now control.
- Upload policies can delete controller cache after confirmed non-stub upload.

## Observability

Telemetry surfaces:

- local node lifecycle log;
- central health events;
- central audit events;
- Prometheus `/metrics`;
- future OpenTelemetry/Mimir guidance.

Important metric names:

- `rakkr_node_online`
- `rakkr_node_offline_alerts_active`
- `rakkr_input_rms_dbfs`
- `rakkr_input_peak_dbfs`
- `rakkr_input_clipping_ratio`
- `rakkr_input_speech_score`
- `rakkr_input_noise_score`
- `rakkr_recording_active`
- `rakkr_recording_duration_seconds`
- `rakkr_recording_bytes_written`
- `rakkr_recording_watchdog_alerts_total`
- `rakkr_upload_queue_depth`
- `rakkr_upload_failures_total`
- `rakkr_device_xruns_total`

## Date And Time Rules

- Store timestamps as UTC ISO 8601.
- API timestamps are ISO 8601 strings.
- Display in browser/user timezone.
- Display format is year-first.
- Schedule definitions include explicit timezone.
- Filenames default to year-first.

Examples:

- Date: `2026-06-18`
- Date/time: `2026-06-18 14:45`
- Exact timestamp: `2026-06-18T10:45:03.123Z`

Current partial implementation:

- Web date helpers centralize browser-timezone, year-first display and local date-to-UTC conversion with regression coverage.

---

## Milestones

| Milestone | Goal | Status |
| --------- | ---- | ------ |
| 0. Foundation | Monorepo, Docker, API/UI shells, shared types | ✅ |
| 1. Test rig visibility | Agent identity, meters, loopback validation, node UI | 🟨 |
| 2. First reliable recording | Start/stop, cache, metadata, playback, download, health | 🟨 |
| 3. Scheduling | Human scheduler, metadata ownership, execution events | 🟨 |
| 4. Watchdog reliability | Scheduled health alerts, timelines, metrics | 🟨 |
| 5. Operations | Organization, templates, audit search/export, upload stubs | 🚧 |
| 6. Integrations | SMB/S3, Azure AD OIDC, Iroh, AI quality | 🧊 |

## Focus Queue

1. ✅ Add local VAD and noise/speech scoring.
2. ✅ Harden recording file-growth and terminal failure transitions.
3. ✅ Add profile-driven encoder output for MP3 VBR/WAV/FLAC.
4. ✅ Add waveform/metadata extraction for encoded cache files.
5. ✅ Add RBAC-gated audit CSV export.
6. ✅ Add policy-controlled cache deletion after confirmed upload.
7. ✅ Add request-driven ad-hoc recording start.
8. ✅ Add checksum verification for confirmed uploads.
9. ✅ Add RBAC-gated controller meter-preview listen stream.
10. ✅ Add controller TLS bootstrap and agent plaintext transport guard.
11. ✅ Add schedule profile max-track splitting.
12. ✅ Add RBAC/audited node identity edits.
13. ✅ Add RBAC/audited interface and channel identity edits.
14. ✅ Add agent runtime heartbeat and node runtime display.
15. ✅ Add full node location hierarchy editing and display.
16. ✅ Add stale heartbeat offline status derivation.
17. ✅ Add stale node heartbeat health-event lifecycle.
18. ✅ Add node-offline Prometheus alert metric.
19. ✅ Add event-type health filtering.
20. ✅ Add node connectivity health summary UI.
21. ✅ Add explicit interface hardware path and serial inventory fields.
22. ✅ Prefer sysfs device paths and serials in agent inventory.
23. ✅ Add status-aware node badges across dashboard and inventory.
24. ✅ Add node inventory status filtering.
25. ✅ Add node inventory identity search.
26. ✅ Add recording library folder/tag facets.
27. ✅ Add recording library date-range filters.
28. ✅ Add recording relationship badges.
29. ✅ Add removable active recording filter chips.
30. ✅ Add recording profile and upload policy filters.
31. ✅ Add recording job interface and channel-map details.
32. ✅ Add split-track group display and filtering.
33. ✅ Add recording library sorting controls.
34. ✅ Add recording library pagination controls.
35. ✅ Add recording relationship facet groups.
36. ✅ Add RBAC deny-precedence regression coverage.
37. ✅ Mirror recording library action controls against RBAC permissions.
38. ✅ Add expandable audit event details.
39. ✅ Add audit permission and reason filters.
40. ✅ Add structured access policy composer.
41. ✅ Add structured user scope composer.
42. ✅ Add access policy audit snapshot route coverage.
43. ✅ Add recording metadata deny audit route coverage.
44. ✅ Add live-listen deny audit route coverage.
45. ✅ Add recording stop deny audit route coverage.
46. ✅ Add recorder-level deny inheritance coverage for recordings.
47. ✅ Add schedule run-now deny audit route coverage.
48. ✅ Add alert acknowledgement deny audit route coverage.
49. ✅ Add playback, download, and upload queue deny audit route coverage.
50. ✅ Add browser-timezone year-first date helper coverage.
51. ⏸️ Return to X32 hardware validation after device is confirmed.
52. ✅ Add controller-side ad-hoc recording lifecycle regression coverage.
53. ✅ Add fake-device agent CLI lifecycle smoke test.
54. ✅ Add scheduled recording lifecycle coverage through agent cache attach.
55. ✅ Add stop-request lifecycle coverage from controller stop to agent cancellation.
56. ✅ Add recording health sync coverage for failed/cancelled/cache terminal transitions.
57. ✅ Add RBAC-gated bulk recording folder/tag organization API.
58. ✅ Add bulk recording organization UI for visible library results.
59. ✅ Add RBAC-gated recording delete API with cache cleanup and active-recording guard.
60. ✅ Add recording delete UI controls for permitted terminal recordings.
61. ✅ Add access-policy deny coverage for recording delete.
62. ✅ Add selected-recording bulk delete UI for terminal recordings.

## Open Questions

| Question | Current Lean |
| -------- | ------------ |
| ALSA/JACK/PipeWire order | ALSA first, then JACK/PipeWire adapters |
| Rust MP3 encoder path | Evaluate during agent recording pipeline hardening |
| Live monitor protocol | HTTP WAV preview now; encrypted WebSocket/chunk stream for agent audio next |
| Node local log store | JSONL now; SQLite likely later |
| Metrics internals | Prometheus endpoint now; OTel-friendly structure later |

Last updated: `2026-06-19`
