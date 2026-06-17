# Rakkr Recorder Agent

The recorder agent is the Linux node process responsible for audio inventory, capture pipelines, health events, local cache management, and controller communication.

Current scaffold:

- parses node/controller configuration;
- reports stable node identity fields;
- emits JSON inventory;
- emits synthetic meter frames for early controller integration;
- leaves audio backend implementation open for ALSA/JACK/PipeWire discovery.

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
```
