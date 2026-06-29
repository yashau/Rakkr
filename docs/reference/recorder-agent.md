---
title: Recorder agent CLI reference
description: Command-line flags and every RAKKR_* environment variable for the Rust recorder agent.
sidebar:
  order: 2
---

# Recorder agent CLI reference

The recorder agent binary is `rakkr-recorder-agent` (`crates/recorder-agent`).
Run it with `cargo run -p rakkr-recorder-agent -- <flags>` in development, or as
the deployed binary on a node. Every flag has a matching `RAKKR_*` environment
variable (via clap `env`) except the two pure-CLI print modes noted below.

For how these fit together, see the
[recorder agent architecture](../architecture/recorder-agent.md).

## Run modes

Without a mode flag, the agent runs as a long-lived daemon.

| Flag                              | Env                                   | Behavior                                                   |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `--print-inventory`               | _(CLI only)_                          | Print node inventory JSON and exit.                        |
| `--print-meter-frame`             | _(CLI only)_                          | Capture/generate one meter frame, print JSON, exit.        |
| `--print-channel-map-assignments` | `RAKKR_PRINT_CHANNEL_MAP_ASSIGNMENTS` | Print this node's channel-map assignments (needs a token). |
| `--run-next-job`                  | `RAKKR_RUN_NEXT_JOB`                  | Claim and run one queued job, then exit (needs a token).   |
| `--capture-recording-id`          | `RAKKR_CAPTURE_RECORDING_ID`          | One-shot capture → render → upload for a recording ID.     |
| `--attach-cache-file`             | `RAKKR_ATTACH_CACHE_FILE`             | Upload an existing local file as a recording's cache.      |
| `--bootstrap`                     | `RAKKR_BOOTSTRAP`                     | Day-0: generate SSH keypair, hand the private key to the controller (bootstrap token), write the returned controller token, then exit. |

### Bootstrap mode

Used at first boot (usually by `deploy/bootstrap/agent.sh`); see
[Node onboarding](../guides/node-onboarding.md).

| Variable                          | Default                                        | Purpose                                                        |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `RAKKR_BOOTSTRAP_TOKEN`           | —                                              | Single-use bootstrap token (required for `--bootstrap`).        |
| `RAKKR_BOOTSTRAP_AUTHORIZED_KEYS` | `/var/lib/rakkr/agent/.ssh/authorized_keys`    | Where the generated public key is installed.                    |
| `RAKKR_BOOTSTRAP_ENV_FILE`        | `/etc/rakkr/recorder-agent.env`                | Env file the controller token is written into.                 |
| `RAKKR_SSH_KEYGEN_COMMAND`        | `ssh-keygen`                                   | Keypair generator command.                                      |

## Controller / identity / transport

| Variable                           | Default                 | Purpose                                                                                |
| ---------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `RAKKR_CONTROLLER_URL`             | `http://localhost:8787` | Controller base URL. HTTPS required for non-loopback hosts unless insecure is allowed. |
| `RAKKR_ALLOW_INSECURE_CONTROLLER`  | `false`                 | Permit plaintext HTTP to a non-loopback controller (dev only).                         |
| `RAKKR_CONTROLLER_CA_CERT_PATH`    | —                       | PEM CA bundle to trust for the controller TLS connection.                              |
| `RAKKR_CONTROLLER_TOKEN`           | —                       | Node bearer token. Without it, the daemon runs offline (no sync, no jobs).             |
| `RAKKR_NODE_ID`                    | `node_local_dev`        | Stable node identifier.                                                                |
| `RAKKR_NODE_ALIAS`                 | `Local Recorder Node`   | Human alias.                                                                           |
| `RAKKR_NODE_SITE`                  | `Unassigned Site`       | Site/location.                                                                         |
| `RAKKR_NODE_ROOM`                  | `Unassigned Room`       | Room/location.                                                                         |
| `RAKKR_HEARTBEAT_SECONDS`          | `5`                     | Daemon tick interval.                                                                  |
| `RAKKR_JOB_POLL_SECONDS`           | `2`                     | Poll interval while a job runs (min 1).                                                |
| `RAKKR_MAX_CONCURRENT_RECORDINGS`  | `1`                     | Max concurrent capture workers (controller can override).                              |
| `RAKKR_MONITOR_CHUNK_SYNC_ENABLED` | `true`                  | Whether to POST live-listen monitor audio chunks.                                      |

> CLI names for identity are `--node-id`, `--node-alias`, `--node-site`,
> `--node-room` (the underlying config fields are `alias`/`site`/`room`).

## Capture

| Variable                             | Default          | Purpose                                                                                                 |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `RAKKR_CAPTURE_BACKEND`              | `alsa`           | `alsa` / `jack` / `pipewire`.                                                                           |
| `RAKKR_CAPTURE_COMMAND`              | `arecord`        | Capture executable. Auto-swaps to `pw-record` / `jack_capture` if left at `arecord` for those backends. |
| `RAKKR_CAPTURE_DEVICE`               | `default`        | Device / target / port string.                                                                          |
| `RAKKR_CAPTURE_FORMAT`               | `S16_LE`         | PCM sample format.                                                                                      |
| `RAKKR_CAPTURE_SAMPLE_RATE`          | `48000`          | Sample rate (Hz).                                                                                       |
| `RAKKR_CAPTURE_CHANNELS`             | `2`              | Channel count.                                                                                          |
| `RAKKR_CAPTURE_SECONDS`              | `60`             | Duration for one-shot/local capture mode.                                                               |
| `RAKKR_CAPTURE_ARGS_TEMPLATE`        | —                | Override capture args (placeholders; see below).                                                        |
| `RAKKR_CHANNEL_RENDER_COMMAND`       | `ffmpeg`         | Tool used to render channel maps / re-encode.                                                           |
| `RAKKR_CAPTURE_MIN_OUTPUT_BYTES`     | `128`            | Minimum acceptable output size (smaller = "too small" failure).                                         |
| `RAKKR_CAPTURE_GROWTH_GRACE_SECONDS` | `10`             | Grace before growth-stall checks begin.                                                                 |
| `RAKKR_CAPTURE_STALLED_SECONDS`      | `30`             | If output stops growing this long (after grace), capture is "stalled".                                  |
| `RAKKR_CAPTURE_OUTPUT`               | —                | Explicit output path for one-shot capture.                                                              |
| `RAKKR_CAPTURE_OUTPUT_CODEC`         | inferred (`wav`) | `wav` / `flac` / `mp3`.                                                                                 |
| `RAKKR_CAPTURE_OUTPUT_BITRATE_KBPS`  | `128` (mp3)      | mp3 bitrate.                                                                                            |
| `RAKKR_CAPTURE_OUTPUT_VBR`           | `true`           | mp3 VBR (mp3 only).                                                                                     |

### Command templates

`RAKKR_CAPTURE_ARGS_TEMPLATE` and `RAKKR_METER_ARGS_TEMPLATE` replace the built-in
per-backend argument list. They are shell-split (quoting works) and substitute
these placeholders per token: `{device}`, `{format}`, `{sample_rate}`,
`{channels}`, `{seconds}`, `{output}` / `{output_path}` (for meters, the output is
`-`, i.e. stdout). The configured executable (`--capture-command`) is still the
program run.

## Attach-cache mode

| Variable                              | Default      | Purpose                        |
| ------------------------------------- | ------------ | ------------------------------ |
| `RAKKR_ATTACH_CACHE_RECORDING_ID`     | —            | Recording to attach a file to. |
| `RAKKR_ATTACH_CACHE_FILE`             | —            | Local file to upload.          |
| `RAKKR_ATTACH_CACHE_CONTENT_TYPE`     | `audio/mpeg` | Content-Type of the upload.    |
| `RAKKR_ATTACH_CACHE_DURATION_SECONDS` | —            | Optional duration header.      |
| `RAKKR_ATTACH_CACHE_FILE_NAME`        | —            | Optional override filename.    |

## Metering

| Variable                      | Default  | Purpose                                                   |
| ----------------------------- | -------- | --------------------------------------------------------- |
| `RAKKR_METER_BACKEND`         | `alsa`   | `alsa` / `jack` / `pipewire` / `synthetic`.               |
| `RAKKR_METER_ARGS_TEMPLATE`   | —        | Override meter capture args (placeholders; `-` = stdout). |
| `RAKKR_METER_SAMPLE_SECONDS`  | `1`      | Seconds sampled per meter frame (min 1).                  |
| `RAKKR_METER_CLIP_DBFS`       | `-1.0`   | Clipping threshold (peak dBFS).                           |
| `RAKKR_METER_FLATLINE_DBFS`   | `-120.0` | Flatline threshold (all channels RMS ≤ this).             |
| `RAKKR_METER_LOW_SIGNAL_DBFS` | `-55.0`  | Low-signal threshold (max RMS ≤ this, not flatline).      |

> The channel-correlation alert threshold is a fixed constant (`0.98`), not
> configurable.

## Health log

| Variable                                | Default                            | Purpose                                               |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `RAKKR_AGENT_HEALTH_LOG_FILE`           | `data/agent/health-events.jsonl`   | JSONL health log path.                                |
| `RAKKR_AGENT_HEALTH_LOG_STORE`          | `jsonl`                            | `jsonl` / `sqlite` (SQLite unavailable under Miri).   |
| `RAKKR_AGENT_HEALTH_SQLITE_FILE`        | `data/agent/health-events.sqlite3` | SQLite store path.                                    |
| `RAKKR_AGENT_HEALTH_LOG_MAX_BYTES`      | `1048576`                          | Rotate JSONL at this size (`0` disables rotation).    |
| `RAKKR_AGENT_HEALTH_LOG_RETAINED_FILES` | `3`                                | Rotated files kept (`0` deletes instead of rotating). |

## System health

| Variable                                     | Default         | Purpose                               |
| -------------------------------------------- | --------------- | ------------------------------------- |
| `RAKKR_SYSTEM_HEALTH_ENABLED`                | `true`          | Enable disk/CPU/audio-backend checks. |
| `RAKKR_SYSTEM_HEALTH_DF_COMMAND`             | `df`            | Disk-usage command (`df -Pk <path>`). |
| `RAKKR_SYSTEM_HEALTH_DISK_PATH`              | `.`             | Path to measure disk usage for.       |
| `RAKKR_SYSTEM_HEALTH_DISK_WARNING_PERCENT`   | `85.0`          | Disk used% warning.                   |
| `RAKKR_SYSTEM_HEALTH_DISK_CRITICAL_PERCENT`  | `95.0`          | Disk used% critical.                  |
| `RAKKR_SYSTEM_HEALTH_LOAD_WARNING_PER_CORE`  | `2.0`           | 1-min loadavg/core warning.           |
| `RAKKR_SYSTEM_HEALTH_LOAD_CRITICAL_PER_CORE` | `4.0`           | 1-min loadavg/core critical.          |
| `RAKKR_SYSTEM_HEALTH_LOADAVG_PATH`           | `/proc/loadavg` | Loadavg source.                       |

## Inventory probes & state

| Variable                               | Default                                   | Purpose                                          |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `RAKKR_INVENTORY_ARECORD_COMMAND`      | `arecord`                                 | Command for `-l` listing and `--dump-hw-params`. |
| `RAKKR_INVENTORY_PROC_ASOUND_PCM_PATH` | `/proc/asound/pcm`                        | Fallback PCM device list.                        |
| `RAKKR_AGENT_STATE_FILE`               | `data/agent/job-state.json`               | Persisted job state for recovery.                |
| `RAKKR_RECORDER_CACHE_MANIFEST_FILE`   | `data/agent/recorder-cache-manifest.json` | Tracks uploaded cache for retention sweeps.      |

## Logging

Tracing verbosity is controlled by `RUST_LOG` (baseline `info`), not a `RAKKR_*`
variable.
