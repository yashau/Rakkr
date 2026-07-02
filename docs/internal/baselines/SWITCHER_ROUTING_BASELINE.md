# Rakkr Audio Matrix Switcher Routing Baseline

Status: MVP baseline checked.

## Overview

Rakkr can drive an external audio matrix switcher so that when a room's
scheduled meeting is live and assigned to a user, the room's audio (a switcher
INPUT) is automatically routed to that user's desk (a switcher OUTPUT). This is
an alternative to listening inside Rakkr directly. Operators optionally assign
switcher inputs to rooms and switcher outputs to users; the controller
reconciles the live schedule against those mappings and applies the routes.

The first supported model is the AVPro Edge AC-MAX (validated against a live
AC-MAX-24, firmware 1.31). The driver layer is modular: a new model is a new
driver plus a catalog entry, nothing else changes.

## Device Protocol (AVPro AC-MAX)

- Control is a raw-TCP line protocol on port 23. The telnet control channel has
  no authentication on the AC-MAX (its username/password guard the web GUI
  only), so stored credentials are optional and unused by that driver; the
  driver interface still supports models whose control channel requires a login.
- Routing command: `SET OUTx AS INy` (x = output 1..24, y = input 0..24, 0 =
  none). Read one route: `GET OUTx AS`. Read all routes: `GET OUT0 AS`. Input
  audio presence: `GET INx SIG STA` (0..3). Full backup: `GET CONFIG`. Errors
  are returned inline as lines prefixed `CMD ERR:`.
- Every `setRoute` is confirmed with a read-back so a silent or partial apply
  surfaces as an error rather than a false success.
- Evidence: `apps/api/src/switchers/avpro-ac-max.ts`,
  `apps/api/src/switchers/transport.ts`, `apps/api/src/switchers/driver.ts`.

## Data Model And Secrets

- A switcher is a device record: `host`, `port`, `model`, `mode`, optional
  `username`, plus model-derived `inputs`/`outputs`. The optional
  control-channel password is encrypted at rest via secret-box (never returned
  to operators or logged); API responses expose only `hasPassword`.
- Mappings are per switcher: one room per input and one input per room; one user
  per output and one output per user. Enforced by composite primary keys plus
  reverse unique indexes.
- Evidence: `packages/db/src/schema.ts`,
  `packages/db/drizzle/0039_same_nicolaos.sql`, `apps/api/src/switcher-store.ts`,
  `apps/api/src/switcher-mapping-store.ts`, `packages/shared/src/switchers.ts`.

## Reconcile Behavior And Safety Invariants

- Mode is per switcher: `disabled` (never connect), `observe` (compute and audit
  the routes it would apply but never send `SET`), or `enforce` (apply routing).
  New switchers default to observe so a switcher never drives hardware until an
  operator promotes it.
- Owned outputs only: the controller writes only outputs mapped to a user. Every
  other crosspoint — including an operator's manual routing — is never written.
- Live meeting only: an output is written only while its user's meeting is live
  (always_on schedules are always live; timed recurrences are live between an
  occurrence's recording start and end; manual schedules are not time-based and
  do not drive routing).
- Leave-as-is when idle: when a mapped user has no live meeting, its output is
  left untouched (it keeps whatever it was last routed to). The reconcile loop
  only ever changes an owned output while that user's meeting is live.
- Conflict handling: if a user is live in more than one mapped room at once, the
  lowest input wins and the clash is recorded as a conflict.
- Reconciliation runs on an interval, reads current device routes, and applies
  only the diffs. A switcher that becomes unreachable opens a single
  `switcher.unreachable` health event on the transition (not one per tick) and
  resolves it on recovery.
- Evidence: `apps/api/src/switcher-routing-runner.ts`,
  `apps/api/src/api-runners.ts`.

## RBAC And Audit

- `switcher:read` gates switcher and mapping reads; `switcher:manage` gates
  device config, test-connection, and snapshot/restore; `switcher:map` gates
  channel-mapping writes. `switcher:read`/`switcher:map` are granted to
  operators so the room's leading staff can run the matrix without device-config
  access.
- Every privileged switcher action is audited: `settings.switchers.create`,
  `settings.switchers.update`, `settings.switchers.delete`,
  `settings.switchers.test`, `settings.switchers.mappings.update`. Service
  reconcile passes are audited by `system:switcher-router` as
  `switchers.reconcile.succeeded` (enforce), `switchers.reconcile.observed`
  (observe), or `switchers.reconcile.failed`.
- Evidence: `apps/api/src/switcher-routes.ts`,
  `apps/api/src/switcher-mapping-routes.ts`, `packages/shared/src/index.ts`.

## Checked By

| Check                    | Command                    |
| ------------------------ | -------------------------- |
| Switcher routing baseline | `mise run switcher:check` |

`mise run check` runs the switcher routing baseline check.
