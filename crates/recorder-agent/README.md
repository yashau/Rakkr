# Rakkr Recorder Agent

The recorder agent is the Linux node process responsible for audio inventory, capture pipelines, health events, local cache management, and controller communication.

Current scaffold:

- parses node/controller configuration;
- reports stable node identity fields;
- emits JSON inventory;
- samples ALSA S16_LE PCM through `arecord` for live RMS/peak meter frames, with synthetic fallback for development hosts;
- detects meter capture failure/recovery, device-unavailable/xrun failures, clipping, and flatline transitions;
- samples disk pressure, Linux load average, and audio-backend availability transitions;
- writes a lifecycle-managed local JSONL health log with size-based retention and syncs node health events to the controller when a node token is configured;
- leaves audio backend implementation open for ALSA/JACK/PipeWire discovery.

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
cargo run -p rakkr-recorder-agent -- --print-meter-frame
```

Useful health-log controls:

- `--agent-health-log-max-bytes` / `RAKKR_AGENT_HEALTH_LOG_MAX_BYTES`
- `--agent-health-log-retained-files` / `RAKKR_AGENT_HEALTH_LOG_RETAINED_FILES`
