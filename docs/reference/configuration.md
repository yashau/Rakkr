---
title: Configuration reference
description: Complete environment-variable reference for the Rakkr controller API.
sidebar:
  order: 1
---

# Configuration reference

Every environment variable the **controller API** reads, grouped by area.
Defaults shown are those set in code. Recorder-agent variables are documented
separately in the [recorder agent CLI reference](recorder-agent.md).

> `DATABASE_URL` is the master switch: unset → JSON/in-memory fallback stores
> (each with its own path below); set → Postgres via Drizzle.

## Core / runtime

| Variable                    | Default                 | Purpose                                                                   |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `PORT`                      | `8787`                  | API listen port.                                                          |
| `NODE_ENV`                  | —                       | `production` enables strict behavior (a real admin password is required). |
| `DATABASE_URL`              | —                       | Postgres connection string. Unset → fallback stores.                      |
| `RAKKR_WEB_ORIGIN`          | `http://localhost:5173` | Allowed CORS / web origin.                                                |
| `RAKKR_RECORDING_CACHE_DIR` | `data/recordings`       | Root directory for cached recording files.                                |
| `RAKKR_API_VERSION`         | `0.0.0-dev`             | Controller version reported by `/healthz` and status routes (stamped at image build).        |
| `RAKKR_API_NO_LISTEN`       | —                       | `1` skips binding a port (used by tests).                                 |
| `RAKKR_LISTEN_SESSION_TTL_SECONDS` | `300`           | Live-listen session TTL before eviction.                                  |
| `RAKKR_SEED_DEMO_DATA`      | enabled                 | Set `0` to disable demo data seeding.                                     |
| `RAKKR_DEMO_METERS`         | disabled                | `1` lets meter endpoints emit synthetic frames when no agent frame is stored (demonstration / screenshots / tests only). Off by default — real usage never fabricates meters; an absent feed reads as empty. |
| `RAKKR_DEMO_METER_DBFS`     | —                       | dBFS value for the synthetic demo meter data; only applies when `RAKKR_DEMO_METERS=1`.    |

## Local admin & seeded access

| Variable                      | Default                               | Purpose                                                                         |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `RAKKR_LOCAL_ADMIN_EMAIL`     | `admin@rakkr.local`                   | Local admin email.                                                              |
| `RAKKR_LOCAL_ADMIN_NAME`      | `Local Admin`                         | Local admin display name.                                                       |
| `RAKKR_LOCAL_ADMIN_PASSWORD`  | `rakkr-local-dev-password` (dev only) | Local admin password. **Required when `NODE_ENV=production`** — absence throws. |
| `RAKKR_LOCAL_ADMIN_ID`        | —                                     | Local admin user ID.                                                            |
| `RAKKR_LOCAL_ADMIN_ROLE`      | —                                     | Override local admin role(s).                                                   |
| `RAKKR_LOCAL_ADMIN_GROUPS`    | —                                     | Local admin group memberships.                                                  |
| `RAKKR_LOCAL_RESOURCE_GRANTS` | —                                     | JSON map of resource grants, e.g. `{"node":["node_x32_test"]}`.                 |
| `RAKKR_LOCAL_ACCESS_POLICIES` | —                                     | JSON array of seeded access policies.                                           |

## OIDC / Azure AD

All disabled unless `RAKKR_OIDC_ENABLED` is truthy (`1`/`on`/`true`/`yes`).

| Variable                     | Default                | Purpose                                                             |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `RAKKR_OIDC_ENABLED`         | disabled               | Enable OIDC login.                                                  |
| `RAKKR_OIDC_ISSUER`          | —                      | Explicit issuer URL (overrides tenant-derived issuer).              |
| `RAKKR_OIDC_AZURE_TENANT_ID` | —                      | Azure tenant; derives the issuer when `RAKKR_OIDC_ISSUER` is unset. |
| `RAKKR_OIDC_CLIENT_ID`       | —                      | OIDC client ID.                                                     |
| `RAKKR_OIDC_CLIENT_SECRET`   | —                      | OIDC client secret.                                                 |
| `RAKKR_OIDC_REDIRECT_URI`    | —                      | Callback URI (must match the IdP app registration).                 |
| `RAKKR_OIDC_SCOPES`          | `openid profile email` | Requested scopes.                                                   |

## TLS / transport

If none of these are set, the API serves plain HTTP. See
[Transport security](../guides/transport-security.md).

| Variable                         | Default | Purpose                                                          |
| -------------------------------- | ------- | ---------------------------------------------------------------- |
| `RAKKR_API_TLS_CERT_PATH`        | —       | Active server certificate (set with the key).                    |
| `RAKKR_API_TLS_KEY_PATH`         | —       | Active server key (set with the cert).                           |
| `RAKKR_API_TLS_CA_PATH`          | —       | CA bundle; also the client-CA fallback for mTLS.                 |
| `RAKKR_API_TLS_NEXT_CERT_PATH`   | —       | Next (rotation) certificate.                                     |
| `RAKKR_API_TLS_NEXT_KEY_PATH`    | —       | Next (rotation) key.                                             |
| `RAKKR_API_TLS_NEXT_NOT_BEFORE`  | —       | `notBefore` timestamp for the next cert summary.                 |
| `RAKKR_API_TLS_CLIENT_CA_PATH`   | —       | Client-cert CA for mTLS (falls back to `RAKKR_API_TLS_CA_PATH`). |
| `RAKKR_API_TLS_CLIENT_CERT_MODE` | `off`   | mTLS mode: `off` / `optional` / `required`.                      |

## Node lifecycle / Ansible runner (controller side)

| Variable                          | Default                         | Purpose                                                                                     |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `RAKKR_ANSIBLE_RUNNER_URL`        | —                               | Base URL of the Ansible runner. Unset → lifecycle runs throw `ansible_runner_unconfigured`. |
| `RAKKR_ANSIBLE_RUNNER_TOKEN`      | —                               | Bearer token sent to the runner.                                                            |
| `RAKKR_ANSIBLE_RUNNER_TIMEOUT_MS` | `120000`                        | Runner request timeout.                                                                     |
| `RAKKR_NODE_LIFECYCLE_STORE_PATH` | `data/node-lifecycle-jobs.json` | JSON store for lifecycle jobs.                                                              |

> SSH users/keys/become-passwords (`RAKKR_ANSIBLE_TARGETS`,
> `RAKKR_ANSIBLE_SSH_DIR`, …) are read by the **runner**, not the controller —
> see [Node lifecycle](../guides/node-lifecycle.md).

## Node credentials & onboarding (controller side)

See [Node onboarding](../guides/node-onboarding.md).

| Variable                    | Default                            | Purpose                                                                                                  |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `RAKKR_NODE_SSH_MASTER_KEY` | falls back to `RAKKR_SECRET_KEY`   | Master key encrypting node SSH private keys at rest. **Set in production**; unset uses an insecure dev key. |
| `RAKKR_RUNNER_TOKEN`        | —                                  | Shared token the Ansible runner presents to fetch per-node SSH keys/tokens (`…/ssh-credential/material`). Unset disables the runner fetch endpoint. |

The runner side of the fetch (set on the **runner**, not the controller):
`RAKKR_RUNNER_CONTROLLER_URL`, `RAKKR_RUNNER_TOKEN`, `RAKKR_RUNNER_CONTROLLER_CA`
(self-signed CA bundle), `RAKKR_RUNNER_ALLOW_INSECURE` (`1` skips TLS verify;
dev only), `RAKKR_RUNNER_CONTROLLER_TIMEOUT_SECONDS` (default `20`).

## JSON fallback store paths

Used when `DATABASE_URL` is unset; resolved relative to the working directory.

| Variable                                       | Default                                  |
| ---------------------------------------------- | ---------------------------------------- |
| `RAKKR_RECORDING_METADATA_STORE_PATH`          | `data/recordings-metadata.json`          |
| `RAKKR_RECORDING_JOB_STORE_PATH`               | `data/recording-jobs.json`               |
| `RAKKR_SCHEDULE_STORE_PATH`                    | `data/schedules.json`                    |
| `RAKKR_RECORDING_PROFILE_STORE_PATH`           | `data/recording-profiles.json`           |
| `RAKKR_WATCHDOG_POLICY_STORE_PATH`             | `data/watchdog-policies.json`            |
| `RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH`        | `data/channel-map-templates.json`        |
| `RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH`      | `data/channel-map-assignments.json`      |
| `RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH` | `data/channel-map-assignment-plans.json` |
| `RAKKR_RETENTION_POLICY_STORE_PATH`            | `data/retention-policies.json`           |
| `RAKKR_UPLOAD_POLICY_STORE_PATH`               | `data/upload-policies.json`              |
| `RAKKR_UPLOAD_QUEUE_STORE_PATH`                | `data/upload-queue.json`                 |
| `RAKKR_UPLOAD_DESTINATION_STORE_PATH`          | `data/upload-destinations.json`          |
| `RAKKR_CONTROLLER_SETTINGS_STORE_PATH`         | `data/controller-settings.json`          |
| `RAKKR_RECORDING_CHUNK_STORE_PATH`             | `data/recording-chunks.json`             |
| `RAKKR_ROOM_STORE_PATH`                        | `data/rooms.json`                        |
| `RAKKR_ROOM_ROSTER_STORE_PATH`                 | `data/room-roster.json`                  |
| `RAKKR_SWITCHER_STORE_PATH`                    | `data/switchers.json`                    |
| `RAKKR_SWITCHER_MAPPING_STORE_PATH`            | `data/switcher-mappings.json`            |

## Background runners & leases

| Variable                                            | Default | Purpose                                                        |
| --------------------------------------------------- | ------- | -------------------------------------------------------------- |
| `RAKKR_SCHEDULE_RUNNER_ENABLED`                     | enabled | Set `0` to disable the schedule runner.                        |
| `RAKKR_SCHEDULE_RUNNER_INTERVAL_SECONDS`            | `30`    | Schedule runner tick.                                          |
| `RAKKR_SCHEDULE_FAILURE_RETRY_SECONDS`              | `300`   | Retry delay after a schedule failure.                          |
| `RAKKR_UPLOAD_RUNNER_ENABLED`                       | enabled | Set `0` to disable the upload runner.                          |
| `RAKKR_UPLOAD_RUNNER_INTERVAL_SECONDS`              | `60`    | Upload runner tick.                                            |
| `RAKKR_UPLOAD_RUNNER_BATCH_SIZE`                    | `10`    | Items per upload pass.                                         |
| `RAKKR_UPLOAD_QUEUE_LEASE_SECONDS`                  | `900`   | Upload queue item lease.                                       |
| `RAKKR_UPLOAD_QUEUE_MAX_ATTEMPTS`                   | `5`     | Max attempts per queue item.                                   |
| `RAKKR_RETENTION_RUNNER_ENABLED`                    | enabled | Set `0` to disable the retention runner.                       |
| `RAKKR_RETENTION_RUNNER_INTERVAL_SECONDS`           | `300`   | Retention runner tick.                                         |
| `RAKKR_RETENTION_RUNNER_BATCH_SIZE`                 | `25`    | Items per retention pass.                                      |
| `RAKKR_RECORDING_JOB_LEASE_RUNNER_ENABLED`          | enabled | Set `0` to disable the job-lease runner.                       |
| `RAKKR_RECORDING_JOB_LEASE_RUNNER_INTERVAL_SECONDS` | `10`    | Lease runner tick.                                             |
| `RAKKR_RECORDING_JOB_LEASE_SECONDS`                 | `30`    | Recording-job lease duration.                                  |
| `RAKKR_WATCHDOG_RUNNER_ENABLED`                     | enabled | Set `0` to disable the watchdog runner.                        |
| `RAKKR_WATCHDOG_RUNNER_INTERVAL_SECONDS`            | `30`    | Watchdog runner tick.                                          |
| `RAKKR_WATCHDOG_MAX_SAMPLE_SPAN_SECONDS`            | `30`    | Watchdog max sample span.                                      |
| `RAKKR_WATCHDOG_METER_MAX_AGE_SECONDS`              | —       | Watchdog meter freshness cutoff.                               |
| `RAKKR_NODE_OFFLINE_AFTER_SECONDS`                  | `120`   | Heartbeat staleness before a node is `offline` (`0` disables). |
| `RAKKR_METER_HISTORY_LIMIT`                         | `600`   | In-memory meter-frame history cap.                             |
| `RAKKR_SWITCHER_ROUTING_RUNNER_ENABLED`            | enabled | Set `0` to disable the switcher routing runner.                |
| `RAKKR_SWITCHER_ROUTING_RUNNER_INTERVAL_SECONDS`   | `20`    | Switcher routing runner tick.                                  |

## Audio tooling & recording-job defaults

| Variable                                                 | Default              | Purpose                                    |
| -------------------------------------------------------- | -------------------- | ------------------------------------------ |
| `RAKKR_AUDIO_PREVIEW_MAX_BYTES`                          | `67108864`           | Max decoded audio preview size (64 MiB).   |
| `RAKKR_AUDIO_TOOL_TIMEOUT_MS`                            | `15000`              | ffmpeg/ffprobe invocation timeout.         |
| `RAKKR_FFMPEG_COMMAND` / `RAKKR_FFPROBE_COMMAND`         | `ffmpeg` / `ffprobe` | Override the audio tool binaries.          |
| `RAKKR_FFMPEG_ARGS_PREFIX` / `RAKKR_FFPROBE_ARGS_PREFIX` | —                    | Extra args before the tool args.           |
| `RAKKR_AGENT_CAPTURE_CHANNELS`                           | `2`                  | Default capture channel count for jobs.    |
| `RAKKR_AGENT_CAPTURE_DEVICE`                             | `default`            | Default capture device for jobs.           |
| `RAKKR_AGENT_CAPTURE_FORMAT`                             | `S16_LE`             | Default capture sample format for jobs.    |
| `RAKKR_AGENT_CAPTURE_SAMPLE_RATE`                        | `48000`              | Default capture sample rate for jobs.      |
| `RAKKR_AGENT_CAPTURE_SECONDS`                            | `3600`               | Default capture duration for jobs.         |
| `RAKKR_AGENT_CAPTURE_INTERFACE_ID`                       | —                    | Default capture interface for job targets. |

## Upload destination credentials

All upload-destination connection details are configured in **Settings → Upload
Destinations** and stored by the controller — there are no `RAKKR_`-prefixed S3
variables and no `AWS_*` environment dependency. Many named destinations of each
kind may exist; an upload policy references one by id.

- **S3** is configured per destination: a provider preset (AWS, Cloudflare R2,
  Backblaze B2, Wasabi, MinIO, DigitalOcean Spaces, custom), region and/or custom
  endpoint, bucket, upload path/prefix, access key, secret key, and path-style.
  Uploads go directly to the configured endpoint.
- **SMB** is configured per destination: server, share, domain, username, password,
  upload path, and port. The controller speaks SMB 2.1/3.x directly over the
  network — no OS mount is required.
- SMB passwords and S3 secret access keys are encrypted at rest with AES-256-GCM.

| Variable           | Default                | Purpose                                                                                                                            |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RAKKR_SECRET_KEY` | dev fallback (insecure) | Master key used to encrypt/decrypt upload-destination secrets at rest. **Set this in production**; if unset, an insecure development key is used and a warning is logged. Rotating it makes previously stored secrets undecryptable (re-enter them). |
| `RAKKR_REQUIRE_SECRET_KEY` | —                      | When set, refuses the insecure dev fallback key (requires a real `RAKKR_SECRET_KEY`). |

## Test-only

| Variable                      | Purpose                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `RAKKR_API_NO_LISTEN`         | `1` skips port binding (set by the test runner).                                                                         |
| `RAKKR_API_TEST_DATABASE_URL` | If set, the test runner copies it into `DATABASE_URL`; otherwise `DATABASE_URL` is removed so tests use fallback stores. |
| `RAKKR_SEED_DEMO_DATA=0`      | Disables demo seeding during tests.                                                                                      |
