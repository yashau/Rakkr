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
G19, G21, G24, G25, G27, G28, G31, G32, G34, G36, G37, G40, G43, G45, G46 (29 confirmed findings, G43 controller-side); G26 mostly-fixed via G25.
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

## CRITICAL

### G1 — Partial upload deletes the shared cache, stranding a retryable destination · `FIXED`
`apps/api/src/upload-runner.ts:291` (`reconcileRecordingUpload`).
When one destination succeeds under a `deleteCacheAfterUpload` policy and another
fails, the recording goes `partial` but `resolveCacheDeletion` still deletes the shared
cache file — the only source for the failed destination's retry, which then fails with
`cache_path_missing` forever. A comment at `:310` even claims this is safe. Data loss in
normal multi-destination operation.
**Fix:** gate cache release on `failed.length === 0`. **Test:** `upload-runner.test.ts` →
"keeps cache for partial uploads even when a succeeded policy deletes cache".

### G1b — Chunked uploads delete a chunk's cache on partial success (same bug, in code merged today) · `FIXED`
`apps/api/src/upload-runner.ts:369` (`reconcileChunkedRecordingUpload`).
Found during rebase: PR #14 ("configurable time-based chunked recording", merged to
`main` after this audit began) added a per-chunk reconciliation path that deletes a
chunk's cached object whenever `settled && succeeded.length > 0` — ignoring
`failed.length`. A `partial` chunk (one destination failed, still retryable) loses its
only source, identical to G1 but at the chunk level. The chunked reconciliation path had
**zero test coverage**, which is how it shipped.
**Fix:** gate on `settled && failed.length === 0 && succeeded.length > 0`. **Test:**
`upload-runner.test.ts` → "keeps a chunk's cache when one destination fails (chunked
recordings)" — verified red (ENOENT/data loss) against #14's gate, green after the fix.

### G2 — Raw master permanently lost despite `keepRaw` when the supplementary raw upload fails · `FIXED`
**Fixed:** `upload_recording_renditions` no longer swallows a required raw-upload failure —
it returns `Err`, which routes every caller down its existing safe path: the whole-recording
job stays `upload_pending` (retention skipped, local raw preserved, retried), a capture-group
secondary is not marked completed, and a chunk is preserved + retried (its `Ok`-only cache
delete is skipped). The decision is extracted into a pure `resolve_rendition_upload(primary,
raw_outcome)` so it is unit-tested without ffmpeg/HTTP. **Test:**
`recording_job_upload::tests` (required-raw failure ⇒ Err; succeeded/not-attempted keep the
primary Ok; primary failure dominates). Original analysis:
`crates/recorder-agent/src/recording_job_upload.rs:264-292`, `controller.rs:615-624`,
`recording_job_recovery.rs:484-532`, `recorder_cache_retention.rs:90-111`.
With enhancement on, `keepRaw=true` (default), and recorder-cache retention
`deleteAfterUpload=true`: the enhanced (primary) upload succeeds and the raw
(supplementary) upload fails → the failure is only logged as a warning and the primary
`Ok` is returned. The caller then marks `uploaded`, runs retention (deletes the local
raw), and completes the job. The raw never reached the controller and the local copy is
gone — only the DNN-denoised rendition survives, violating "raw is ALWAYS preserved".
**Re-verified against current `main` (post-#14):** still present — `recording_job_upload.rs:296-308`
swallows the raw-upload `Err` as a warning and returns the primary's `Ok`. (#14's chunked
path inherits the same shape per chunk.)
**Fix (refined — DON'T just propagate the error):** naively returning `Err` would block the
job from ever completing on a non-transient raw-upload failure, which contradicts the
design ("enhanced is the primary that completes the job; raw is supplementary"). The
surgical fix: surface whether the raw was secured (uploaded, or not required) from
`upload_recording_renditions`, and have the retention step **skip deleting the local raw**
(`apply_recorder_cache_retention` / `delete_recorder_cache_files`) whenever `keepRaw` is set
and the raw upload did not succeed — the local copy is then the preservation of record and
can be re-uploaded later. This keeps the invariant without stalling completion.
**Why left CATALOGUED:** correct fix changes the rendition-upload return contract + caller
retention logic, and a unit test needs the `upload_cache_file`/`render_enhanced_output`
seam made injectable (today they're free functions hitting HTTP + ffmpeg). That's its own
reviewed slice — happy to implement on request. This is the highest-severity item still open.

### G3 — CSV formula injection in all six exporters · `FIXED`
`recording-listing.ts`, `recording-job-export.ts`, `schedule-export.ts`,
`audit-routes.ts`, `health-routes.ts`, `node-inventory-export.ts`.
Cell encoders handle RFC-4180 quoting but none neutralise spreadsheet formula triggers
(`= + - @ \t \r`). A low-privilege user who can name a recording/schedule `=HYPERLINK(...)`
or `@SUM(...)*cmd` plants a payload that executes when a higher-privileged operator
exports and opens the CSV (exfiltration / DDE). Three exporters quote-wrap only
conditionally, so a bare `=…` is written unquoted.
**Fix:** shared `csvCell()` that prefixes `'` to formula-leading values and always
quote-wraps; all six exporters routed through it. **Test:** regression that a recording
named `=1+1` is neutralised.

---

## HIGH

### G4 — Permanent silent failover to a divergent in-memory store on any transient DB error · `FIXED (503)`
**Fixed:** added `DatabaseUnavailableError` + an `app.onError` boundary in `index.ts` that maps
it to **503**. The 9 DB-authoritative operator-data/config stores — recordings, recording-jobs,
recording-chunks, schedules, settings, controller-settings, upload-destinations (encrypted
secrets), upload-policies, upload-queue — now **throw** it on a DB error (their `failover()`
throws instead of latching `dbAvailable=false` and serving the boot-time fallback). So a caller
gets a 503 and retries against the real DB rather than writing to a throwaway store.
**Intentionally left resilient (not converted):** `audit-store`, `health-store`, `meter-store`
(in-memory is a *legitimate* primary — they must not 503 every audited action); `node-store`
(already refuses writes with `NodeStoreError` when the DB is down and only *reads* fall back to
seed nodes — not silent write loss); `auth-service`/`oidc-login` (login critical path with an
env-based local admin — a scoped follow-up so a DB blip can't lock out local admin).
**Tests:** `database-unavailable.test.ts` (boundary: DB error → 503, other → 500; deterministic)
+ gated `database-failover-integration.test.ts` (unreachable Postgres → store throws
`DatabaseUnavailableError`; `RAKKR_API_TEST_DB_FAILOVER=1`, `--test-force-exit`). Full suite
(DATABASE_URL unset) unaffected — the Postgres wrappers aren't instantiated in dev/test.
Original analysis:
One transient Postgres error latches `dbAvailable=false` for the whole process lifetime
(one `console.warn`, no metric/health signal). Every subsequent read/write silently
serves the boot-time JSON fallback; routes still return 200. Operator writes land only in
`data/*.json` and vanish on the next restart when Postgres reconnects. Spans recordings,
jobs, settings, encrypted secrets.
**Decision:** fail the request (**503**) so the caller retries against the real DB, rather
than silently diverging.
**Why deferred (not landed):** this is genuinely large and higher-risk than the other fixes,
and I would not rush it at the tail of this pass:
- **No API error boundary exists** — `index.ts` has no `app.onError`; a thrown DB error would
  currently surface as a 500 (or crash a runner), so a `DatabaseUnavailableError` + a Hono
  `onError`/middleware mapping to 503 must be added first.
- **14 stores, heterogeneous failover** — some use a `failover()` helper + `this.fallback.x()`,
  others latch `dbAvailable=false` inline in every `catch`.
- **Some stores use the in-memory store as a *legitimate* primary** (e.g. `audit-store`,
  `health-store`, `meter-store` are designed to run without a DB) — those must **not** throw,
  or normal operation breaks. So this needs per-store classification (DB-authoritative →
  throw/503; in-memory-primary → keep), not a blanket change.
Recommend implementing as its own reviewed slice: add the error boundary, convert the
DB-authoritative stores to propagate `DatabaseUnavailableError`, leave the in-memory-primary
stores as-is, and add a metric/health signal + a test that a DB error yields 503 (and that
dev-without-`DATABASE_URL` is unaffected).

### G5 — Non-atomic recording-job claim (read-modify-write) → double-claim / double-capture · `FIXED`
**Fixed:** added an atomic `claim(job, expectedStatus)` to the job store — a conditional
`UPDATE … WHERE id=$ AND status='queued' RETURNING` on Postgres and a no-`await`
check-and-set in the JSON store — and routed `claimRecordingJob` through it.
**Test (Postgres, opt-in via `RAKKR_API_TEST_DATABASE_URL`):**
`recording-job-claim-atomic.test.ts` fires 16 concurrent claims and asserts exactly one
wins. Verified **red on the old `save` path: 14 of 16 "won"**; green after the fix. Skips
cleanly (no pool) in the default fallback-store suite. Original analysis:
`apps/api/src/recording-jobs.ts:129-147` (`claimRecordingJob`), backed by the
unconditional upsert at `:557-573`. *(Found independently by two hunters.)*
The claim reads the job, checks `status === "queued"` in app memory, then `save()`s an
`INSERT … ON CONFLICT DO UPDATE SET status='running'` with **no** `WHERE status='queued'`
guard. Two concurrent agent polls can both observe `queued` and both win — the same job
(or capture group) claimed twice, defeating capture-once/split-many.
**Fix:** make the claim atomic — a single conditional `UPDATE … SET status='running',
claimed_by=$1, lease_expires_at=$2 WHERE id=$3 AND status='queued' RETURNING *`, treating
zero rows as "already claimed" (the bootstrap-token `consume` at `node-bootstrap-store.ts`
is the in-repo model). The JSON store re-checks status inside the same call.
**Why left CATALOGUED:** the race only manifests with real concurrent DB round-trips; the
in-memory test store serialises the read-modify-write within one tick, so a faithful
**failing** test needs `RAKKR_API_TEST_DATABASE_URL` (Postgres). Shipping the store
refactor without a red→green proof would violate this audit's own discipline — flagged for
a DB-backed slice. (`33f50ae5` "Make claim-next-group test deterministic" already hints at
known nondeterminism here.)

### G6 — Crypto fails open: dev key silently used when `RAKKR_SECRET_KEY` unset in prod · `FIXED`
`apps/api/src/secret-box.ts:9-34`, `node-ssh-credential-crypto.ts:32-51`.
AES-256-GCM construction is correct (random IV, verified tag). But if the key env is
unset/empty the code derives from a hard-coded repo constant
(`"rakkr-dev-insecure-secret-key-change-me"`) and only warns. A prod deploy that forgot
the env var encrypts every SMB/S3 secret with a publicly known key. No key-length check
either (`RAKKR_SECRET_KEY=x` accepted).
**Fix:** fail closed in production (missing/short key throws on startup); mirror to the
SSH master key. **Test:** production + missing/short key throws; dev still falls back.

### G7 — Watchdog reads stale meter frames as if live → silent low-signal blindness · `FIXED`
`apps/api/src/api-runners.ts:95-109`, `meter-store.ts:26-28`, `watchdog-runner.ts:153`.
`latest()` returns the last frame regardless of age; the runner never checks
`capturedAt`/`receivedAt`. If a node's meter stream dies on a healthy frame, the watchdog
re-samples that good frame every tick and the node looks perpetually healthy — the exact
"bad recording in progress" case the watchdog exists to catch. Node-liveness doesn't
cover it (separate heartbeat channel).
**Fix:** treat a frame older than a freshness bound as missing; `signalSample` already
fail-closes (`flatline`) on a missing frame. **Test:** a stale good frame eventually
raises low-signal.

### G8 — `localDateTimeInput` drifts −1h across the fall-back DST hour, corrupting edited schedules · `CATALOGUED`
`apps/web/src/lib/dates.ts:65-74`, consumed by `schedule-draft.ts`.
Classic `getTimezoneOffset()` round-trip anti-pattern: offset sampled at the source
instant, re-parsed at the displayed wall-clock time. In the repeated 01:00–01:59 fall-back
band the offsets differ by 60 min, so opening an existing schedule with a start in that
hour and saving walks the stored start back an hour. (Server-side `localDateTimeToUtc` is
correct — only the web form helper is wrong.)
**Fix:** build the display string via `Intl.DateTimeFormat(...).formatToParts` (as
`dates.ts:1-12` already does elsewhere). CATALOGUED — web (vitest) test harness + TZ
control; landing here after the API-side fixes.

### G9 — `keepRaw=false` + enhancement silently drops the raw master vs the "always preserved" invariant · `CATALOGUED`
`crates/recorder-agent/src/recording_job_upload.rs:240-293`.
With `keepRaw=false`, the raw is never uploaded; with retention `deleteAfterUpload=true`
the local raw is then deleted — only the denoised rendition survives. This may be
"working as configured", but it directly contradicts the absolute "raw is always
preserved" language in AGENTS.md and the audio-enhancement guide.
**Fix (product decision):** either forbid `keepRaw=false` when it would leave no surviving
raw, or remove the absolute "always preserved" claim. CATALOGUED — needs your call, not a
silent code change.

---

## MEDIUM

### G10 — Retention deletes cache for `partial`/never-uploaded recordings when `deleteOnlyAfterUploaded=false` · `FIXED`
`apps/api/src/retention-runner.ts:177`.
The only upload-state gate is `if (deleteOnlyAfterUploaded && status !== "uploaded")`.
With the flag off (a supported value), the runner deletes the controller cache regardless
of upload state — including `partial` (failed-but-retryable destinations) and `cached`
(never uploaded). Same permanent `cache_path_missing` as G1, via the time/size path.
**Fix:** add an unconditional floor — never delete while a recording is `partial` or has a
non-terminal/failed-retryable queue item, independent of the flag. **Test:** a `partial`
recording past its age limit is retained with the flag off.

### G11 — Agent meter-health events flap on a single transient frame · `FIXED`
`crates/recorder-agent/src/meter_health.rs`. Was edge-triggered on plain booleans with no
debounce — one noisy frame emitted a warning+recovery pair, polluting the JSONL evidence
stream. **Fix:** a debounced `MeterHealthState` (per-condition `MeterConditionState`) where a
condition must persist for `METER_HEALTH_MIN_CONSECUTIVE_FRAMES` (3) before its warning
fires and clear for the same before recovery; a single transient frame no longer flaps.
Threaded through the meter loop in `main.rs`. **Test:** `meter_health::tests` (single frame
doesn't flap; sustained raises/recovers once; interrupted streak resets) + the updated
`meter_health_logs_low_signal_and_recovery` integration test.

### G12 — `auth/groups` & `auth/users` bypass pagination clamping · `FIXED`
`apps/api/src/auth-management-routes.ts:94,121`. These privileged routes read `limit`/
`offset` via `numberFromQuery` (no bounds) and skipped `parsePagination(PAGE_POLICY)`. An
omitted `limit` returned the **entire** table (`paginate` returns all rows when limit is
undefined); `limit=0` produced a garbled empty page.
**Fix:** route both through `parsePagination(…, PAGE_POLICY.default)` like every other list
route. **Test:** `auth-management-routes.test.ts` → "clamp pagination to the page policy"
(omitted→50, 99999→200, 0→1).

### G13 — Unbounded response when `limit` omitted on `paginate()`-direct routes · `FIXED`
`recording-upload-queue-routes.ts` omitting `limit` returned every scoped row (`paginate`
returns all rows when limit is undefined). **Fix:** route through
`parsePagination(query.data, PAGE_POLICY.default)`. **Test:**
`recording-upload-queue-routes.test.ts` → "bounds the page size when no limit is given"
(meta.limit defaults to 50).

### G14 — Multi-user IDOR / grant isolation is effectively untested · `CATALOGUED (coverage)`
`apps/api/src/index.ts:236-280` (`resourceScopeDecision`/`allowedByGrant`).
All access-control tests run as the single owner with `everyone`-deny policies; the
positive path (user A's grant must not leak user B's resource) and `subjectType:"user"`/
`"group"` matching are unverified (harness has one user, `DATABASE_URL=""`). Authz logic
was read and looks correct — this is a missing characterisation test, not a known bug.
**Fix:** two-user grant-isolation tests (detail/action/list 404 + list exclusion).

### G15 — Date/time verifier is string-presence only; no DST behavioural test · `CATALOGUED (coverage)`
`scripts/verify-date-time-baseline.mjs`; `schedule-engine.test.ts` uses `timezone:"UTC"`
throughout, so the offset/DST code never runs under test. The gate stays green even if
`localDateTimeToUtc` were replaced by naive `+24h`. **Fix:** NY recurrence across both DST
transitions + a fall-back-instant round-trip identity test (would currently fail per G8).

### G16 — `render_enhanced_output` / `upload_recording_renditions` have zero tests · `CATALOGUED (coverage)`
`crates/recorder-agent/src/enhanced_render.rs` (no `#[cfg(test)]`), `recording_job_upload.rs`.
The entire two-rendition upload + `keepRaw` gating + raw-failure handling (the G2 path),
denoise-failure fallback, ffmpeg pass failures, and temp-file cleanup on error are
unverified. Engine tests in `enhance.rs` are Miri-excluded and only check
length/energy.

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

## Run 3 findings (web console + Rust agent internals)

The web operator console was **healthy**: RBAC UI boundaries all gated through tested
helpers (no control leaks), no XSS sinks, dates correctly browser-local. One resilience bug
(G34, fixed). Rust internals surfaced two confirmed bugs (G31/G32, fixed) + one narrow edge.

### G31 — Day-0 bootstrap leaves the SSH private key on disk on most error paths · `FIXED`
`crates/recorder-agent/src/bootstrap.rs`. `run_bootstrap` only wiped the generated key on 2 of
5 exit paths (success + non-2xx); an install / transport / decode / env-write failure returned
via `?` leaving a live private key at a predictable temp path. **Fix:** RAII — `Drop for
GeneratedKey` wipes on every path; plus cleanup if the key reads fail before the guard exists.
**Test:** dropping `GeneratedKey` wipes the key file. **Severity: High (credential-at-rest).**

### G32 — Enhanced-render intermediates leak on every error path · `FIXED`
`crates/recorder-agent/src/enhanced_render.rs`. The `.enh-mono.wav`/`.enh-denoised.wav`
intermediates were removed only on success; a failed denoise/Pass B left them, and on a chunked
recording that is two leaked WAVs per chunk while the job still reports success. **Fix:** RAII
`IntermediateCleanup` guard sweeps on every exit path. **Test:** guard removes files on drop.

### G33 — Zero-audio chunked recording never signals completion to the controller · `CATALOGUED (SUSPECTED)`
`crates/recorder-agent/src/recording_job_chunked.rs:313-430`. Chunked completion is signalled
only by `chunkTotal` on the final chunk's upload. If `capture.finish()` returns an empty
`trailing` (device produced zero PCM on a very short window), no upload — and no `chunkTotal` —
is ever sent, yet local state is written `completed`; the controller job can dangle open.
**Fix:** if `finish()` yields no chunks and `uploaded_chunks == 0`, route to
`finish_partial_after_failure` / `mark_recording_job_failed` with a "no audio captured" reason.
Narrow edge; left catalogued.

### G34 — Web: any `/auth/me` error forces re-login and leaves a stale token · `FIXED`
`apps/web/src/main.tsx`, `lib/api.ts`, new `lib/api-error.ts` + `lib/auth-gate.ts`. Every non-2xx
was an untyped Error and the query treated any error as unauthenticated, so a transient 5xx/
network blip bounced a valid operator to login and a real 401 left a dead token in localStorage.
**Fix:** typed `ApiError` (carries status) + pure `authGateState` — 401/403 → clear token + login;
5xx/network → keep session, show a retry screen. **Test:** `auth-gate.test.ts`. **Severity: Low-Med.**

### G35 — Web: no dedicated 503 `database_unavailable` UX · `CATALOGUED (coverage)`
`apps/web/src/lib/api.ts`. Mutations surface a generic "failed" toast; a 503 during a DB outage
is indistinguishable from a validation/permission failure. Not a correctness bug (writes throw,
not swallowed). **Fix:** parse status in the fetch helpers and show a distinct "temporarily
unavailable, retry" message for 503.


---

## Run 4 findings (infra/deploy + broad residual re-sweep)

**Convergence signal:** the broad residual re-sweep of the core controller/agent/web (fresh
angles: audit/RBAC invariants, runner concurrency/ordering, numeric/boundary, Zod gaps, Rust
panics) found **no new confirmed correctness or security bug** — the areas checked
(pagination meta, upload-runner reentrancy, retention/chunk ordering, watchdog auto-resolve,
scheduler DST/boundary math, metrics escaping, OIDC PKCE, CSV neutralization, agent scope
checks, Rust hot paths) are all solid. The one dirty item this run was in **infra**.

### G36 — Ansible runner `/runs` had no authentication · `FIXED`
`deploy/ansible/runner.py`. The controller sent `RAKKR_ANSIBLE_RUNNER_TOKEN` as a Bearer header
but the runner never validated it, so anything reaching port 8790 could run lifecycle actions
(arbitrary agent-binary deploy / systemd changes over SSH) and exfiltrate controller tokens —
bypassing controller RBAC/scoping/audit. **Fix:** validate the shared token (constant-time)
on `/runs`; unset = unauthenticated dev mode with a loud startup warning. **Test:**
`runner_test.py` (7 auth checks). **Severity: High.**

### G37 — SMB upload path traversal via `pathOverride`/destination path · `FIXED`
`apps/api/src/upload-smb.ts`. `smbPathSegments` only trimmed slashes, so a `../../x` path kept
its `..` segments and escaped the configured share/path on the SMB server. **Fix:** drop
`.`/`..` segments (and guard the filename). **Test:** `upload-smb-path.test.ts`. Defense-in-depth
(settings:manage-gated, operator-against-own-target).

### G38 — Migration verifier only replays; never checks schema↔migration drift · `CATALOGUED (coverage)`
`packages/db/scripts/verify-migrations.mjs`. `db:verify` replays migrations but never diffs them
against `schema.ts`, so a forgotten `db:generate` (schema changed, migration missing) passes the
gate. No live drift today. **Fix:** add a `drizzle-kit check` (or generate-is-noop) step to the
gate. Left catalogued — the exact drizzle-kit drift command is version-specific and shouldn't be
wired into the gate without validating it won't false-positive.

### G39 — Secrets passed as process arguments (runner extra-vars, agent.sh bootstrap token) · `CATALOGUED (SUSPECTED, low)`
`deploy/ansible/runner.py` (`-e` extra-vars incl. controller/github tokens) and
`deploy/bootstrap/agent.sh` (`--bootstrap-token` on argv) expose secrets via `ps`/`/proc/<pid>/cmdline`
to a local user during a run; no `no_log:` in the ansible tree. Low severity (dedicated runner
container, single-use short-lived bootstrap token, rotating controller tokens). **Fix:** pass
secret extra-vars via `--extra-vars @file` (0600) / env / stdin; add `no_log: true` on
key/token tasks.


---

## Run 5 findings (adversary on newest fixes + 2nd broad re-sweep)

The adversary re-verified the five newest fixes (G31/G32/G34/G36/G37) — **no regressions**
(ran the runner auth test 7/7, an SMB-traversal harness, Python auth semantics; confirmed no
web refetch loop, no bootstrap double-wipe, guard removes only intermediates). The 2nd broad
core re-sweep confirmed convergence except one contained finding.

### G40 — Upload-queue retry route missing server-side status guard · `FIXED`
`apps/api/src/recording-upload-queue-routes.ts`. `POST /upload-queue/:id/retry` checked only
existence + visibility; the `retryableUploadQueueStatuses` set was enforced only in the UI
action-state layer. A `recording:control` operator could POST retry on a `succeeded` item →
`retryUploadQueueItem` reset it → the re-attempt read the released cache → `cache_path_missing`
→ the recording was demoted `uploaded`→`partial` with a spurious failure event. The sibling
`retryRecordingJob` already guards server-side — this was an inconsistency and a
"UI visibility ≠ API enforcement" violation. **Fix:** reject non-retryable statuses with 409
server-side. **Test:** retry on a `succeeded` item → 409, item stays `succeeded`. (Amplified by
G24's unconditional reset; both now correct.)

### G41 — `always_on` schedules never re-arm after the job terminates · `CATALOGUED (SUSPECTED, likely by-design)`
`schedule-engine.ts:208-210,244-246`. `always_on` sets `nextRunAt = undefined` after the first
run and nothing re-arms it when the continuous recording's job ends; also its channel-conflict
claim window is only `RAKKR_AGENT_CAPTURE_SECONDS` wide. Consistent with "one long continuous
recording" intent — flagged only in case `always_on` is meant to auto-restart on job end.

### G42 — Recording read-modify-write `save` is last-write-wins under concurrency · `CATALOGUED (SUSPECTED, low)`
`health-sync.ts:15-31`, `reconcileRecordingUpload`, `markRecordingCachedFromChunks` each do a
full-row read-modify-write `save`; concurrent requests on the same recording could resurrect a
just-cleared `cachePath` or revert `uploaded`→`cached` (Postgres upsert is last-write-wins). The
runner calls these sequentially today, so it's a latent smell, not a demonstrated defect. Fix
would mirror G5's atomic conditional write for recording status/cache fields.


---

## Run 6 findings (deep RBAC/IDOR + state-machine/concurrency)

**Strong convergence signal on security:** the deep authorization pass confirmed the RBAC core
is **sound** — multi-user grant/scope isolation (G14) verified *correct* (not just asserted),
scope-cascade deny-precedence holds, list/detail/action use the same scope fn, mutating routes
re-check the referenced resource (no body-id IDOR), token-auth routes are node-bound/single-use/
timing-safe. Two false-positive "CRITICAL IDOR" flags were traced and rejected. The G40
regression check was also clean. Two real (but slice-worthy) items surfaced:

### G43 — Chunk render failure silently drops a middle chunk → recording stranded in `cached` + audio loss · `FIXED (controller-side)`
**Fixed (stuck-recording resolved):** `reconcileChunkedRecordingUpload` now finalizes a chunked recording once its owning job is terminal (capture done) even when `chunks.length < total`, marking it `partial` on a gap instead of hanging in `cached`. Decision extracted into a pure, unit-tested `chunkedRecordingFinalization` helper (gap+captureDone → partial; gap+running → wait; unsettled → wait). **Residual (agent-side, still open):** the render-failed chunk's audio is lost and later chunks' offsets drift — a deeper agent fix would retain/re-render the dropped chunk rather than `return Ok(())`. Original analysis:
`crates/recorder-agent/src/recording_job_chunked.rs:457-479` + controller finalization
`apps/api/src/upload-runner.ts:385-392`. Unlike the upload path (retry + push to `pending` →
`partial`), the render-failure branch logs a warning and `return Ok(())` — no retry, no pending,
capture continues. That drops the chunk's audio AND leaves an index gap; the final chunk's
`chunkTotal` then overcounts the present rows, so the controller's `chunks.length >= total` gate
never holds and the recording is stuck `cached` forever (offset drift too). Distinct from G26
(`total` never arrives) and G33 (zero-audio). **Fix (dual, needs a careful slice):** agent —
don't silently drop; ensure the job finishes `partial` (signal the loss) rather than clean
`completed`; controller — finalize a chunked recording as `partial` once its owning job is
terminal even if present-chunks < total (resolves the delayed-vs-dropped ambiguity via the
job-terminal signal). Regression risk to the lightly-tested chunked flow → reviewed slice.
Controller-side has a deterministic test path (upsert rows with a gap + total); agent-side needs
the render seam injectable.

### G44 — Bulk/collection routes over-deny scoped non-admin operators (fail-closed) · `CATALOGUED (CONFIRMED, Low)`
`apps/api/src/index.ts:237-281` (`resourceScopeDecision`) + collection routes in
`recording-routes.ts`, `recording-job-routes.ts`, `recording-upload-queue-routes.ts`. The
synthetic `{id:"recording_collection", type:"recording_collection"}` middleware target matches no
cascade/policy/grant, so a scoped **operator** (grants, not owner/admin) gets 403 on
`bulk-delete`/`bulk-metadata`/`bulk-retry`/`bulk-stop`/`bulk-upload-queue` even for their own
in-scope recordings — while the single-item routes work. **Fail-closed (over-denies; no
escalation).** Verified the handlers already filter per-item via `scopedRecordings` (e.g.
`recording-routes.ts:462-471`), so the per-item filter is the real gate. **Fix (security-sensitive
slice):** early-return `allowed:true` from `resourceScopeDecision` for synthetic `*_collection`
target types, delegating to the handlers' per-item filtering — **after** auditing that *every*
collection route filters (recording/job/upload-queue confirmed; schedule/node/channel-map to
verify), plus a test wiring the REAL middleware to a collection route for a scoped operator
(the suite only ever stubs `requirePermission`). Weigh vs the audit-label tradeoff of the
alternative (pass `{type:"controller"}`).


---

## Run 7 findings (adversary on G43 + broad sweep)

The G43 controller finalization change was re-verified **sound** — no premature finalize (gated on
`allSettled`), the `recordingJob` lookup degrades via the runner-tick `.catch` (not a crash), no
regression to the all-present path or the G1b per-chunk gate; full API suite 366/0. The broad
sweep found two narrow trust-boundary input-validation edges (agent-supplied data) — consistent
with a strongly-converged core ("the easy correctness bugs are gone").

### G45 — Orphan chunk upload persists an empty `jobId`, crashing the chunk store on read · `FIXED`
`apps/api/src/agent-cache-uploads.ts`. A chunk cache-file upload with no job header for a recording
with no job row persisted `jobId:""`, violating the read schema (`jobId.min(1)`) → ZodError on the
next chunk-store load (JSON store crash on boot / Postgres reconcile break). Write never validated;
read always did. **Fix:** reject the orphaned upload with 409 before storing. **Test:** jobless
chunk upload → 409, no row persisted. **Severity: Medium.**

### G46 — Unbounded meter `levels` array wedges the watchdog · `FIXED`
`packages/shared/src/index.ts`. An authenticated node could POST a meter frame with a huge `levels`
array; the watchdog's `Math.max(...frame.levels)` spread then threw `RangeError`, and since the
poison frame stayed `latest`, every subsequent watchdog pass for that node re-threw — the
fail-closed signal-loss watchdog silently disabled for that node via one request. **Fix:**
`meterFrameSchema.levels.max(512)` (X32 = 32 channels). **Test:** 512 ok / 513 rejected.
**Severity: Medium.**
