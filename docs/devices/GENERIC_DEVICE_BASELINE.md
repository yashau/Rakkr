# Rakkr Generic Device Baseline

Status: Partial baseline checked.

## Behavior

- X32 Rack is only the first test fixture; recorder nodes target generic Linux audio interfaces.
- ALSA is the MVP backend for capture and meters.
- Capture and meter sampling are configured by command, optional argument templates, device, format, sample rate, channel count, duration, and output path/stdout.
- Agent capture and meter paths use `arecord` with configurable devices such as `default`, `hw:2,0`, `plughw:2,0`, `hw:CARD=Loopback,DEV=1`, or loopback devices.
- Capture and meter argument templates can target non-`arecord` tools with placeholders for device, format, sample rate, channels, duration, and output target while the default path keeps `arecord` arguments.
- Capture and meter template CLI flags accept hyphen-leading template values.
- Fake-controller smoke coverage exercises template-driven capture arguments through agent job claim, capture, render, cache attach, and cleanup.
- Inventory discovers ALSA capture devices from `arecord -l` and `/proc/asound/pcm`, then adds channel count, sample rates, sysfs hardware paths, and serials when available.
- When `/proc/asound/card*/stream0` lacks capture capability details, inventory falls back to `arecord --dump-hw-params` for ALSA channel and sample-rate metadata.
- Meter target selection maps numeric, named, and `CARD=`/`DEV=` `hw:`/`plughw:` ALSA capture devices, including `hw:Loopback,1,0`, to collected inventory interfaces when possible.
- Runtime inventory reports detected PipeWire and JACK command availability alongside collected audio interface backends.
- Synthetic meters and fake-controller capture/render smoke tests validate agent workflows, including template-driven capture arguments, without hardware.
- Linux `snd-aloop` smoke tasks can validate WAV capture, agent meters, and render/channel-map output on a recorder node.
- Remaining gaps: Linux loopback smoke execution on a recorder node, physical X32 validation, broader physical-device validation, and JACK/PipeWire adapters are not complete.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Configurable capture and meter command/argument template/device/format/rate/channels | `crates/recorder-agent/src/config.rs`, `crates/recorder-agent/src/capture.rs`, `crates/recorder-agent/src/meter_command.rs`, `crates/recorder-agent/src/command_template.rs` |
| Generic capture and meter command arguments | `crates/recorder-agent/src/capture.rs`, `crates/recorder-agent/src/meter_command.rs`, `crates/recorder-agent/src/command_template.rs` |
| ALSA inventory parsing, `/proc/asound/pcm`, stream/hw-params metadata, sysfs serials | `crates/recorder-agent/src/inventory.rs` |
| Numeric and named ALSA capture-device inventory matching | `crates/recorder-agent/src/alsa_device.rs` |
| Runtime PipeWire/JACK availability reporting | `crates/recorder-agent/src/inventory.rs` |
| ALSA and synthetic meter frame generation | `crates/recorder-agent/src/telemetry.rs` |
| Channel-map render planning for generic capture inputs | `crates/recorder-agent/src/channel_map.rs` |
| Linux `snd-aloop` capture, meter, and render smoke tasks | `.mise.toml`, `scripts/alsa-loopback-smoke.sh`, `scripts/agent-loopback-meter-smoke.sh`, `scripts/alsa-loopback-render-smoke.sh` |
| Hardware-free job lifecycle, render, cache upload, and stop handling | `scripts/agent-fake-controller-smoke.mjs` |

`mise run devices:check-generic` validates this partial baseline, and `mise run check` runs it.
