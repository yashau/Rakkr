# 🎛️ Rakkr Recorder Agent

The recorder agent is the Linux node process that turns local audio hardware into managed Rakkr recordings. It discovers interfaces, samples meters, captures jobs, renders outputs, manages local cache, writes health evidence, and syncs node state back to the controller.

## 🚦 Current Shape

| Lane | State | Notes |
| ---- | ----- | ----- |
| 🔎 Inventory | Active | ALSA devices plus PipeWire/JACK availability, refreshed during daemon heartbeats |
| 🎙️ Capture | Active | ALSA default path, PipeWire/JACK presets, and command-template overrides |
| 📊 Metering | Active | S16/S32 PCM levels, quality fields, and synthetic fallback for dev hosts |
| 🩺 Health | Active | Local JSONL events plus controller sync for capture, meter, backend, disk, CPU, and cache faults |
| 🧪 Validation | Active | Fake-controller smokes, ALSA loopback, speech fixture faults, X32, and onboard HDA |

## 🧭 Responsibilities

| Area | Capability |
| ---- | ---------- |
| Identity | Stable node ID, alias, site, room, tags, runtime details |
| Inventory | ALSA capture discovery, PipeWire/JACK availability, refreshed daemon probes |
| Metering | S16/S32 PCM levels, quality fields, synthetic fallback for development hosts |
| Capture | ALSA/PipeWire/JACK presets plus command-template overrides |
| Scheduling handoff | Polls controller capacity and runs bounded concurrent jobs |
| Health | Capture failure/recovery, device unavailable, xrun, clipping, flatline, low signal, channel correlation, disk/CPU/audio-backend transitions |
| Cache | Local rendered/raw cache tracking, retention cleanup, delete-failure reporting |
| Sync | Node heartbeat, meter frames, monitor chunks, job state, and health events |

## ⚡ Quick Commands

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
cargo run -p rakkr-recorder-agent -- --print-meter-frame
```

Run one claimed controller job:

```powershell
cargo run -p rakkr-recorder-agent -- --run-next-job --controller-token <token> --node-id <node>
```

Run as a daemon against a local controller:

```powershell
cargo run -p rakkr-recorder-agent -- `
  --allow-insecure-controller `
  --controller-url http://127.0.0.1:8787 `
  --controller-token <token> `
  --node-id node_local_dev
```

## 🏷️ Versioning & Releases

The agent uses calendar versioning in `YYYY.MM.DD-N` format: the build date plus
a same-day release counter that starts at `1` (for example `2026.06.28-1`, then
`2026.06.28-2` for a second release on the same day).

- The version lives in [`VERSION`](VERSION) and is the single source of truth.
  `src/version.rs` embeds it at compile time with `include_str!`, so `--version`
  and the inventory `agent_version` always report the version the binary was
  built from.
- `mise run agent:version` validates the format and prints the current version.
  The same check runs as part of `mise run check`.

```powershell
cargo run -p rakkr-recorder-agent -- --version
```

To cut a release, bump [`VERSION`](VERSION) to the next `YYYY.MM.DD-N` and merge
to `main`. The `Release recorder agent` workflow
([`.github/workflows/release-agent.yml`](../../.github/workflows/release-agent.yml))
compares the value against the GitHub release history; when it names a version
that does not exist yet, it cross-compiles static musl binaries for
`x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` with
`cargo-zigbuild` and publishes a GitHub release (tagged with the version) that
attaches both `.tar.gz` artifacts and their `.sha256` checksums. If the version
already has a release, the workflow is a no-op.

## 🎚️ Configuration Highlights

| Area | CLI / Environment |
| ---- | ----------------- |
| Node identity | `--node-id`, `--node-alias`, `--node-site`, `--node-room` |
| Capture | `--capture-backend`, `--capture-command`, `--capture-device`, `--capture-format`, `--capture-sample-rate`, `--capture-channels` |
| Capture templates | `--capture-args-template` |
| Metering | `--meter-backend`, `--meter-args-template`, `--meter-sample-seconds` |
| Fault thresholds | `--meter-clip-dbfs`, `--meter-flatline-dbfs`, `--meter-low-signal-dbfs` |
| Job concurrency | `--max-concurrent-recordings` / `RAKKR_MAX_CONCURRENT_RECORDINGS` |
| Health log | `--agent-health-log-file`, `--agent-health-log-max-bytes`, `--agent-health-log-retained-files` |
| Inventory probes | `--inventory-arecord-command`, `--inventory-proc-asound-pcm-path` |
| System health | `--system-health-df-command`, `--system-health-disk-path`, `--system-health-loadavg-path` |

## 🩺 Health Evidence

The agent writes a lifecycle-managed local JSONL health log and, when a node token is configured, syncs health events to the controller. The daemon refreshes audio inventory during heartbeat ticks so backend recovery can be reported without restarting the agent.

| Event Family | Examples |
| ------------ | -------- |
| Meter capture | `agent.meter.capture_failed`, `agent.meter.device_unavailable`, `agent.meter.xrun`, `agent.meter.capture_recovered` |
| Meter quality | `agent.meter.clipping`, `agent.meter.flatline`, `agent.meter.low_signal`, `agent.meter.channel_correlation` |
| Sync health | `agent.node_heartbeat.sync_failed`, `agent.meter_frame.sync_failed`, `agent.listen_monitor.chunk_sync_failed`, recovery events |
| Job health | Capture start/runtime/too-small/stall/render/upload/cache-retention failures |
| System health | Disk pressure, CPU pressure, audio-backend unavailable/recovered |
| Cache health | Recorder-cache cleanup, delete failure, tracking sync, tracking failure |

## 🔊 Backends

| Backend | Capture | Meter |
| ------- | ------- | ----- |
| ALSA | `arecord` defaults and templates | PCM stdout sampling |
| PipeWire | `pw-record` preset or template | PCM stdout sampling |
| JACK | `jack_capture` preset or template | PCM stdout sampling |
| Synthetic | Development fallback | Generated meter frames |

## 🧪 Validation

The agent is covered by Rust tests, Miri, fake-controller smokes, ALSA loopback smokes, and Debian hardware smokes.

```powershell
mise run check
node scripts/agent-fake-controller-smoke.mjs
mise run agent:loopback-fixture-smoke
mise run agent:loopback-job-smoke
```

The fixture smoke replays the checked multi-speaker speech WAV through ALSA
loopback and derives fault lanes for clipping, low signal, and duplicated
channels, then checks daemon health-log behavior against the current agent.
