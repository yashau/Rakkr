# Rakkr Recorder Agent

The recorder agent is the Linux node process responsible for audio inventory, capture pipelines, health events, local cache management, and controller communication.

Current capabilities:

- parses node/controller configuration;
- reports stable node identity fields;
- emits JSON inventory;
- captures and meters configurable inputs through the local command with optional argument templates for non-`arecord` tools;
- samples ALSA S16_LE PCM through `arecord` for live RMS/peak meter frames, with synthetic fallback for development hosts;
- polls controller node capacity and runs bounded simultaneous recording jobs with `--max-concurrent-recordings` as the local fallback;
- detects meter capture failure/recovery, device-unavailable/xrun failures, clipping, flatline, and suspicious same/inverted channel correlation transitions;
- samples disk pressure, Linux load average, and audio-backend availability transitions;
- writes a lifecycle-managed local JSONL health log with size-based retention and syncs node health events to the controller when a node token is configured;
- reports ALSA interfaces plus PipeWire/JACK command availability in runtime inventory while full non-ALSA capture adapters remain future work.

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
cargo run -p rakkr-recorder-agent -- --print-meter-frame
```

Useful health-log controls:

- `--agent-health-log-max-bytes` / `RAKKR_AGENT_HEALTH_LOG_MAX_BYTES`
- `--agent-health-log-retained-files` / `RAKKR_AGENT_HEALTH_LOG_RETAINED_FILES`

Useful recording controls:

- `--max-concurrent-recordings` / `RAKKR_MAX_CONCURRENT_RECORDINGS`
