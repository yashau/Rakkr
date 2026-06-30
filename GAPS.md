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

### G2 — Raw master permanently lost despite `keepRaw` when the supplementary raw upload fails · `CATALOGUED`
`crates/recorder-agent/src/recording_job_upload.rs:264-292`, `controller.rs:615-624`,
`recording_job_recovery.rs:484-532`, `recorder_cache_retention.rs:90-111`.
With enhancement on, `keepRaw=true` (default), and recorder-cache retention
`deleteAfterUpload=true`: the enhanced (primary) upload succeeds and the raw
(supplementary) upload fails → the failure is only logged as a warning and the primary
`Ok` is returned. The caller then marks `uploaded`, runs retention (deletes the local
raw), and completes the job. The raw never reached the controller and the local copy is
gone — only the DNN-denoised rendition survives, violating "raw is ALWAYS preserved".
**Fix:** when `keepRaw` is set and retention will delete the local copy, propagate the
raw-upload error so `upload_result` is `Err` (job stays `upload_pending`, retention is
skipped, raw is retained for retry).

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

### G4 — Permanent silent failover to a divergent in-memory store on any transient DB error · `CATALOGUED`
`recording-store.ts:180-197`, `recording-jobs.ts:540-549`, `upload-destinations.ts:335`,
`settings-store.ts:720`, and sibling Postgres wrappers.
One transient Postgres error latches `dbAvailable=false` for the whole process lifetime
(one `console.warn`, no metric/health signal). Every subsequent read/write silently
serves the boot-time JSON fallback; routes still return 200. Operator writes land only in
`data/*.json` and vanish on the next restart when Postgres reconnects. Spans recordings,
jobs, settings, encrypted secrets.
**Fix (needs your call — broad blast radius):** don't latch permanently — fail the
request (503) so the caller retries, or make `dbAvailable` a re-probing circuit breaker;
surface the degraded state via `/metrics` + a health event. Left CATALOGUED because the
right semantics is an architectural decision, not a one-line fix.

### G5 — Non-atomic recording-job claim (read-modify-write) → double-claim / double-capture · `FIXED`
`apps/api/src/recording-jobs.ts:129-147` (`claimRecordingJob`), backed by the
unconditional upsert at `:557-573`. *(Found independently by two hunters.)*
The claim reads the job, checks `status === "queued"` in app memory, then `save()`s an
`INSERT … ON CONFLICT DO UPDATE SET status='running'` with **no** `WHERE status='queued'`
guard. Two concurrent agent polls can both observe `queued` and both win — the same job
(or capture group) claimed twice, defeating capture-once/split-many. Tests never catch it
because the in-memory store does the read-modify-write synchronously within one tick.
**Fix:** make the claim atomic — conditional compare-and-set on `status==='queued'`,
treat "not claimable" as zero rows. (The bootstrap-token `consume` already does this.)
**Test:** interleaved double-claim returns exactly one winner.

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

### G11 — Agent meter-health events flap on a single transient frame · `CATALOGUED`
`crates/recorder-agent/src/meter_health.rs:68-255`. Edge-triggered on plain booleans with
no debounce/grace — one noisy frame emits a warning+recovery pair, polluting the JSONL
evidence stream the baseline promotes as deterministic. (Controller watchdog has the
sustained math; agent evidence does not.) **Fix:** require N consecutive frames / small
cumulative duration with hysteresis.

### G12 — `auth/groups` & `auth/users` bypass pagination clamping · `FIXED`
`apps/api/src/auth-management-routes.ts:94-97,121-124`. These privileged routes read
`limit`/`offset` via `numberFromQuery` (no bounds) and skip `parsePagination(PAGE_POLICY)`.
`limit=0`/negative → garbled page; NaN/blank → entire table. Every other list route 400s
on `limit=0`. **Fix:** route both through `paginationQueryFields` + `parsePagination`.

### G13 — Unbounded response when `limit` omitted on `paginate()`-direct routes · `CATALOGUED`
`apps/api/src/pagination.ts:86-100` reached by `recording-upload-queue-routes.ts:95-98`
and the recordings listing path: omitting `limit` returns every scoped row (no default
ceiling). **Fix:** apply `parsePagination(PAGE_POLICY.default)` so an absent limit is
bounded.

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
- **G19 (SUSPECTED)** `packages/shared/src/index.ts:11` — `isoDateTimeSchema` is
  `z.string().min(1)`; a non-date `once.startsAt` passes Zod then throws `RangeError` at
  `schedule-engine.ts:261` (500 instead of 400). Tighten with a `Date.parse` refine.
- **G20 (SUSPECTED)** module-load `JSON.parse` without try/catch in ~11 stores
  (`recording-jobs.ts:624`, `settings-store.ts:732…`, etc.) — a corrupt `data/*.json` fails
  boot. `upload-destinations.ts` already degrades gracefully; mirror it.
- **G21 (SUSPECTED)** `password.ts:30-41` — `verifyPassword` doesn't validate the numeric
  scrypt params; a malformed stored hash throws instead of returning false.
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
