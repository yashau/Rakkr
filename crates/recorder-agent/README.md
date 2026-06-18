# Rakkr Recorder Agent

The recorder agent is the Linux node process responsible for audio inventory, capture pipelines, health events, local cache management, and controller communication.

Current scaffold:

- parses node/controller configuration;
- reports stable node identity fields;
- emits JSON inventory;
- samples ALSA S16_LE PCM through `arecord` for live RMS/peak meter frames, with synthetic fallback for development hosts;
- detects meter capture failure/recovery, clipping, and flatline transitions;
- writes a lifecycle-managed local JSONL health log and syncs node health events to the controller when a node token is configured;
- leaves audio backend implementation open for ALSA/JACK/PipeWire discovery.

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
cargo run -p rakkr-recorder-agent -- --print-meter-frame
```
