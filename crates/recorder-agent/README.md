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

- The version is stamped at build time from the release tag. The release workflow
  derives the calendar version from the pushed `agent-v…` tag, sets
  `RAKKR_AGENT_VERSION`, and `src/version.rs` embeds it via `option_env!`, so
  `--version` and the inventory `agent_version` report the version the binary was
  built from. Unstamped local and CI builds report `0.0.0-dev`.

```powershell
cargo run -p rakkr-recorder-agent -- --version
```

To cut a release, run `mise run release agent`; it computes the next
`YYYY.MM.DD-N` and pushes an `agent-v…` tag. The pushed tag triggers the `Release
recorder agent` workflow
([`.github/workflows/release-agent.yml`](../../.github/workflows/release-agent.yml)),
which cross-compiles static musl binaries for `x86_64-unknown-linux-musl` and
`aarch64-unknown-linux-musl` with `cargo-zigbuild` and publishes a GitHub release
(tagged `agent-v…`) that attaches both `.tar.gz` artifacts and their `.sha256`
checksums. See [Releases & versioning](../../docs/operations/releases.md) for the
repository-wide release model.

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

## 🎙️ Voice enhancement

`src/enhance.rs` denoises 48 kHz mono audio in-process with **DeepFilterNet3**
(`deep_filter`, tract inference, embedded model) or **RNNoise** (`nnnoiseless`) — no
extra node packages. When a recording profile enables enhancement,
`channel_map::render_enhanced_output` produces an enhanced rendition (ffmpeg downmix
→ in-process denoise → ffmpeg voice chain: high-pass, low-pass, de-esser,
compressor, loudnorm, gate) and the agent uploads it alongside the preserved raw
master. The live-listen monitor reuses the same denoiser **on demand**: when the
controller's node config reports a listener wants enhanced audio, the meter loop
denoises the captured 48 kHz PCM and posts an extra `?rendition=enhanced` monitor
chunk; otherwise only the raw chunk is sent. See [Audio enhancement](https://github.com/yashau/Rakkr/blob/main/docs/guides/audio-enhancement.md).

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
