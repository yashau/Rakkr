---
title: Recorder agent
description: The Rust recorder agent — responsibilities, the daemon loop, capture/metering/health, and how it syncs with the controller.
sidebar:
  order: 3
---

# Recorder agent

The recorder agent is the Linux node process that turns local audio hardware into
managed Rakkr recordings. It is a Rust crate at `crates/recorder-agent` (binary
`rakkr-recorder-agent`), entrypoint `src/main.rs`, configuration in
`src/config.rs`.

This page explains _how it works_. For every flag and environment variable, see
the [Recorder agent CLI reference](../reference/recorder-agent.md).

## Responsibilities

| Area                | What it does                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**        | Reports a stable node ID, alias, site, room, tags, and runtime details (arch, kernel, OS, uptime, IPs, audio backends).                                                   |
| **Inventory**       | Discovers ALSA capture devices (`arecord -l`, falling back to `/proc/asound/pcm`), and detects PipeWire/JACK availability by probing the PATH. Refreshed every heartbeat. |
| **Metering**        | Samples PCM levels per channel and derives quality fields (RMS/peak dBFS, clipping, speech, channel correlation, …).                                                      |
| **Capture / jobs**  | Claims recording jobs, runs bounded-concurrent capture processes, monitors output growth, renders channel maps, re-encodes, and uploads.                                  |
| **Health log**      | Writes lifecycle-managed local evidence (JSONL or SQLite) and syncs events to the controller.                                                                             |
| **System health**   | Tracks disk pressure, CPU/load pressure, and audio-backend availability transitions.                                                                                      |
| **Cache retention** | Tracks rendered/raw cache in a manifest and sweeps per controller-supplied policies.                                                                                      |
| **Recovery**        | Reconciles in-flight jobs on startup, detects controller clock skew, and recovers from runtime device loss and disk shortfall with segment stitching.                     |

## Run modes

Without a mode flag the agent runs as a **long-lived daemon** (the heartbeat
loop). Several one-shot modes exist for diagnostics and scripting:

| Mode                              | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `--print-inventory`               | Print node inventory JSON and exit.                    |
| `--print-meter-frame`             | Capture/generate one meter frame and exit.             |
| `--print-channel-map-assignments` | Fetch and print this node's channel-map assignments.   |
| `--run-next-job`                  | Claim and run exactly one queued job, then exit.       |
| `--capture-recording-id`          | One-shot capture → render → upload for a recording ID. |
| `--attach-cache-file`             | Upload an existing local file as a recording's cache.  |

## The daemon loop

Every heartbeat tick (default 5s), when a controller token is configured, the
agent:

1. **Heartbeats** — `POST /nodes/{id}/heartbeat` with the full inventory
   snapshot; the response `Date` header is used to compute controller clock skew.
2. **Posts a meter frame** — `POST /nodes/{id}/meter-frame`.
3. **Posts a monitor chunk** (if enabled) — `POST /nodes/{id}/listen/chunk` with
   recent WAV audio for live listen-in.
4. **Pulls node config** — `GET /nodes/{id}/config` returns audio defaults,
   recorder-cache policies, and recording capacity, all applied **live** (no
   restart needed to change capture defaults or concurrency).
5. **Syncs health events** — `POST /nodes/{id}/health-events` for anything logged
   locally.
6. **Sweeps cache** — when idle and policies exist, runs retention cleanup.

Recording-job workers run alongside the loop, up to the (controller-overridable)
concurrency limit. Each worker claims a job, runs capture, heartbeats the job,
watches for controller-driven stop/cancel, then renders and uploads. On startup
the agent reconciles any job left in-flight from its persisted state file.

## Capture and backends

The default capture path is **ALSA** via `arecord`. PipeWire (`pw-record`) and
JACK (`jack_capture`) are first-class presets; a **synthetic** meter backend keeps
development hosts working without real hardware. If the capture command is left at
the `arecord` default, the agent auto-selects the right command for the chosen
backend.

Operators can fully override the argument list with **command templates**
(`--capture-args-template`, `--meter-args-template`) using placeholders like
`{device}`, `{format}`, `{sample_rate}`, `{channels}`, `{seconds}`, `{output}` —
so non-`arecord` tools or site-specific flags can be plugged in without code
changes.

Capture is guarded: a minimum output size rejects empty files, and a growth-stall
detector (grace period + stall timeout) fails captures whose output stops
growing, with structured evidence.

## Health evidence

The agent writes a local health log — **rotating JSONL** by default, or a
**SQLite** store — then (with a token) syncs each event to the controller. Local
logging never blocks on sync. Event families include:

- **Meter capture:** capture-failed, device-unavailable, xrun, recovered.
- **Meter quality:** clipping, flatline, low-signal, channel-correlation (+ each
  recovery).
- **Sync health:** heartbeat / meter-frame / monitor-chunk / node-config sync
  failures and recoveries.
- **Recording job:** capture start/stall/render/upload failures, channel-map
  applied/lookup-failed, control-plane/status-poll failures, segment stitching,
  disk-space recovery.
- **System health:** disk pressure, CPU pressure, audio-backend
  unavailable/recovered.
- **Cache retention:** sweep completed, delete failures, tracking sync/failure.

Quality thresholds (clip/flatline/low-signal dBFS), log rotation, disk/CPU
thresholds, and inventory probe paths are all configurable — see the
[CLI reference](../reference/recorder-agent.md).

## Transport

The agent talks to `<controller_url>/api/v1`. It **refuses non-loopback
`http://`** controllers unless explicitly allowed for development, and can trust
an internal controller CA bundle for TLS. All calls send the node bearer token;
node-scoped calls also send an `x-rakkr-agent-id` header. See
[Transport security](../guides/transport-security.md).
