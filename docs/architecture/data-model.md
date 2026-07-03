---
title: Data model
description: Persistence in Rakkr — Drizzle + Postgres, the JSON fallback stores, the database tables, the migration workflow, and shared contracts.
sidebar:
  order: 5
---

# Data model

Controller persistence is **Postgres via Drizzle ORM**, packaged as `@rakkr/db`
(`packages/db`), which owns the schema, the committed migrations, and a migration
verifier. Domain shapes are defined once in `@rakkr/shared` and imported by both
the API and the console.

## Postgres or fallback

`DATABASE_URL` is the master switch:

- **Set** → each store uses its Postgres backend (`PostgresNodeStore`,
  `PostgresRecordingJobStore`, …). Several Postgres stores also hold a fallback
  and degrade to it on DB errors, so a transient database problem doesn't take the
  whole controller down.
- **Unset** → stores use a seeded in-memory or JSON-file fallback. The controller
  still serves many features; write operations that genuinely require a database
  throw a clear `database_unavailable` error. This is how most of the API test
  suite runs (the test harness removes `DATABASE_URL` unless
  `RAKKR_API_TEST_DATABASE_URL` is set).

Each fallback store has its own on-disk JSON path (e.g.
`RAKKR_RECORDING_METADATA_STORE_PATH`); see the
[configuration reference](../reference/configuration.md#json-fallback-store-paths).

The Drizzle client (`packages/db/src/client.ts`) opens a small `postgres.js` pool
(`max: 3`) and re-exports the common query helpers used across the API.

## Tables

The schema (`packages/db/src/schema.ts`) defines 37 tables plus Postgres enums
(`node_status`, `health_severity`, `recording_status`, `recording_job_status`,
`recording_chunk_status`, `recording_source`, `audit_outcome`,
`access_policy_effect`, `access_policy_subject_type`, `room_roster_subject_type`,
`room_roster_source`). Timestamps are `timestamptz`; structured columns are
`jsonb`.

### Auth & access

| Table                                               | Purpose                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `users`                                             | Accounts: email (unique), name, optional password hash (null for OIDC), provider, `disabledAt`. |
| `roles`, `permissions`, `role_permissions`          | The RBAC catalog and role→permission joins.                                                     |
| `user_roles`, `access_groups`, `user_access_groups` | Role and group membership; `access_groups`/`user_access_groups` back first-party group management, keyed by a name-derived immutable slug. |
| `access_policies`                                   | Allow/deny rules by subject (user/group/everyone) and resource.                                 |
| `user_resource_grants`                              | Direct per-user resource scope grants.                                                          |
| `auth_sessions`                                     | Login sessions keyed by token hash, with expiry/revocation and client context.                  |
| `oidc_login_states`                                 | In-flight OIDC PKCE/login state.                                                                |

### Nodes & audio

| Table              | Purpose                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `nodes`                 | Recorder nodes: alias, hostname, agent version, status, last-seen, plus jsonb location/network/metadata/tags. `roomId` (FK → `rooms`, `SET NULL`) is the room-identity source of truth; the legacy jsonb `location` is retained for display. |
| `node_credentials`      | Node enrollment tokens (stored as hashes) with prefix, last-used, revocation.                                            |
| `node_ssh_credentials`  | Per-node SSH keypairs for lifecycle: private key encrypted at rest, public half readable; the controller is the system of record. |
| `node_bootstrap_tokens` | Single-use, short-TTL day-0 bootstrap tokens (stored as hashes) consumed atomically at first contact.                    |
| `audio_interfaces`      | Capture devices per node: backend, channel count, hardware path, serial, sample rates.                                   |
| `audio_channels`        | Channels within an interface, with aliases.                                                                              |

### Recordings, jobs & schedules

| Table            | Purpose                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordings`     | Recording records: name, folder, source, status, health status, duration, checksum, node/schedule relations, jsonb metadata/tags, plus the cache paths — `cachePath` (default-playback file) and the optional `rawCachePath`/`enhancedCachePath` rendition masters. |
| `recording_jobs` | Capture job lifecycle with the jsonb capture `command` and lease/heartbeat fields; indexed for lease-based claiming.                          |
| `recording_chunks` | Chunk lifecycle for a recording (`recording_chunk_status`: `capturing`/`cached`/`uploading`/`uploaded`/`partial`/`failed`).                 |
| `schedules`      | Recurrence (jsonb), timezone, templates, capture overrides, and references to profile/retention/watchdog policies plus a `uploadPolicyIds` list for multi-destination fan-out (the singular `uploadPolicyId` is a retained-for-backfill legacy column). `roomId` (FK → `rooms`, `RESTRICT`) is the room-identity source of truth; the legacy `room` column is retained for display/templates. |

### Rooms & access rosters

| Table         | Purpose                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rooms`       | First-class rooms: `name`, required `site`, optional building/floor/description/notes. Unique on (`site`, `name`); referenced by `nodes.roomId` and `schedules.roomId`.                                 |
| `room_roster` | Per-room access grants: `roomId` (FK → `rooms`), `subjectType` (`user`/`group`), `subjectId`, jsonb `capabilities`, `source` (`manual`/`calendar`), `sourceScheduleId`, `grantedByUserId`. |

### Switchers

| Table                 | Purpose                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `switchers`           | Audio-matrix switchers: host/port/model/mode/`enabled`, input/output counts, plus jsonb `secrets` (encrypted). |
| `switcher_input_map`  | Maps a switcher input to a room (`switcherId` + `input` → `roomId`).                                                                     |
| `switcher_output_map` | Maps a switcher output to a user (`switcherId` + `output` → `userId`).                                                                   |

### Health & audit

| Table           | Purpose                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `health_events` | Health/alert lifecycle: type, severity, status, optional node/recording/schedule, lifecycle timestamps + actors, jsonb details. |
| `audit_events`  | The audit log: action, outcome, permission, actor + context, target, jsonb before/after/details/correlation IDs, reason.        |

### Settings & uploads

| Table                                           | Purpose                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `recording_profiles`                            | Codec/bitrate/channel-mode presets, plus the jsonb `settings` (including the voice-enhancement chain).   |
| `controller_settings`                           | Singleton row for controller-wide settings (e.g. display name).                                          |
| `watchdog_policies`                             | Watchdog rule sets (jsonb `rules`).                                                                      |
| `channel_map_templates`, `template_assignments` | Channel-map templates and their assignment to node/interface targets.                                    |
| `upload_destinations`                           | Named SMB/S3 upload targets — many per kind; each owns connection config and encrypted secrets.          |
| `upload_policies`                               | Policies selecting a destination + optional subfolder, trigger, retry budget, and delete-after-upload.   |
| `upload_queue_items`                            | The retry queue — one item per policy per recording, indexed by due state.                               |
| `upload_providers`                              | Legacy one-row-per-kind provider config, superseded by `upload_destinations`; retained for backfill.     |

> **Not tables:** retention policies and node-lifecycle jobs are modeled in the
> fallback/seed layer (with a JSON store for lifecycle jobs) and audited via
> `audit_events`, rather than having dedicated tables.

## Migrations

Migration SQL lives in `packages/db/drizzle/*.sql` with snapshots under
`drizzle/meta/`; **migrations are committed alongside schema changes** (~40 to
date, highest `0039`). The workflow:

```powershell
mise run db:generate   # drizzle-kit generate — emit SQL from schema.ts
mise run db:migrate    # drizzle-kit migrate  — apply to DATABASE_URL
mise run db:verify     # replay all migrations against a throwaway database, then drop it
```

Rules: edit `schema.ts` first, generate, review the emitted SQL + snapshot, run
`db:verify`, and commit the generated files with the schema change. `db:verify`
is part of the full `mise run check` gate and requires a working Postgres.

## Shared contracts

`@rakkr/shared` (`packages/shared/src/index.ts`) is a single Zod-based module
that both API and console import, keeping entity and request/response shapes in
sync. It exports:

- **Domain schemas + inferred types** for nearly every model (nodes, interfaces,
  meter frames, recordings, jobs, profiles, schedules, health/audit events,
  uploads, retention, channel maps, access control).
- **Enums** mirroring the Postgres enums (status, severity, source, outcome,
  channel mode, …).
- **Recurrence schemas** — `scheduleRecurrenceSchema` is a discriminated union on
  `mode` (`manual`/`once`/`daily`/`weekly`/`monthly`/`always_on`) with
  start-early/stop-late and exceptions.
- **The RBAC source of truth** — the `Permission` union (24 strings), the `Role`
  union (`owner`/`admin`/`operator`/`viewer`/`auditor`), the `rolePermissions`
  map, and `hasPermission` helpers. See the
  [permissions reference](../reference/permissions.md).
- **Built-in defaults** used by the fallback/seed layer (default voice profile,
  stub upload policy, keep-controller-cache retention policy, scheduled-voice
  watchdog policy).

When a database is present, the `permissions`/`roles`/`role_permissions` tables
persist the same catalog the shared package defines.
