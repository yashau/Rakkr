---
title: Development
description: Workspace setup, the repository layout, gates, and code conventions for contributing to Rakkr.
sidebar:
  order: 1
---

# Development

This is the practical guide to working in the Rakkr repository. The
machine-readable version for AI coding agents lives in
[`AGENTS.md`](../../AGENTS.md); the authoritative roadmap and status ledger is the
[source of truth](../RAKKR_SOURCE_OF_TRUTH.md).

## Workspace setup

Rakkr uses [`mise`](https://mise.jdx.dev/) for toolchains and tasks. From the repo
root:

```powershell
mise trust
mise run setup          # install pinned toolchains, then pnpm dependencies
Copy-Item .env.example .env
```

Pinned tools come from [`.mise.toml`](../../.mise.toml) — do not hand-edit
lockfiles or tool versions unless a task requires it. Run the stack with
`mise run services:up` + `mise run dev` (see [Quick start](../getting-started/quick-start.md)).

## Repository layout

```text
apps/api/                 Hono controller API and API tests
apps/web/                 React/Vite operator console and UI tests
packages/shared/          Shared TypeScript schemas / contracts
packages/db/              Drizzle schema, migrations, migration verifier
crates/recorder-agent/    Rust recorder node agent
deploy/                   Ansible runner, nginx, Helm chart
docs/                     This documentation (+ internal baselines)
fixtures/audio/           Golden speech fixture and metadata
scripts/                  Gate scripts, smokes, baseline verifiers
```

Architecture details: [overview](../architecture/overview.md),
[controller API](../architecture/controller-api.md),
[recorder agent](../architecture/recorder-agent.md),
[web console](../architecture/web-console.md),
[data model](../architecture/data-model.md).

## Gates

Use the smallest meaningful gate while iterating, then the broad gate before
handing off. The full task list is in the [tasks reference](../reference/tasks.md).

```powershell
mise run check        # full repository gate
mise run build        # build everything
```

Targeted:

```powershell
mise run node:check node:test node:lint node:format-check
mise run rust:check rust:fmt-check rust:clippy rust:miri
mise run check:loc
```

`mise run check` includes the baseline verifiers, Drizzle replay, TypeScript,
Node tests, lint/format, the fake-controller agent smoke, and the Rust suite
(check, rustfmt, clippy, Miri). The DB verifier needs a working Docker/Postgres.

## Conventions

- **Formatting** follows [`.editorconfig`](../../.editorconfig): UTF-8, LF, final
  newline, trim trailing whitespace, two-space indentation (Rust uses four).
- **File size:** keep files under the **1000-LOC budget** enforced by
  `mise run check:loc`. Prefer adding a new single-concern module over growing a
  large file — the codebase deliberately splits files this way.
- **Reuse existing patterns** over new abstractions; don't introduce new
  frameworks or formatters without explicit need.
- **Shared contracts:** when the API and UI need the same shape, use
  `packages/shared` rather than redefining types.
- **Authorization is server-side.** UI visibility never replaces API RBAC. Every
  privileged action stays RBAC-gated and audited — see
  [Authentication & RBAC](../guides/authentication-and-rbac.md).
- **Dates** are stored as UTC ISO 8601 and displayed in browser-local, year-first
  format via the existing helpers.
- **Keep generated output** (`dist`, `target`, coverage, Vite output) and local
  `.env` files out of commits. Drizzle migrations _are_ committed.

## Slices travel together

Keep changes narrow and complete: **code, tests, docs, and migration/evidence
updates ship in the same slice.** Many behaviors are guarded by a
[baseline doc + verifier](baselines.md); when you change an invariant, update the
matching baseline and verifier too.

## Database changes

Edit `packages/db/src/schema.ts` first, then:

```powershell
mise run db:generate    # emit migration SQL
mise run db:migrate     # apply locally
mise run db:verify      # replay against a throwaway database
```

Review and commit the generated SQL and metadata with the schema change. See the
[data model](../architecture/data-model.md).

## Git workflow

```powershell
git status --short --branch   # before editing
git diff --check              # before committing
```

This repo may have in-progress user changes — don't revert, reformat, or
overwrite unrelated files. Commit only files relevant to the slice, with concise,
imperative messages (e.g. `Add recording export audit coverage`). Note any
skipped hardware-only smokes in handoff. Don't promote source-of-truth status
unless code, checks, docs, and evidence support it.
