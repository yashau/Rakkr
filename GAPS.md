# Rakkr — Gap Hunt Findings

Adversarial audit on branch `worktree-gap-hunt` (base `86861142`). Four independent
hunters swept authz-enforcement, the recording control loop, enhancement/watchdog,
and cross-cutting concerns. Every finding below was re-read in source before listing.

**Status legend:** `FIXED` = failing test + fix landed in this branch · `CATALOGUED` =
confirmed/repro'd, fix recommended but not applied (blast radius or product call) ·
`SUSPECTED` = strong lead, not fully substantiated.

The guardrails are genuinely good — the authz core (deny-precedence, cascade,
token-auth atomicity, AES-256-GCM construction, key non-exposure) and the scheduler's
UTC/DST core were checked and found **correct**. The gaps cluster where behaviour can
only be proven against real hardware/Postgres/time, exactly as the source-of-truth doc
admits. The structural verifiers (string-presence greps) can catch none of the below.

**Landed (each with a test):** G1, G1b, G2, G3, G4, G4-1, G4-2, G5, G6, G7, G10, G11, G12, G13,
G19-G66 broadly incl. G47b/G48b/G50b/G51b/G55-d (51 confirmed findings landed); G26 mostly-fixed via G25. Systemic recording-status CAS + a few Rust/agent items remain (see Run 10).
**Open (confirmed, pre-existing):** G27 (one-time-schedule defer data-loss — Medium), G28
(live-listen session leak — Low-Med); G9 (keepRaw wording); coverage G14/G16/G29; G4 follow-up
(auth-service/oidc-login).
**Suspected / low:** G17, G18, G20, G22, G23, G30, G4-2, G24-1.
**Iteration loop:** Run 1 & Run 2 both dirty. Run 2's adversary caught + fixed a HIGH regression
in G4 itself (G4-1). Streak 0/5 — the loop keeps surfacing real pre-existing findings (G27 is the
notable one); reaching 5 clean is a multi-run horizon. Run log at the end.
Rebased onto `origin/main` (`844f6a8e`); **G1b is a fresh-on-main catch** — PR #14 reintroduced
the G1 data-loss pattern in its new chunked-upload path, which this audit caught on rebase.

---

## Archived findings G1–G16 (compacted — full detail in git history / commit messages)

Early runs; all resolved or catalogued with locations recorded. One line each.

**CRITICAL**
- **G1** `FIXED` — Partial upload deletes shared cache, stranding a retryable destination. `upload-runner.ts` `reconcileRecordingUpload`; gate cache release on `failed.length===0`; test in `upload-runner.test.ts`.
- **G1b** `FIXED` — Chunked path (PR #14) deletes a chunk's cache on partial success (G1 at chunk level). Gate on `settled && failed.length===0 && succeeded.length>0`.
- **G2** `FIXED` — Raw master lost despite `keepRaw` when supplementary raw upload fails. `upload_recording_renditions` now returns `Err`; pure `resolve_rendition_upload`; retention skips deleting local raw when raw not secured. Tests in `recording_job_upload::tests`.
- **G3** `FIXED` — CSV formula injection in all six exporters. Shared `csvCell()` prefixes `'` + always quote-wraps.

**HIGH**
- **G4** `FIXED (503)` — Silent permanent failover to in-memory store on any DB error. `DatabaseUnavailableError` + `app.onError`→503; 9 DB-authoritative stores throw; in-memory-primary stores (audit/health/meter/node/auth) left resilient. Tests: `database-unavailable.test.ts` + gated integration.
- **G5** `FIXED` — Non-atomic recording-job claim → double-claim. Atomic `claim(job, expectedStatus)` (conditional UPDATE / JSON check-and-set). Postgres test `recording-job-claim-atomic.test.ts`.
- **G6** `FIXED` — Crypto fails open (dev key used when `RAKKR_SECRET_KEY` unset in prod). Fail closed in prod (missing/short key throws); mirrored to SSH master key.
- **G7** `FIXED` — Watchdog reads stale meter frames as live. Treat frame older than freshness bound as missing → fail-closed flatline.
- **G8** `CATALOGUED` — `localDateTimeInput` drifts −1h across the fall-back DST hour (`apps/web/src/lib/dates.ts:65-74`). Fix via `Intl.DateTimeFormat(...).formatToParts`. Needs web/vitest TZ harness.
- **G9** `CATALOGUED` — `keepRaw=false` + enhancement drops raw vs "always preserved" invariant. Product decision (forbid vs reword doc).

**MEDIUM**
- **G10** `FIXED` — Retention deletes cache for `partial`/never-uploaded when `deleteOnlyAfterUploaded=false`. Unconditional floor: never delete while `partial`/retryable-queued.
- **G11** `FIXED` — Agent meter-health events flap on a single transient frame. Debounced `MeterHealthState` (3-frame persistence).
- **G12** `FIXED` — `auth/groups`/`auth/users` bypass pagination clamping. Route through `parsePagination(PAGE_POLICY.default)`.
- **G13** `FIXED` — Unbounded response when `limit` omitted on `paginate()`-direct routes. Same `parsePagination` fix.
- **G14** `CATALOGUED (coverage)` — Multi-user IDOR/grant isolation untested (`index.ts` `resourceScopeDecision`). Needs two-user grant-isolation tests.
- **G15** `CATALOGUED (coverage)` — Date/time verifier is string-presence only; no DST behavioural test.
- **G16** `CATALOGUED (coverage)` — `render_enhanced_output`/`upload_recording_renditions` have zero tests.

---

## LOW / SUSPECTED

- **G17 (LOW, by-design?)** `audit-scope.ts:14-47` — collection/`controller`-level audit
  events are readable by any `audit:read` holder regardless of resource scope; those rows
  embed concrete resource ids in `details`/`correlationIds`. Likely intentional (audit is
  oversight); confirm the `auditor`-sees-denied-ids exposure is acceptable.
- **G18 (SUSPECTED)** `auth-utils.ts:144-148` — a `user` access policy matches on id **or**
  email; an allow policy keyed by a reused/re-created email could over-grant across
  identities/providers. Fails safe for deny.
- **G19 — `FIXED`** `packages/shared/src/base.ts` — `isoDateTimeSchema` was
  `z.string().min(1)`; a non-date value passed Zod then threw `RangeError` at
  `new Date(value).toISOString()` (500 instead of 400). Added a `Date.parse` `.refine`.
  **Test:** `input-hardening.test.ts` (rejects `not-a-date`/`tomorrow`/``, accepts ISO).
- **G20 (SUSPECTED)** module-load `JSON.parse` without try/catch in ~11 stores
  (`recording-jobs.ts:624`, `settings-store.ts:732…`, etc.) — a corrupt `data/*.json` fails
  boot. `upload-destinations.ts` already degrades gracefully; mirror it.
- **G21 — `FIXED`** `password.ts` — `verifyPassword` didn't validate the numeric scrypt
  params; a malformed stored hash reached scrypt as `NaN` and threw instead of returning
  false. Now validates cost/blockSize/parallelization are positive integers first.
  **Test:** `input-hardening.test.ts` (malformed hashes return false, never throw).
- **G22 (SUSPECTED)** `channel_map.rs:289-298` — positional fallback in `entry_for_output`
  can map an output channel to the wrong source when output indices are sparse/mixed;
  relevant to capture-once/split-many subset extraction.
- **G23 (SUSPECTED)** `watchdog-node-liveness.ts:50-60` — a node-offline alert
  auto-resolves on the first fresh heartbeat regardless of `acknowledged`/`suppressed`,
  discarding an operator ack on flap.

---

## Verified clean (checked, no bug)
Deny-precedence & cascade; token-auth atomicity (single-use bootstrap consume,
`timingSafeEqual` runner token); SSH private-key non-exposure; AES-256-GCM construction
(random IV, verified tag, scrypt KDF); upload-destination secret masking; scheduler
`localDateTimeToUtc` DST fixpoint; Rust agent all-UTC timestamps; SMB client closed in
`finally`; sort fields are enum/hardcoded allowlists (no sort injection).

---

## Iteration run log

Following `docs/contributing/audit-workflow.md`. Target: **5 consecutive clean runs.**
A run is _dirty_ if it changes any file, a gate fails, or `main` advanced with un-audited
commits → streak resets to 0. Runs are strictly sequential.

Pre-loop: fixed 14 confirmed findings (G1, G1b, G2, G3, G5, G6, G7, G10, G11, G12, G13,
G19, G21), each with a red→green test. Deferred by design: **G4** (silent DB failover —
architectural: latches `dbAvailable=false` across 14 stores; needs a re-probe-circuit-breaker
vs 503-vs-surface decision), **G9** (keepRaw=false vs "always preserved" — product wording).

| Run | main @ | Focus | Findings (Conf/Cov/Susp) | Fixes | Gates | Clean? | Streak |
| --- | ------ | ----- | ------------------------ | ----- | ----- | ------ | ------ |
| 1 | `8a11b629` | branch-diff adversary + fresh correctness/authz + chunked | 3 / 0 / 1 (G24, G25, G26) | — surfaced; need decisions | green | **no** | 0 |
| 2 | `8a11b629` | adversary on G4/G24/G25 + fresh sweep (live-listen, node-lifecycle, metrics, scheduler) | 3 / 1 / 3 (G4-1, G27, G28; G29; G30, G4-2, G24-1) | **G4-1** (fixed) | green | **no** | 0 |
| 3 | `8a11b629` | web console + Rust agent internals | 3 / 0 / 2 (G31, G32, G34; G33, G35) | G31, G32, G34 (fixed) | green | **no** | 0 |
| 4 | `8a11b629` | infra (ansible/db/deploy/scripts) + broad residual re-sweep | 2 / 1 / 2 (G36, G37; G38; G39, +1) | G36, G37 (fixed) | green | **no** | 0 |
| 5 | `8a11b629` | adversary on newest fixes + 2nd broad core re-sweep | 1 / 0 / 2 (G40; G41, G42) | G40 (fixed) | green | **no** | 0 |
| 6 | `8a11b629` | deep RBAC/IDOR + state-machine/concurrency | 1 / 1 / 0 (G43; G44) | — (both need reviewed slices) | green | **no** | 0 |
| 7 | `8a11b629` | adversary on G43 + broad sweep | 2 / 0 / 0 (G45, G46) | G45, G46 (fixed) | green | **no** | 0 |
| 8 | `8a11b629` | trust-boundary + Zod-bounds + broad adversary (3 hunters) | 7 confirmed (G47-G53) | **4 fixed** (G47, G48, G49, G51); G50/G52/G53 remain | green (API 373/0) | **no** | 0 |
| 9 | `8a11b629` | adversary-on-fixes + lifecycle state-machine + fresh-sweep (3 hunters) | 9 confirmed (G47b, G54, G55, G56, G57, G48b, G58, G50b, G51b) | **all 9 fixed** | green (API 385/0) | **no** | 0 |
| 10 | `8a11b629` | adversary-on-fixes + Rust deep-dive + recording-status sweep (3 hunters) | 10 confirmed (G59-G66, G55-d) + 2 areas uncovered | **6 fixed** (G59, G60, G63, G64, G66, G55-d); G61/G62/G65 deferred | green (API 388/0, Rust 152/0) | **no** | 0 |
| 11 | `8a11b629` | DB layer + health/watchdog (coverage gap) + adversary-on-fixes (3 hunters) | 8 confirmed (G59b, G67-G73) | **7 fixed** (G59b, G67, G68, G69, G71, G72, G73); G70 catalogued | green (API 393/0, Rust 152/0) | **no** | 0 |

**Run 2 — DIRTY.** The adversary caught a **HIGH regression in G4 itself (G4-1)**: converting
`failover()` to throw turned a DB blip in a background-runner tick into an unhandled promise
rejection → process crash (bigger blast radius than the bug G4 fixed). **Fixed** — every runner's
scheduled/startup `void tick()` now `.catch`es via `reportRunnerTickError` (skip tick on
DB-unavailable, retry next interval); request-path `runOnce()` still 503s. The fresh sweep found
two pre-existing bugs (**G27** one-time-schedule data loss on channel-conflict defer; **G28**
live-listen session-store leak) + coverage/low items (**G29/G30/G4-2/G24-1**), catalogued below.
Full gates re-green: API **353 / 0 / 2-skip**, agent 147/0, clippy/oxlint/fmt clean. Streak resets
to **0** (G4-1 changed files).

### G4-1 — Background-runner tick crashes the process on DB-unavailable · `FIXED`
`upload/schedule/retention/recording-job-lease/watchdog-runner.ts`. After G4, a store `list()`/
`save()` in a runner tick throws `DatabaseUnavailableError`; `setInterval(() => void tick())`
discarded the rejection → unhandled → crash. **Fix:** `reportRunnerTickError` + `.catch` on both
`void tick()` sites per runner (scheduled path degrades; `runOnce()` still propagates → 503).
**Test:** `runner-tick.test.ts` (handler never rethrows).

### G27 — One-time schedule permanently disabled when its only occurrence hits a channel conflict · `FIXED`
**Fixed:** the deferral branch now retries via `retryScheduleAfterFailure` instead of advancing/disabling; a `once` schedule stays enabled + armed. Test verified red (enabled=false) → green.
`schedule-runner.ts:160-208` + `schedule-engine.ts:201-206`. On a channel-conflict deferral the
runner calls `advanceScheduleAfterRun` unconditionally; for `mode: "once"` that returns
`{ enabled: false, nextRunAt: undefined }` — identical to a *successful* completion. So a one-time
schedule whose sole occurrence is transiently deferred is disabled forever and **never records**
(only a `capture_channels_busy` warning). Real recording-loss. **Fix:** in the deferred branch,
reschedule `once`/`always_on` via `retryScheduleAfterFailure(now)` instead of advancing as if
completed. (Deferral branch has no test — see G29.) **Severity: Medium.**

### G28 — Live-listen `MemoryListenSessionStore` never evicts abandoned sessions · `FIXED`
**Fixed:** lazy eviction-on-access by TTL (`RAKKR_LISTEN_SESSION_TTL_SECONDS`, default 300s); clock injected for deterministic tests.
`listen-session-store.ts:30-84`. Sessions are added in `start()`, removed only in `stop()`; an
operator closing the tab / dropping network without `DELETE /listen/:id` leaves the record
forever — unbounded process-lifetime memory growth. (`nodeWantsEnhanced` filters stale demand by
`lastSeenAt`, but the records are never freed.) **Fix:** evict on read by max-age (reuse the
monitor freshness window) or a periodic sweep / per-node cap. **Severity: Low-Medium.**

### G29 — Scheduler deferral path + channel-conflict matrix untested · `NEW · COVERAGE`
`schedule-runner.test.ts` has zero defer/busy/conflict coverage; there is no `channel-conflicts.test.ts`.
This is why G27 slipped through. **Fix:** unit-test the overlap matrix (`"all"` vs list, list vs
list) and drive the deferred branch end to end.

### G30 — `node:read` can read lifecycle-run stdout/stderr; audit omits stdout/stderr vs AGENTS.md · `NEW · SUSPECTED`
`node-lifecycle-routes.ts:39-67,100-115`. Reading lifecycle jobs (incl. raw Ansible `stdout`/
`stderr`) needs only `node:read` while running needs `node:manage` — a read-vs-manage asymmetry
(no confirmed secret in output today, but one careless `debug:`/`-vvv` from leaking). Separately,
the success audit omits `stdout`/`stderr` though AGENTS.md says lifecycle runs are audited with
them — a doc/code divergence to reconcile. **Severity: Low / informational.**

### G4-2 & G24-1 — low-severity metric consequences · `NEW · SUSPECTED`
**G4-2 (`FIXED`):** `/metrics` reads `recordingStore.list()`/`listUploadQueueItems()`, so during a DB blip it
now 503s — observability disappears exactly when needed. Consider catching in the metrics route +
emitting a `database_unavailable` gauge. **G24-1:** `rakkr_upload_failures_total` is a `counter`
computed from live `attemptCount` of currently-`failed` items; G24's retry (→ attemptCount 0,
status retrying) makes the value *decrease* (a counter reset that `rate()` over-counts). Pre-existing
mis-modeling, newly triggerable — model failures as a true monotonic counter incremented in `fail()`.

**Post-run-1 fixes (your decisions):** G24 (retry resets budget), G25 (chunked terminal →
`partial`) landed with tests; G26 resolved for the stuck-status symptom via G25. G4 decided as
503 but deferred (see G4). Full gates re-green: API **349 / 0 / 1-skip**, agent **147 / 0**,
clippy + oxlint + fmt clean. Streak stays **0/5** — the branch cannot be "clean" until G4 lands,
so the next audit run should follow the G4 slice.

**Run 1 — DIRTY.** Two independent hunters: an adversary on the 14 fixes, and a fresh sweep of
the least-audited chunked surface. The adversary confirmed the 14 fixes are correct and complete
**except** it caught that G1/G10 partial-cache retention has no reclaim path — which traces to
**G24**. The fresh sweep found the chunked lease-expiry gap (**G25**) and its finalization twin
(**G26**). Nothing fixed this run: G24 is a `retry()`-semantics decision (an existing test relies
on today's behavior) and G25/G26 are a multi-file chunked-lifecycle slice — all warrant a steer,
not an autonomous change. The 14 prior fixes stay green (API 346/0/1-skip; agent 147/0; clippy/
oxlint/fmt clean). Streak remains 0.

### G24 — Operator retry is a no-op on terminally-`failed` upload items · `FIXED`
**Fixed:** `retry()` (both stores) now resets the attempt budget (`attemptCount = 0`,
`status = "retrying"`, due now) so a terminally-failed upload is genuinely re-attempted by the
runner — which also gives a `partial` recording's cache a reclaim path. **Tests:**
`recording-upload-queue-routes.test.ts` ("operator retry revives a terminally-failed upload
item…") + rewritten `upload-queue.test.ts` retry spec; force-failed test fixtures reworked to
use real `start`/`fail` cycles instead of abusing `retry()`. Original analysis:
`apps/api/src/upload-queue.ts:173-191` (JSON) & `:416-438` (Postgres); retry is offered via
`retryableUploadQueueStatuses = {cancelled, failed}` (`recording-upload-queue-routes.ts:58,218`).
`retry()` does `attemptCount + 1` then `status = nextAttempt >= maxAttempts ? "failed" :
"retrying"`. A `failed` item is already at `attemptCount >= maxAttempts`, so retry leaves it
`failed` — never returns to `retrying`, never re-run (`dueStatuses = {queued, retrying}`). The
retry action does nothing on the items it is offered for. **Consequence for G1/G10:** a `partial`
recording's cache is correctly retained (the un-uploaded destination's only source), but with
retry broken there is **no path to reclaim it** short of deleting the recording → unbounded
controller-cache growth when a destination chronically fails.
**Fix (needs a decision):** make operator `retry()` reset the attempt budget (`attemptCount = 0`,
`status = "retrying"`, due now) in both stores so the runner re-attempts; a successful retry then
flips the recording to `uploaded` and retention reclaims the cache. This changes `retry()`
semantics — the test `upload queue routes use scoped recording context…` uses `retry()` to *force*
a `failed` state (`maxAttempts:1`), so it needs reworking. Also reword the G1/G10 retention
comments (cache is retained to preserve the only copy, not because failed items auto-retry).

### G25 — Lease expiry hard-fails a chunked recording, discarding uploaded chunks · `FIXED`
**Fixed:** `markAgentJobTerminalRecording` now consults `listRecordingChunksForRecording`; a
`failed` terminal state resolves to `partial` when any chunk is `cached`/`uploading`/`uploaded`/
`partial`, preserving secured progress. Covers both the lease listener and the agent
job-terminal route. **Test:** `agent-job-terminal-recording.test.ts` (chunked-with-chunks →
`partial`; no-chunks → `failed`). Original analysis:
`apps/api/src/agent-job-terminal-recording.ts:64-75` (`terminalRecordingStatus` returns `failed`
unconditionally), the `index.ts` lease listener, and `recording-jobs.ts expireRecordingJobLeases`
(30s lease). Chunked recordings upload each chunk as it closes; if the agent's control-plane
heartbeat blips >30s while capture continues (intended), the controller expires the lease and
marks the whole recording `failed` even though N chunks are already `cached`/`uploaded`. The
agent's own outcome here is `partial` (`recording_job_chunked.rs finish_partial_after_failure`),
and `partial` is a valid status. If the final chunk later arrives, `markRecordingCachedFromChunks`
then flips `failed` → `cached` (status flap). **Fix:** in the lease-expiry terminal path, consult
`listRecordingChunksForRecording` and resolve to `partial` (not `failed`) when any chunk is
`cached`/`uploading`/`uploaded`/`partial`. **Severity: Medium** (window-dependent).

### G26 — Chunked recording sticks non-terminal when the final chunk (carrying `chunkTotal`) never arrives · `MOSTLY FIXED (via G25)`
**Status:** the stuck-status symptom is resolved by G25 — a dead capture expires the lease →
`markAgentJobTerminalRecording` sets the recording to `partial` directly, so it is no longer
stuck non-terminal. **Residual (minor follow-up):** the upload-runner's per-chunk
`reconcileChunkedRecordingUpload` cache-retention gate still won't run for a recording whose
`total` never arrived (finalization requires `chunks.length >= total`); those chunk cache
objects are retained until the recording is deleted. Not data-loss; a cache-cleanup gap.
Original analysis:
`apps/api/src/upload-runner.ts:383-408` finalization requires `total !== undefined && chunks.length
>= total`; `total` is stamped only by the final chunk's `chunkTotal`. If capture dies mid-stream
(`finish_partial_after_failure` persists `chunk_total: None`) or a middle chunk exhausts retries,
the final chunk never arrives, `total` stays undefined, and the recording never promotes to
`uploaded`/`partial` — its cache-retention gate never runs. **Fix (twin of G25):** controller-side
terminal reconciliation for a chunked recording whose owning job is terminal but whose `total`
never arrived — treat "job failed/partial + ≥1 uploaded chunk + none incoming" as `partial` and run
per-chunk retention.


---

## Archived Runs 3–7 (G31–G46, compacted — full detail in git history)

Runs 3–7 hardened bootstrap/enhance (Rust), web auth-gate, infra/ansible, RBAC/IDOR,
and chunked-recording finalization. All settled; one line each.

- **G31** `FIXED` (High) — bootstrap left the SSH private key on disk on most error paths -> RAII `Drop` wipe.
- **G32** `FIXED` — enhanced-render intermediates leaked on error paths -> RAII `IntermediateCleanup`.
- **G33** `CATALOGUED` — zero-audio chunked recording never signals completion (agent, narrow edge).
- **G34** `FIXED` — web: any `/auth/me` error forced re-login + left a stale token -> typed `ApiError` + `authGate`.
- **G35** `CATALOGUED (coverage)` — web: no distinct 503 database-unavailable UX.
- **G36** `FIXED` (High) — ansible runner `/runs` had no auth -> constant-time token check (`runner_test.py`).
- **G37** `FIXED` — SMB upload path traversal via `pathOverride` -> drop `.`/`..` segments.
- **G38** `CATALOGUED (coverage)` — migration verifier replays but never checks schema<->migration drift.
- **G39** `CATALOGUED (Low)` — secrets passed as process args (runner extra-vars, agent.sh token).
- **G40** `FIXED` — upload-queue retry route lacked a server-side status guard -> 409 on non-retryable.
- **G41** `CATALOGUED (likely by-design)` — `always_on` schedules never re-arm after the job ends.
- **G42** `CATALOGUED -> RESOLVED` — recording read-modify-write last-write-wins; closed by the recording-status CAS (G65/R13-2/R13-8).
- **G43** `FIXED (controller) / agent residual` — chunk render failure stranded a recording in `cached`; controller now finalizes `partial` when the job is terminal (`chunkedRecordingFinalization`). Agent drop-and-lose residual tracked with RS1/Rust-C2.
- **G44** `CATALOGUED (Low, fail-closed)` — bulk/collection routes over-deny scoped non-admin operators; the per-item scoped filter is the real gate.
- **G45** `FIXED` — orphan chunk upload persisted empty `jobId`, crashing the chunk store -> reject with 409.
- **G46** `FIXED` — unbounded meter `levels` array wedged the watchdog -> `levels.max(512)`.

---

## Archived Runs 8-11 (G47-G73 + recording-status CAS, compacted - full detail in git history)

Runs 8-11 hardened the chunked-recording lifecycle, recording-job terminal
transitions, the recording-status race, DB orphan sweeps, and health/watchdog.
All settled; one line each.

**Run 8** (chunked lifecycle + terminal-transition cluster):
- **G47** `FIXED` - late/replayed cache upload resurrected a terminal job+recording -> scope-check 409 on terminal jobs.
- **G48** `FIXED` - unvalidated timezone -> 500 -> `ianaTimeZoneSchema` refine.
- **G49** `FIXED` (High) - deleting a chunked recording orphaned chunk files+rows -> sweep both.
- **G50** `FIXED` - age/bytes retention was a no-op for chunked recordings -> size/reclaim chunk files.
- **G51** `FIXED` - recording-job terminal transitions were non-atomic blind writes -> `transition(job, allowedFrom)` CAS for all five.
- **G52** `FIXED` - agent never deleted the uploaded enhanced rendition -> delete after upload + chunk sweep.
- **G53** `FIXED` - DST spring-forward gap start resolved to a shifted instant -> two-offset reconciliation.

**Run 9** (adversary + recording-status race):
- **G47b** `FIXED` - G47 guard missed partial/completed + the no-jobId path -> 409 when all the recording's jobs are terminal.
- **G54/G55** `FIXED` (High) - stale upload-reconcile (whole + chunked) overwrote a retried/terminal recording -> re-read guard.
- **G56** `FIXED` - retry left stale raw/enhanced renditions + chunk rows -> clear renditions + sweep chunks.
- **G57** `FIXED` - distinct policies on one destination collapsed -> match pathOverride+policyId in the active-dedup branch.
- **G48b** `FIXED` - corrupt persisted timezone starved the due-run pass -> guard the occurrence check.
- **G58** `FIXED` - S3 custom endpoints reported provider_validated -> added provider_declared.
- **G50b** `FIXED` - metrics under-sized chunked recordings -> sum chunk footprints.
- **G51b** `FIXED` - lease reaper blind-save reverted a CAS-completed job -> route reaper through `transition` + re-list.

**Run 10** (Rust chunked-capture + recording-status sweep):
- **G60** `FIXED` (High) - chunked wav render corrupted the file in place with a channel map -> render to a distinct `.rendered.wav`.
- **G59/G59b** `FIXED` (High) - chunked crash-recovery never sent chunkTotal -> derive max(highest+1, uploaded+pending) + stamp every recovered chunk.
- **G63/G64** `FIXED` (High) - retention + lease-expiry reverted a concurrently-secured recording -> re-read + preserve cached/uploaded/partial.
- **G66** `FIXED` - unstable pagination for equal recordedAt -> id tiebreaker.
- **G55-d** `FIXED` - chunked reconcile deleted a re-captured chunk's cache before the guard -> hoist the re-read.

**Run 11** (DB + health/watchdog):
- **G69** `FIXED` (High) - production watchdog runner never loaded operator policies -> thread the settings store, load per pass.
- **G67** `FIXED` (Med/High) - deleting a recording orphaned its jobs + upload-queue rows -> sweep both (like G49).
- **G68** `FIXED` - Postgres upload-queue start() was non-atomic -> conditional UPDATE ... RETURNING.
- **G71** `FIXED` - watchdog active-event lookups filtered type in-memory over a 500-cap -> push the filter into the query.
- **G72** `FIXED` - indefinitely-suppressed alert kept repeating -> treat as never-repeat.
- **G73** `FIXED` - agent could forge controller-/watchdog-reserved health-event type prefixes -> reject at the schema boundary.
- **G70** `CATALOGUED` (Med) - Prometheus active-alert gauges undercount past 500 events (store-level scoped aggregate; sibling of C2).

**Post-Run-11**: added `RecordingStore.transition(recording, allowedFrom)` (the recording-level CAS) and closed **G65** (stop routes downgraded a concurrently-secured recording); later extended to metadata (R13-2) and health-sync (R13-8) - all status writers CAS-guarded, with G54/G55/G63/G64 keeping re-read stopgaps as backstops.

Deferred/residual from these runs (still tracked below): G51b-race1 (lease
heartbeat TOCTOU, narrow), G61 (per-job agent state files, config-gated),
G62/G59-residual (decoupled chunked-finalize signal, needs Linux), DB hardening
notes (upload-dedup unique index; ~48 conns/process at replicaCount > 2).

## Run 12 findings (web console: RBAC affordances, pagination staleness)

Fresh sweep of the operator console for UI/API mismatches introduced or exposed
by the server-side pagination migration. All fixed with red->green helper/route
tests except the health half of G74 (catalogued).

### Fixed
- **G79** (`4d88e0b3`, Med) - the last unguarded recording-status writer:
  PATCH `/recordings/:id/metadata` and `/recordings/bulk-metadata` blind-wrote
  the whole scoped snapshot (status/cachePath), reverting a recording a
  concurrent upload had secured. Now overlay only the edited metadata onto a
  freshly-read canonical row; scoped context still drives values + audit.
  (Metadata routes extracted to `recording-metadata-routes.ts` for the LOC guard.)
- **G75** (`6ccbe6e8`, Med) - the access screen offered "Reset password" for
  OIDC users, which the API refuses (`non_local_user_password_unavailable`).
  Gate the button on `canResetUserPassword` (provider === "local"); drop the
  "local user" wording from the delete confirmation.
- **G76** (`b0ca680a`, Med) - seven node pickers/label lookups called
  `api.nodes()` with no limit -> server default 50, dropping the 51st+ node from
  dropdowns. Route them through `nodePickerFilters()` (limit 200 = API max).
  >200 nodes still needs a paginated picker (tracked).
- **G78** (`b0ca680a`, Low) - single upload enqueue + retry are audited but
  invalidated only `["upload-queue"]`, leaving the audit view stale (bulk enqueue
  refreshed both). Shared `auditedUploadActionQueryKeys` now drives all three.
- **G74 (jobs)** (`f7f683e8`, Med) - the jobs-workbench summary tiles counted
  over the paginated page, undercounting once matches exceeded the page size.
  The list route now returns a status `summary` over the full filtered set
  (`recordingJobStatusSummarySchema`); tiles consume it.
- **G77** (`ece292b4`, Low-Med) - the recordings page grouped recording jobs +
  upload items onto cards from a default 50-row global fetch (health-events
  already fetched 500), so a recording's entries fell off once >50 existed. Bump
  both to `recordingCrossReferenceLimit` (200); widen `api.uploadQueue` to accept
  limit/offset.

### Catalogued
- **G74 (health)** (Med) - the health-workbench summary tiles have the same
  page-scoped undercount, but the fix needs a store-level status aggregate across
  two RBAC read paths (unrestricted DB group-by + scope-restricted in-memory
  tally) - a store change, not a route patch. Sibling of G70.
- **G76/G77 residual** (Low) - the node picker (200) and recording-card
  cross-reference (200, global page) are still bounded and not scoped to the
  visible set; a complete fix needs recording-/scope-scoped list filters.

## Run 13 findings (4 parallel hunters: adversary-on-Run-12 + Rust agent + scheduler/settings/watchdog + upload/storage/node-lifecycle)

All confirmed findings fixed red->green; gates + all baseline verifiers green.

### Fixed
- **R13-1** (`a6bef739`, Med-High) - recorder-agent cache sweep leaked a
  surviving file when its sibling was already gone: `candidate_for_entry` aborted
  the whole entry to None (`.ok()?`), so the sweep dropped it from the manifest
  without deleting the survivor -> untracked, unreclaimable disk leak. Skip
  missing paths instead of aborting. (Miri-gated fs test.)
- **R13-2** (`2a75c34d`, High) - **G79 was incomplete**: the metadata routes'
  find+save still had a live TOCTOU clobber window (save is a full-column upsert;
  a concurrent secure between read and write reverts status/cache). Now commit
  through the `transition` CAS with a bounded re-read/re-overlay retry. This is
  the durable close the earlier ledger claim ("all writers guarded") overstated.
- **R13-3** (`f0cc9a80`, Med) - retention deleted the cache of a `cached`
  recording whose uploads were still queued/retrying (not just `partial`),
  stranding them with cache_path_missing = lost audio. Added an in-flight-upload
  floor mirroring the `partial` floor.
- **R13-4** (`0b2099d5`, Med) - `syncRecordingHealth` aggregated over the newest
  500 events of all statuses, so a long-open critical event pushed out by later
  churn dropped the recording's critical badge. Aggregate via `listAll` (uncapped)
  filtered to non-resolved. (Cross-type sibling of the per-type G71 fix.)
- **R13-5** (`3c067949`, Low) - watchdog-policy create schema left durations
  unbounded while update caps them at 86_400s; huge windows left recordings
  unmonitored. Bounded the base schema to match. (`4bbfb9f2` then extracted the
  watchdog schemas to their own shared submodule for the LOC guard.)
- **R13-6** (`e4ee870b`, Low) - adversary on G78: six sibling audited mutations
  (node rotate/enroll/update/interface, controller-name) didn't invalidate
  `["audit-events"]`, leaving the audit view stale. Added it, matching the
  schedules.tsx pattern.
- **R13-7** (`c8831982`, Low-Med) - two upload policies resolving to the same
  destination+subfolder wrote the same object key: the second silently overwrote
  the first while both reconciled to `uploaded` (false redundancy). Dedupe the
  fan-out by resolved target.
- **R13-8** (`8d33ef54`, Med) - proactive close of the last find+save status
  writer: `syncRecordingHealth` wrote healthStatus via a full-row save, reverting
  a concurrent secure (same TOCTOU as R13-2). Now commits through the status CAS.
  **All recording-status writers are now CAS-guarded** (stop=G65, metadata=R13-2,
  health-sync=R13-8); G54/G55/G63/G64 re-read stopgaps remain as safe backstops.

### Also fixed
- **Storage verifier drift** (`02cd43aa`) - `mise run storage:check` had been red
  since the G24 slice (`17602b5d`) renamed a test without updating the verifier's
  snippet list. Realigned. (Was a pre-existing broken gate on this branch, not a
  Run 13 regression.)

### Catalogued (not rushed)
- **Rust-C2** (Med) - chunked graceful-finish: if the FINAL trailing chunk's
  render fails, `finish_chunked_capture` writes terminal `completed` and never
  delivers `chunkTotal`, so the controller recording hangs unfinalized while the
  agent thinks it is done. Needs Linux integration testing (decoupled-finalize
  family with G62/G33); fix = mark `partial` on final-chunk render failure.
- **G74 (health)** still open (store-level status aggregate, two RBAC paths).
- Suspected/by-design (verified, no action): S3 custom-endpoint upload is
  provider-declared not read-back-verified (intended, G58); SMB/third-party error
  messages flow into audit `reason` (theoretical); lifecycle audit omits
  stdout/stderr but persists them on the job record; multi-replica schedule
  double-fire (Helm ships replicaCount 1, no leader election); upload-destination
  delete has no referential-integrity check vs referencing policies.

## Run 14 findings (adversary-on-Run-13 + fresh sweep: DB/web-forms/metrics/deploy)

### Fixed
- **Adv-C1** (`0312b4ae`, High) - **R13-3 was narrowed-not-closed**: the retention
  floor only covered queued/retrying, but a `failed` upload item is
  operator-retryable and an all-destinations-failed recording stays `cached`
  (not `partial`), escaping both floors. Retention then deleted its cache = the
  same data loss R13-3 targeted. Floor on queued/retrying/**failed** (only
  succeeded/cancelled are settled). Test covers the failed case.
- **Adv-C2** (`ae8231ef`, Med) - **R13-5 + C3 introduced a read-parse hazard**:
  `.max` on the base watchdog/profile schemas (which also `.parse` persisted
  rows) would 503 the policy/profile list on a legacy over-cap row. Reverted the
  base bounds (data schemas stay permissive); the input ceilings remain on the
  update schemas. Tests repurposed to guard the layering. Create-route drift is
  now catalogued (below).
- **C1** (`356edd6e`, Med-High) - docker-compose ran NODE_ENV=production without
  RAKKR_SECRET_KEY/RAKKR_NODE_SSH_MASTER_KEY, so the documented `docker compose
  up` stack threw on every secret write (upload dest creds, node SSH keys).
  Supplied length-valid local defaults (overridable via .env) + deployment docs.
- **S3** (`d1600332`, Low) - R13-2's post-loop fallback `save` could re-clobber a
  concurrent secure under pathological CAS contention; replaced with a
  no-save re-read (matches R13-8).

### Catalogued (not rushed)
- **C2** (Med, observability) - `rakkr_audit_events_total` /
  `rakkr_health_events_total` are Prometheus **counters** computed from the
  newest-500 scoped set, so they are non-monotonic (breaks rate()). Same class as
  G70; correct fix is a store-level scoped grouped-count (a redesign, not a
  patch), so tracked with G70.
- **Adv-C3** (Low, ~40 web mutations) - many audited mutations (access page,
  settings CRUD, jobs actions, exports, listen, ad-hoc start) don't invalidate
  `["audit-events"]`. But the audit page auto-refetches every 5s
  (`refetchInterval: 5000`), so this is ≤5s self-healing cosmetic staleness.
  G78/R13-6 covered the obvious paths; the rest are disproportionate to sweep
  (40 edits for ≤5s). Fix if ever done: a shared onSuccess audit-invalidation helper.
- **C4** (Med-Low, web) - clearing a required number field in the watchdog /
  recording-profile editors yields `Number("") === 0`, failing `.positive()` with
  a generic 400; optional fields collapse to 0 losing their unset state. Fix =
  a `parseNumberField` helper (empty -> undefined) + disable Save on invalid.
  Component-behavior (no render-test seam here); catalogued.
- **S1** (Low, perf) - R13-4's `listAll({recordingId})` per health-event
  ingestion is O(n) (O(n^2) over a churny recording's life). Better: a store-level
  non-resolved (open/ack/suppressed) filter so the query stays small. Correctness
  is fine; perf-only.
- **S2** (Low, semantic) - health aggregation counts `suppressed` events toward
  the recording badge (pre-existing; R13-4 amplified it). Needs a product decision
  (should suppression quiet the badge?) — like G9.
- **Watchdog/profile create-route drift** (Low) - create accepts durations/bitrate
  the update schema rejects (a direct-API over-range value can't be UI-edited).
  Correct fix = input-only bounding on the create schemas (deferred to avoid
  duplicating the bound defs); the base data schemas must stay permissive (Adv-C2).
- Suspected/by-design (verified): unbounded per-recording Prometheus label
  cardinality (small-fleet product); SSE `/meter-events` nginx buffering (UI polls
  instead); compose omits RAKKR_UPLOAD_DESTINATION_STORE_PATH (Postgres primary).

### Sound (adversary verified Run 13): R13-1, R13-7, R13-8 confirmed correct.

## Run 15 findings (adversary-on-Run-14 + last-corners sweep: docs/ansible/bootstrap/workflows/Rust)

### Fixed
- **RC1** (`5750de7a`, High) - Ansible lifecycle `restart_service` / `rotate_trust`
  were in `TOKEN_PROVISION_ACTIONS`, so the runner minted a fresh node token
  (revoking the live one) — but the `recorder_node` role only rewrites
  `recorder-agent.env` (the token's only writer) for install/update. So those two
  actions revoked the agent's controller token without writing the replacement,
  locking the node out (401 on every heartbeat) until a full deploy. Restrict
  minting to install_dependencies/update_binary. Test in `runner_test.py`.
- **S3-followup** (`e598f2be`, Low) - adversary on S3: the no-save exhaustion path
  returned 200 + a `...succeeded` audit while the edit was dropped (audit lie).
  Now returns `undefined` on exhaustion → single route 409s +
  `...failed`/`commit_contended`; bulk route skips it (accurate updatedCount).
  Reaching it still needs pathological contention; the clobber stays closed.

### Sound (adversary verified Run 14): Adv-C1, Adv-C2, C1 confirmed correct —
notably the feared watchdog `toISOString()` RangeError from an unbounded
windowSeconds is provably unreachable behind the runner's `readyAtMs` gate.
Last-corners verified SOUND: bootstrap installer + agent `--bootstrap` key wipe,
command-template/enhanced-render arg-injection safety, runner auth, release
workflows, docs site, CI gate scripts.

## Run 16 findings (adversary-on-Run-15 + cross-cutting end-to-end sweep)

### Fixed
- **C-NEW-1** (`860ea294`, Med) - whole-recording `deleteRecordingCacheFile` /
  `recordingCacheFileSize` only touched the primary `cachePath`, so a keepRaw
  enhanced recording's DISTINCT raw master (`<id>.raw.<ext>`, usually the largest
  rendition) leaked on disk on every delete/retention/post-upload-cleanup path
  and was invisible to byte-pressure retention (audit also lied cacheDeleted).
  The per-chunk helpers already union all renditions (G49/G50/G52); brought the
  whole-recording helpers to parity. Test in `recording-cache.test.ts`.

### Sound (adversary verified Run 15): RC1 + S3-followup confirmed correct, no
regressions to the Run 13/14 CAS/health work. Cross-cutting flows verified sound:
upload-reconcile↔retention↔retry ordering, orphan-row delete sweeps (chunks/jobs/
queue), terminal-job resurrection guard.

### Catalogued (Low)
- **Bulk metadata all-contended asymmetry** - if EVERY recording in a bulk
  metadata request loses the CAS (pathological), the route still audits
  `bulk_update.succeeded` with updatedCount 0 (truthful count, no clobber),
  whereas the single route now 409s. Optional consistency nicety, not a
  correctness bug; mirror the single-route failure if ever desired.

## Run 17 findings (adversary-on-C-NEW-1 + max-skeptic data-loss/RBAC re-sweep)

### Sound (verified)
- C-NEW-1 adversary: SOUND (dedup correct, undefined-not-0 preserved, no
  traversal-throw regression, no orphaned-raw path). 409-test genuine red->green.
- RBAC re-sweep: SOUND across agent node-token scope checks, runner/bootstrap
  token auth, body-param IDOR guards, upload-destination secret masking,
  live-listen scoping, audit target/actor/outcome consistency. No bypass found.

### RS1 (High, CATALOGUED - needs Linux capture-recovery integration)
Restart during runtime capture recovery permanently drops preserved early audio
and leaks the segment files. On a mid-capture device-loss/disk-shortfall,
`controller.rs` `preserve_recovered_capture_segment` renames the partial to
`<stem>.recovery-attempt-N.wav`, pushes it to `recovered_segments`, and persists
state (status running/captured); graceful completion then
`stitch_recovered_capture_segments` combines them before the upload checkpoint.
But if the agent RESTARTS before the stitch, `reconcile_previous_recording_job`
(`recording_job_recovery.rs:111-223`) uploads ONLY `state.output_path` (the last
segment) and reads `state.recovered_segments` merely to log a count -- never
stitching, uploading, or deleting them. So the pre-loss audio is lost while the
recording reports `uploaded`->`completed`, and the recovery-attempt files leak
(not in the recorder-cache retention manifest, which tracks only raw/output).
**Fix spec:** in the restart-recovery branch, when `recovered_segments` is
non-empty, reconstruct the job/capture-plan context (may require persisting
`render_command`/plan in AgentJobState across restart) and run
`stitch_recovered_capture_segments` (segments + output_path) before upload; on
stitch success delete the segment inputs, on failure mark the recording `partial`
+ preserve segments (never silent-complete with lost audio). **Why catalogued:**
end-to-end verification needs a Linux interrupted-capture scenario (ffmpeg +
recorder rig); shipping an unverified change to the reliability-critical recovery
path is higher-risk than the bug. Same class as G62/Rust-C2. Highest open item.

## Run 25 — CLEAN (health/watchdog alert-reconciler lifecycle deep pass, direct)

Traced the reconciler state machine (create -> repeat -> resolve -> suppress ->
acknowledge) across flatline (template) + the runner's low-signal copy; the
others (clipping/quality/channel-correlation/node-liveness) share the same
`shouldRepeat`/active-event pattern. **No new finding**:
- Active-event lookup filters by `type` in the query (G71) so the 500-row cap is
  per-type — the open event can't be hidden -> no duplicate.
- `shouldRepeat`: indefinite suppression (no `suppressedUntil`) never repeats;
  finite window repeats only after it elapses (G72); otherwise paces on
  `lastRepeatedAt` (stamped to now ONLY on a repeat), so alerts don't re-fire
  every tick.
- Updates write `status: existing.status` — an operator's acknowledge/suppress is
  preserved, not reset to open on the next evaluation.
- resolve -> `updateLifecycle` status "resolved" + resolvedAt/By; every path syncs
  recording health and audits with correct before/after + system actor.

**Clean-run streak: 3/5.**

## Run 24 — CLEAN (auth / OIDC / session / password deep pass, direct)

Thorough security-critical pass (done directly to conserve usage), **no new
finding**:
- **OIDC login** (`oidc-login.ts`): PKCE (code_verifier/challenge) + state +
  nonce, library-verified callback (expectedState/expectedNonce/pkce); login-state
  store is single-use (`consume` deletes), TTL-pruned/bounded, state stored HASHED;
  the Postgres path uses an atomic `DELETE ... RETURNING` with expiry/consumed
  checks. No replay, no leak.
- **Session tokens** (`auth-service.ts`): 256-bit random, stored as `hashToken`
  (hashed at rest), 12h TTL; `authenticate` rejects expired/disabled on the memory
  path AND the DB path filters `revokedAt IS NULL AND expiresAt > now` + disabled
  in SQL. Logout revokes both. Sound.
- **OIDC role mapping** (`oidc-sync.ts:65`): claim roles filtered to the known
  `roles` allowlist from a library-verified ID token (no arbitrary-role injection).
- **Password** (`password.ts`): scrypt; `verifyPassword("", "")` -> false
  (empty/unset hash rejected, so OIDC users with no local password can't be
  password-authed), malformed params -> false (no crash), length-checked
  `timingSafeEqual`. No empty-credential bypass.

**Clean-run streak: 2/5.**

## Run 23 — CLEAN (adversary-on-GH-START-1 + live-listen / node-lifecycle deep pass)

Adversary-on-GH-START-1: **SOUND** — the per-node capture-start lock is provably
correct (strict serialization, runs-after-settle, no wedge on throw, bounded
race-free cleanup), no deadlock/re-entrancy, response/audit byte-identical.
Live-listen + node-lifecycle pass (done directly; the subagent hit a usage limit
mid-run): **SOUND** — listen chunk-ingest is node-scoped + bounded (44..524288) +
audited; the session store is nodeId-scoped, evicts abandoned, bounded (G28);
listen routes gate `listen:monitor` + scoped node (Run 19); node-lifecycle jobs
carry a unique id so their running->succeeded/failed status is independent (no
shared-status clobber, blind save is fine); bootstrap single-use holds. One
catalogue-grade item below; no reachable/non-conditional bug -> run CLEAN.

### Catalogued (Low-Med, conditional)
- **NODE-ROT-1** - `PostgresNodeStore.rotateCredential` (`node-store.ts:449-457`)
  revokes all active credentials THEN creates the new one. A sub-second
  zero-credential window exists between the two (self-healing — the agent retries,
  and rotation is paired with an env-rewrite+restart per RC1), and if
  `createCredential` throws after the revoke succeeds (a DB blip in that window)
  the node is left with zero valid credentials until a re-rotation (operator-
  initiated, `node:manage`, recoverable). Same class as GH-START-2. Fix =
  create-then-revoke, revoking all active EXCEPT the just-created id
  (`... WHERE revokedAt IS NULL AND id != <new>`), so there's always >=1 valid
  credential and a failed create leaves the old one intact.

**Clean-run streak: 1/5.**

## Run 22 — DIRTY (adversary-on-G80 + "begin recording" flow deep pass)

Adversary-on-G80: **SOUND** (traversal + collision closed, SMB/S3 symmetric, 0
behavior change across 75 legit inputs, C-NEW-1/Adv-C1/metadata-409 intact).
Recording-start hunter found a confirmed concurrency bug (below) → run DIRTY.

### GH-START-1 (Med-High, FIXED `0288524e`) — capture-start conflict/capacity TOCTOU
The ad-hoc start route AND the scheduler read a jobs/recordings snapshot,
evaluate the channel-conflict + maxConcurrentRecordings guard synchronously, then
create the recording+job after more awaits — no atomic reservation between check
and create. Two concurrent starts on one node/interface both passed the guard
against the pre-create snapshot and both created (verified repro:
maxConcurrentRecordings 1 -> [202, 202] / 2 recordings). The "begin" counterpart
to G5's claim-time CAS. Fixed with a per-node serial lock (`capture-start-lock.ts`
`withCaptureStartLock`) shared by both paths; second start re-reads post-create ->
409. Tests: mutex unit + route concurrency ([202, 409], 1 recording).

### Catalogued (from the same hunter)
- **GH-START-2** (Low-Med, conditional) - if a store/settings read fails BETWEEN
  `recordingStore.create` and `createRecordingJob` (a DB blip in the ~1-2 await
  window), the recording persists `status:"recording"` with no job; lease expiry
  only acts on jobs, so it's stuck forever (no data loss). Same shape in the
  scheduler. Fix = create job before recording, or compensating delete on
  job-create throw. Needs a failure-injection test.
- **GH-START-3** (Suspected, Med) - `claimNextRecordingGroup` claims each member
  via an independent CAS in a loop, so two concurrent claim-next-group calls for
  one node can SPLIT a capture group (A gets M0, B gets M1). Reachable only via
  two concurrent claim-group calls for one node (retry / two agents) — the G5
  threat model, but the GROUP claim isn't group-atomic. Fix = claim the group in
  one atomic op.
- **GH-START-4** (ledger note) - the claim paths (`agent-routes.ts:382/428`,
  `agent-claim-group-route.ts`) still blind-`save` `status="recording"` rather
  than the CAS; benign (recording can't be secured that early) but contradicts
  the ledger's "all writers CAS-guarded" — accepted residual class.

## Run 21 — DIRTY (agent trust-boundary + upload-executor SMB/S3 deep pass)

Trust-boundary hunter: **CLEAN** — every agent-facing route enumerated
(heartbeat/meter-frame/health-events/inventory/cache-file/job-claim/bootstrap/
listen-chunk); schemas match downstream use, G45/G46/G19/G48/G73 intact, no
new poison-payload/allocation/traversal gap. (One informational SUSPECTED: the
cache-file PUT reads the body with no size cap — by-design for large-audio
uploads, own-recording scope; not actionable.)

### G80 (Med, FIXED `ccfd14c9`) — S3 object-key traversal (twin of the SMB G37)
`s3Key` used `path.posix.join`, which RESOLVES `..`, so an operator's
`uploadPolicy.pathOverride` with `..` escaped the destination's `s3.prefix`,
nullified it (bucket root), or silently collided two policies on one key (slips
past the R13-7 raw-string enqueue dedup -> false redundancy / silent overwrite).
SMB got this guard in G37; S3 never did. Fixed: split into segments, drop
empty/`.`/`..` (mirrors smbPathSegments). Test: pathOverride "../../escape" ->
contained "meetings/escape/...". This is a REAL bug a prior upload-focused run
(Run 14) missed — the surface is well-hardened but deep targeted passes still
surface genuine gaps. Run DIRTY; streak stays 0/5.

## Run 20 — DIRTY (deep Rust capture/recovery core + scheduler/time/resilience)

Scheduler/time/resilience hunter: **CLEAN** (DST/recurrence executed against real
edge dates — spring-forward gap, fall-back hour, monthly day-31 clamp, interval
alignment across skips, off-grid retry self-heal; all 5 runners' G4-1 isolation +
reentrancy guards; DB-503 boundary intact, no silent-fallback regression; NaN-guards;
G27 holds). Rust core hunter: found a **new High** finding (below) → run is DIRTY.
**Clean-run streak resets to 0/5.**

### GH-1 (High, CATALOGUED — needs Linux capture-recovery integration) — sibling of RS1
A failed segment stitch during **graceful** completion silently truncates audio to
the last segment and leaks the recovery-attempt files — RS1's twin, reached WITHOUT
a restart. When a runtime device-loss/disk-shortfall recovery has preserved
`recovery-attempt-N.wav` segments and `stitch_recovered_capture_segments`
(`recording_job_segments.rs:88-109`) then fails the ffmpeg concat (corrupt/short
segment, codec mismatch, transient), it logs a `warning` and
`return Ok(final_capture_path)` = only the LAST segment. `controller.rs:547-664`
renders/uploads that and marks the recording **`completed`** — silent loss of all
pre-loss audio, and the segment files (deleted only on stitch success) leak untracked
by the retention manifest. **Fix:** on stitch failure, do not return the tail as
whole — mark `partial` + emit a naming health event + preserve/track the segments;
never silent-complete. Needs a Linux failing-ffmpeg-concat scenario to verify.

### GH-2 (Low, SUSPECTED — product decision, like G9)
Restart-recovery uploads (`recording_job_recovery.rs:150-179` single + chunked) send
the raw as `rendition=None` (legacy primary), so a recovered recording/chunk ends up
with only the raw as its single playable rendition — no enhanced toggle,
inconsistent with normally-uploaded chunks. Raw is fully preserved (no audio loss);
quality/consistency degradation. Warrants a product call alongside G9.

### Systemic note: capture-recovery segment lifecycle
RS1 + GH-1 + GH-2 are one gap — the recovered-segment lifecycle is wired only for
the stitch-SUCCESS path (restart-before-stitch, graceful-stitch-failure, and the
rendition-drop are all unhandled). This is now comprehensively mapped and belongs
in ONE Linux-integration fix slice on the recorder rig. The controller/web/DB/shared
surfaces have converged (Runs 18/19 + Run 20 scheduler = clean); the remaining High
data-loss risk is localized here and is not fixable/verifiable from a Windows worktree.

## Run 19 — CLEAN (systematic RBAC enumeration + web-logic/DB round-trip)

**No new elevated findings; two LOW fail-safe items catalogued.**
- RBAC: FULL enumeration of all 27 route files / 19 register*Routes into a
  route×permission×scope×audit table — SOUND. No unauthenticated mutation, no
  wrong-permission gate, no IDOR, no token-unbinding; audit integrity intact.
  Confirms the sampling verdicts of Runs 6/17/18 by exhaustive enumeration.
- Web logic (121/121) + DB round-trip: SOUND. Enum parity 9/9, no read-parse
  hazard remains (Adv-C2 revert holds), pagination/filter/date/sort/permission
  helpers all traced correct.

### Catalogued (Low, fail-safe input-bounding — same class as G48/create-drift)
- **DB-BOUND-1** - SSH-credential `username` is unbounded at the route
  (`node-ssh-credential-routes.ts:87`) vs `varchar(64)` -> a 65+ char username
  (node:manage-gated, self-inflicted) errors as 503 instead of 400. No
  corruption. Fix = `.max(64)` on the route input schema (input-only, safe).
- **DB-BOUND-2** - access-policy/grant `resourceType`/`resourceId`/`subjectId`
  unbounded (`index.ts:89-102`) vs `varchar(80)`/`varchar(160)` -> over-length
  (admin-only) INSERT error. Fix = input-only bounds; must NOT bound the base
  schema if it read-parses stored rows (Adv-C2 hazard).
- Judgment: fail-safe (error, no data loss/corruption), privileged self-inflicted,
  auditor verdict "genuinely sound." Catalogued like the input-bounding-drift
  class; not counted as streak-resetting. (Flagged to the user — fixable input-only
  if they want them elevated.)

Gates green (unchanged from Run 18; catalogue-only, no code change). **Clean-run
streak: 2/5.**

## Run 18 — CLEAN (convergence check: broad sweep + cache/upload/retention floor-family re-verify)

**No new confirmed actionable findings.** Both hunters converged:
- Floor-family re-verify: the three cache-release paths + whole/chunk symmetry +
  floor-set/reconcile/checksum ordering + chunked-partial handling all COHERENT.
  Two non-issues: dangling raw/enhanced columns after release (verified INERT —
  reads gated on `recordingHasCachedFile`->`cachePath`) and an unreachable
  `cancelled` upload status (dead state). No action.
- Broad sweep (OIDC/auth, inventory-reconcile, channel-map, shared Zod contracts,
  16 Rust files, live-listen/metrics/audit/CSV, concurrency hot paths): all SOUND
  or resolve to catalogued items (G24-1 metrics counter; the 3 blind-save status
  writers = the accepted G54/G55 sub-tick residual, no harmful trigger). Three
  "array corruption" flags were false positives (JS `arr[-1]` misconception).
  Verified all six CSV exporters route through `csvCell` (G3 fully applied).

Gates green (API 407/0, web 121/0, tsc, lint, fmt, LOC, baselines). Synced to
main (origin/main unchanged). **Clean-run streak: 1/5** (strict streak starts at
Run 18; Run 17 surfaced RS1). "Clean" = the audit found nothing NEW, not that
zero known issues remain — RS1 (High) is still a tracked open item.

### Still open (tracked)
- **Capture-recovery segment lifecycle (RS1 + GH-1 High, GH-2 Low)** - one Rust
  slice: recovered segments are handled only on the stitch-success path, so a
  restart-before-stitch (RS1) OR a graceful stitch-failure (GH-1) silently
  truncates audio + leaks files, and restart-recovery drops the enhanced rendition
  (GH-2). Needs the Linux recorder rig to fix+verify. **Top open item.**
- **Recording-status CAS** (systemic) - RESOLVED: all writers (stop=G65,
  metadata=R13-2, health-sync=R13-8) now use the `transition` CAS; G54/G55/G63/G64
  keep their re-read stopgaps as safe backstops (optional CAS upgrade, not a bug).
- **G62 / G59-residual / Rust-C2** (Rust) - decoupled chunked-finalize signal;
  needs Linux integration testing. **G61** - per-job agent state files (config-gated).
