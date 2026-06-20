# Rakkr Generic Device Baseline

Status: Partial baseline checked.

## Behavior

- X32 Rack is only the first test fixture; recorder nodes target generic Linux audio interfaces.
- ALSA is the default capture and meter backend; PipeWire and JACK have first-class command presets for capture jobs and idle metering.
- Capture and meter sampling are configured by command, optional argument templates, device, format, sample rate, channel count, duration, and output path/stdout.
- Agent capture and meter paths use `arecord` with configurable devices such as `default`, `hw:2,0`, `plughw:2,0`, `hw:CARD=Loopback,DEV=1`, or loopback devices.
- Capture and meter argument templates can target non-`arecord` tools with placeholders for device, format, sample rate, channels, duration, and output target while the default path keeps `arecord` arguments.
- PipeWire capture and meter presets use `pw-record`-style arguments, sample-count bounded reads, and PipeWire sample-format mapping while preserving template overrides.
- JACK capture and meter presets use `jack_capture` duration-bounded file capture and raw stdout metering, with optional JACK port targeting while preserving template overrides.
- Capture and meter template CLI flags accept hyphen-leading template values.
- Controller-managed node audio defaults can set capture backend, capture command, capture device, format, sample rate, channel count, and capture/meter argument templates; ad-hoc and scheduled jobs inherit the node defaults.
- Fake-controller smoke coverage exercises template-driven capture arguments through agent job claim, capture, render, cache attach, and cleanup.
- Fake-controller smoke coverage exercises template-driven meter arguments through daemon meter frames and monitor chunks.
- Inventory discovers ALSA capture devices from `arecord -l` and `/proc/asound/pcm`, then adds channel count, sample rates, sysfs hardware paths, and serials when available.
- When `/proc/asound/card*/stream0` lacks capture capability details, inventory falls back to `arecord --dump-hw-params` for ALSA channel and sample-rate metadata.
- Meter target selection maps numeric, named, and `CARD=`/`DEV=` `hw:`/`plughw:` ALSA capture devices, including `hw:Loopback,1,0`, to collected inventory interfaces when possible.
- Runtime inventory reports detected PipeWire and JACK command availability alongside collected audio interface backends; PipeWire and JACK can be selected as managed capture/meter backends.
- Synthetic meters and fake-controller capture/render smoke tests validate agent workflows, including template-driven capture arguments, without hardware.
- Linux `snd-aloop` smoke tasks can validate WAV capture, agent meters, and render/channel-map output on a recorder node.
- Remaining gaps: Linux loopback smoke execution on a recorder node, physical X32 validation, and broader physical-device validation are not complete.

## Checked By

| Check | Evidence |
| ----- | -------- |
| Configurable capture and meter command/argument template/device/format/rate/channels | `crates/recorder-agent/src/config.rs`, `crates/recorder-agent/src/capture.rs`, `crates/recorder-agent/src/meter_command.rs`, `crates/recorder-agent/src/command_template.rs` |
| Controller-managed node audio defaults and managed backend selection | `packages/shared/src/index.ts`, `apps/api/src/node-store.ts`, `apps/api/src/node-routes.ts`, `apps/api/src/agent-node-config-route.ts`, `apps/api/src/recording-job-targets.ts`, `apps/api/src/recording-jobs.ts`, `apps/api/test/recording-jobs.test.ts`, `apps/api/test/node-routes.test.ts`, `apps/api/test/agent-routes.test.ts`, `apps/web/src/components/node-inventory-editors.tsx`, `crates/recorder-agent/src/node_config.rs`, `crates/recorder-agent/src/main.rs` |
| Generic capture and meter command arguments | `crates/recorder-agent/src/capture.rs`, `crates/recorder-agent/src/meter_command.rs`, `crates/recorder-agent/src/command_template.rs` |
| PipeWire and JACK capture and meter command presets | `crates/recorder-agent/src/config.rs`, `crates/recorder-agent/src/capture.rs`, `crates/recorder-agent/src/meter_command.rs`, `crates/recorder-agent/src/channel_map.rs`, `crates/recorder-agent/src/node_config.rs` |
| ALSA inventory parsing, `/proc/asound/pcm`, stream/hw-params metadata, sysfs serials | `crates/recorder-agent/src/inventory.rs` |
| Numeric and named ALSA capture-device inventory matching | `crates/recorder-agent/src/alsa_device.rs` |
| Runtime PipeWire/JACK availability reporting | `crates/recorder-agent/src/inventory.rs` |
| ALSA and synthetic meter frame generation | `crates/recorder-agent/src/telemetry.rs` |
| Channel-map render planning for generic capture inputs | `crates/recorder-agent/src/channel_map.rs` |
| Linux `snd-aloop` capture, meter, and render smoke tasks | `.mise.toml`, `scripts/alsa-loopback-smoke.sh`, `scripts/agent-loopback-meter-smoke.sh`, `scripts/alsa-loopback-render-smoke.sh` |
| Hardware-free job lifecycle, render, cache upload, stop handling, and template meter sampling | `scripts/agent-fake-controller-smoke.mjs`, `scripts/agent-fake-controller-smoke-devices.mjs` |

`mise run devices:check-generic` validates this partial baseline, and `mise run check` runs it.
