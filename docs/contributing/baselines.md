---
title: Baselines & verification
description: How Rakkr's machine-checked baseline documents and verifier scripts keep documentation honest about the source.
sidebar:
  order: 3
---

# Baselines & verification

Rakkr is built **evidence-first**, and a large part of that discipline is a set of
**baseline documents** that are mechanically checked against the source code. A
baseline isn't prose you can quietly let drift — a script in the test gate asserts
that the claims it makes still match reality.

## What a baseline is

Each baseline pairs:

- a **document** in [`docs/internal/baselines/`](../internal/baselines/) that
  describes a subsystem's contracted behavior, and
- a **verifier** in `scripts/verify-*-baseline.mjs` that fails `mise run check` if
  the document and the code disagree.

A typical verifier asserts three things:

1. the **evidence files exist** (the routes, stores, tests, and agent modules that
   implement the behavior);
2. the baseline **mentions the required phrases** (so the doc can't omit a
   contracted capability); and
3. the **source contains the required identifiers** and the **tests contain the
   required test names** (so the behavior is actually implemented and covered).

Some verifiers also assert _negative_ invariants — e.g. the scheduler baseline
fails if any non-doc source file uses the word "cron" (the scheduler must never
expose cron syntax), and the operations/first-reliable baselines fail if they
claim hardware validation that isn't done.

## The baselines and their checks

| Baseline (in `docs/internal/baselines/`) | Verifier task                              |
| ---------------------------------------- | ------------------------------------------ |
| `AZURE_AD_OIDC_BASELINE.md`              | `mise run auth:check-oidc`                 |
| `RBAC_AUDIT_BASELINE.md`                 | `mise run security:check-rbac`             |
| `TRANSPORT_SECURITY_BASELINE.md`         | `mise run security:check-transport`        |
| `SCHEDULER_BASELINE.md`                  | `mise run scheduler:check`                 |
| `SETTINGS_TEMPLATES_BASELINE.md`         | `mise run settings:check`                  |
| `RECORDING_LIBRARY_BASELINE.md`          | `mise run recordings:check`                |
| `FIRST_RELIABLE_RECORDING_BASELINE.md`   | `mise run recordings:check-first-reliable` |
| `GENERIC_DEVICE_BASELINE.md`             | `mise run devices:check-generic`           |
| `HEALTH_WATCHDOG_BASELINE.md`            | `mise run health:check-watchdog`           |
| `STORAGE_UPLOAD_BASELINE.md`             | `mise run storage:check`                   |
| `SWITCHER_ROUTING_BASELINE.md`           | `mise run switcher:check`                  |
| `NODE_LIFECYCLE_BASELINE.md`             | `mise run nodes:check-lifecycle`           |
| `OPERATIONS_BASELINE.md`                 | `mise run operations:check`                |
| `DATE_TIME_BASELINE.md`                  | `mise run time:check`                      |

The [observability](../observability/README.md) example configs are checked
similarly by `mise run ops:check-*`.

## Working with baselines

- **Changing an invariant?** Update the matching baseline doc _and_ its verifier
  in the same slice as the code and tests. Run the verifier directly while
  iterating, e.g. `node scripts/verify-scheduler-baseline.mjs`.
- **Adding evidence (a new route, test, or module)?** If a verifier requires the
  baseline to reference test files or specific identifiers, add those references.
- **Don't promote status you can't prove.** Baselines must not claim completed
  hardware/real-room validation that hasn't happened — some verifiers actively
  reject such claims.

## Why baselines live under `internal/`

These documents are **assertion targets for the test gate**, not end-user
documentation — which is exactly why the human documentation you're reading was
written separately. They are kept under `docs/internal/baselines/` so the rest of
`docs/` stays readable while the contracts remain versioned alongside the code.
The user-facing guides link to the relevant baseline at the end of each section
(e.g. the [recording guide](../guides/recording.md) references the
`FIRST_RELIABLE_RECORDING_BASELINE`).

The product's overall contract, status ledger, and promotion record is the
separate [source of truth](../RAKKR_SOURCE_OF_TRUTH.md).
