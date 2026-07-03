---
title: Tasks (mise)
description: The mise tasks that run, build, check, and validate Rakkr.
sidebar:
  order: 6
---

# Tasks (mise)

[`mise`](https://mise.jdx.dev/) is Rakkr's canonical toolchain and task runner;
all tasks are defined in [`.mise.toml`](../../.mise.toml). Prefer these over ad-hoc
commands. Run a task with `mise run <name>`.

## Setup & run

| Task                                     | What it does                                  |
| ---------------------------------------- | --------------------------------------------- |
| `mise trust`                             | Trust the repo's `.mise.toml`.                |
| `mise run setup`                         | Install pinned toolchains, then dependencies. |
| `mise run install`                       | `pnpm install`.                               |
| `mise run install:ci`                    | `pnpm install --frozen-lockfile` (CI).        |
| `mise run dev`                           | Run the API and web console together.         |
| `mise run services:up` / `services:down` | Start / stop local Postgres in Docker.        |

## Gates

| Task                 | What it does                               |
| -------------------- | ------------------------------------------ |
| `mise run check`     | The full repository gate (see below).      |
| `mise run build`     | Build TS packages/apps and the Rust agent. |
| `mise run check:loc` | Enforce the 1000-LOC-per-file budget.      |

`mise run check` is intentionally broad. It runs the baseline doc verifiers,
Drizzle migration replay, TypeScript checks, Node tests, oxlint, oxfmt check, the
fake-controller agent smoke, and the Rust suite (cargo check, rustfmt, clippy,
Miri). It needs a working Docker/Postgres for the DB verifier.

## Targeted Node / TypeScript

| Task                                         | What it does                |
| -------------------------------------------- | --------------------------- |
| `mise run node:check`                        | TypeScript type-check.      |
| `mise run node:test`                         | Node test suites.           |
| `mise run node:lint`                         | oxlint.                     |
| `mise run node:format` / `node:format-check` | oxfmt write / check.        |
| `mise run node:build`                        | Build TS packages and apps. |

## Targeted Rust

| Task                                   | What it does                      |
| -------------------------------------- | --------------------------------- |
| `mise run rust:check`                  | `cargo check`.                    |
| `mise run rust:fmt` / `rust:fmt-check` | rustfmt write / check.            |
| `mise run rust:clippy`                 | Clippy lints.                     |
| `mise run rust:miri`                   | Miri (undefined-behavior checks). |
| `mise run rust:build`                  | Build the recorder agent.         |

## Database

| Task                   | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| `mise run db:generate` | Generate Drizzle migration SQL from the schema.     |
| `mise run db:migrate`  | Apply migrations to `DATABASE_URL`.                 |
| `mise run db:verify`   | Replay all migrations against a throwaway database. |

## Baseline verifiers

Each checks a [baseline doc](../contributing/baselines.md) against the source:

| Task                                                                                                        | Baseline                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| `mise run auth:check-oidc`                                                                                  | Azure AD OIDC            |
| `mise run security:check-rbac`                                                                              | RBAC / audit             |
| `mise run security:check-transport`                                                                         | Transport security       |
| `mise run switcher:check`                                                                                   | Audio matrix switcher routing |
| `mise run scheduler:check`                                                                                  | Scheduler                |
| `mise run settings:check`                                                                                   | Settings / templates     |
| `mise run recordings:check`                                                                                 | Recording library        |
| `mise run recordings:check-first-reliable`                                                                  | First reliable recording |
| `mise run devices:check-generic`                                                                            | Generic devices          |
| `mise run health:check-watchdog`                                                                            | Health watchdog          |
| `mise run storage:check`                                                                                    | Storage upload           |
| `mise run operations:check`                                                                                 | Operations               |
| `mise run time:check`                                                                                       | Date / time              |
| `mise run ops:check-alerts` / `ops:check-prometheus` / `ops:check-grafana` / `ops:check-observability-docs` | Observability artifacts  |

## Agent & hardware smokes

| Task                                                                                                                                 | What it does                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `mise run agent:fake-controller-smoke`                                                                                               | Full agent lifecycle against a fake controller, no hardware (part of `check`). |
| `mise run agent:loopback-smoke` · `loopback-meter-smoke` · `loopback-render-smoke` · `loopback-fixture-smoke` · `loopback-job-smoke` | ALSA loopback smokes (Linux).                                                  |
| `mise run agent:alsa-capture-smoke` · `alsa-meter-smoke` · `alsa-job-smoke`                                                          | Generic ALSA hardware smokes (Linux).                                          |
| `mise run ansible:runner-smoke` · `ansible:x32-smoke`                                                                                | Node-lifecycle smokes via the Ansible runner.                                  |

> Hardware and loopback smokes require the matching Linux device or loopback
> setup and are **not** portable Windows gates. See
> [Testing](../contributing/testing.md).
