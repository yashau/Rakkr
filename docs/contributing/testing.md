---
title: Testing
description: How Rakkr is tested — API/web/shared/db suites, the fake-controller smoke, audio fixtures, and Linux hardware smokes.
sidebar:
  order: 2
---

# Testing

Rakkr leans on a broad, mostly hardware-free test suite plus a set of Linux-only
hardware/loopback smokes. Everything is wired into `mise` tasks; the full list is
in the [tasks reference](../reference/tasks.md).

## Unit & integration tests

```powershell
pnpm --filter @rakkr/api test       # controller API
pnpm --filter @rakkr/web test       # web console helpers/components
pnpm --filter @rakkr/shared check   # shared contracts type-check
pnpm --filter @rakkr/db check       # db package type-check
mise run node:test-db               # concurrency/race DB tests (needs Postgres)
```

The API test runner sets `RAKKR_API_NO_LISTEN=1` and, by default, **removes
`DATABASE_URL`** so tests run against the in-memory/JSON fallback stores. This is
why the controller is designed to work without a database — see the
[data model](../architecture/data-model.md).

### Database-backed tests

DB tests come in two flavours, chosen by what they need to exercise:

- **Persistence / round-trip** tests (real SQL semantics: constraints, bigint
  widths, JSONB, transactions, per-column persistence) run against an **in-process
  PGlite** (WASM Postgres) database, so they need **no running server** and are
  part of the default `node:test` suite. A test calls `createPgliteDatabase()`
  from `@rakkr/db`, which spins up a fresh instance, applies the Drizzle
  migrations, and hands back a `pglite://…` url that `createDatabase` (and thus
  every store and `LocalAuthService`) resolves to that instance. Set
  `DATABASE_URL` to the url (or pass it directly), and close the handle in an
  `after`/`finally`.
- **Concurrency / race** tests (row-lock and atomic compare-and-set contention —
  double-claim, last-writer-wins, FK races) need **genuinely concurrent Postgres
  connections**. PGlite is single-connection and serializes transactions, so it
  cannot reproduce them — a race test on PGlite would pass even with the
  production lock removed, giving false confidence. These keep the
  `RAKKR_API_TEST_DATABASE_URL` skip guard and run via `mise run node:test-db`,
  which provisions a throwaway Postgres, migrates it, runs the tagged files
  (listed in `packages/db/scripts/run-db-integration-tests.mjs`), and drops it.
  Set `RAKKR_API_TEST_DATABASE_URL` to point at a reachable Postgres.

Rust tests, Clippy, and Miri run via:

```powershell
mise run rust:check rust:clippy rust:miri
```

Miri checks the agent for undefined behavior; use Miri-compatible patterns where
existing tests rely on it (the SQLite health store, for example, is unavailable
under Miri).

## The fake-controller smoke

The most important hardware-free integration test is the **fake-controller
smoke** (`scripts/agent-fake-controller-smoke*.mjs`), part of `mise run check`:

```powershell
mise run agent:fake-controller-smoke
```

It drives the real recorder agent against a stub controller and exercises the full
job lifecycle — claim-next, heartbeat/status polling, capture start/runtime/
too-small failures, channel-map application, controller-terminal handoff, rendered
MP3/VBR output, recorder-cache retention and delete-after-upload, idle sweeps,
upload-failure handling, controller stop requests, and the various failure/recovery
health events — **without any audio hardware**.

## Audio fixtures

A checked golden fixture, `fixtures/audio/rakkr-golden-dialogue-clean.wav`, is a
clean 48 kHz stereo multi-speaker speech file. The loopback smokes replay it
through ALSA loopback and derive deterministic **fault lanes** (clipping, low
volume, duplicated-channel correlation, noisy speech) to validate the agent's
quality scoring and health-event behavior. See
[`fixtures/audio/README.md`](../../fixtures/audio/README.md).

## Linux hardware & loopback smokes

These require the matching Linux device or `snd-aloop` setup and are **not
portable Windows gates** — run them only where the hardware/loopback exists:

```powershell
mise run agent:loopback-smoke
mise run agent:loopback-meter-smoke
mise run agent:loopback-render-smoke
mise run agent:loopback-fixture-smoke
mise run agent:loopback-job-smoke
mise run agent:alsa-capture-smoke
mise run agent:alsa-meter-smoke
mise run agent:alsa-job-smoke
```

Node-lifecycle smokes (via the Ansible runner) need the Compose test rig or a
physical target:

```powershell
docker compose up -d --build ansible-runner recorder-test-rig
mise run ansible:runner-smoke
mise run ansible:x32-smoke      # physical X32 rig; see Node lifecycle guide
```

## Baseline verifiers

A large class of "tests" are the **baseline verifiers** — scripts that assert the
documented invariants still match the source. They run as part of `mise run check`
and are explained in [Baselines & verification](baselines.md).

## What to run when

| You changed…                                    | Run at least                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Controller API routes/stores                    | `node:check`, `node:test`, the relevant baseline verifier               |
| Web console                                     | `node:test`, `node:lint`, `node:format-check`                           |
| Shared contracts                                | `pnpm --filter @rakkr/shared check`, then dependents                    |
| DB schema                                       | `db:generate`, `db:verify`                                              |
| Recorder agent (sync/jobs/health/cache/capture) | `rust:check`, `rust:clippy`, `rust:miri`, `agent:fake-controller-smoke` |
| An invariant with a baseline                    | the matching `*:check` verifier + its baseline doc                      |

When you can't run the full gate, state exactly what you ran and why the rest was
skipped (especially hardware-only smokes).
