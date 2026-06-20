# Rakkr Generic Device Baseline

Status: Partial baseline checked.

## Behavior

- X32 Rack is only the first test fixture; recorder nodes target generic Linux audio interfaces.
- ALSA is the MVP backend for capture and meters.
- Capture is configured by command, device, format, sample rate, channel count, duration, and output path.
- Agent capture and meter paths use `arecord` with configurable devices such as `default`, `hw:2,0`, or loopback devices.
- Inventory discovers ALSA capture devices from `arecord -l` and `/proc/asound/pcm`, then adds channel count, sample rates, sysfs hardware paths, and serials when available.
- When `/proc/asound/card*/stream0` lacks capture capability details, inventory falls back to `arecord --dump-hw-params` for ALSA channel and sample-rate metadata.
- Meter target selection maps both numeric `hw:2,0` and named `hw:Loopback,1,0` ALSA capture devices to collected inventory interfaces when possible.
- Synthetic meters and fake-controller capture/render smoke tests validate agent workflows without hardware.
- Linux `snd-aloop` smoke tasks can validate WAV capture, agent meters, and render/channel-map output on a recorder node.
- Remaining gaps: Linux loopback smoke execution on a recorder node, physical X32 validation, broader physical-device validation, and JACK/PipeWire adapters are not complete.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Configurable capture command/device/format/rate/channels | `crates/recorder-agent/src/config.rs` and `crates/recorder-agent/src/capture.rs` |
| Generic capture command arguments | `crates/recorder-agent/src/capture.rs` |
| ALSA inventory parsing, `/proc/asound/pcm`, stream/hw-params metadata, sysfs serials | `crates/recorder-agent/src/inventory.rs` |
| Numeric and named ALSA capture-device inventory matching | `crates/recorder-agent/src/alsa_device.rs` |
| ALSA and synthetic meter frame generation | `crates/recorder-agent/src/telemetry.rs` |
| Channel-map render planning for generic capture inputs | `crates/recorder-agent/src/channel_map.rs` |
| Linux `snd-aloop` capture, meter, and render smoke tasks | `.mise.toml`, `scripts/alsa-loopback-smoke.sh`, `scripts/agent-loopback-meter-smoke.sh`, `scripts/alsa-loopback-render-smoke.sh` |
| Hardware-free job lifecycle, render, cache upload, and stop handling | `scripts/agent-fake-controller-smoke.mjs` |

`mise run devices:check-generic` validates this partial baseline, and `mise run check` runs it.
