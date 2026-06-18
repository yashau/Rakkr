# Rakkr Recorder Agent

The recorder agent is the Linux node process responsible for audio inventory, capture pipelines, health events, local cache management, and controller communication.

Current scaffold:

- parses node/controller configuration;
- reports stable node identity fields;
- emits JSON inventory;
- emits synthetic meter frames and posts them to the controller when a node token is configured;
- writes a lifecycle-managed local JSONL health log and syncs node health events to the controller;
- leaves audio backend implementation open for ALSA/JACK/PipeWire discovery.

```powershell
cargo run -p rakkr-recorder-agent -- --print-inventory
```
