# Rakkr Audio Fixtures

This directory contains reusable audio sources for recorder-agent and watchdog validation.

## Golden Dialogue Fixture

`rakkr-golden-dialogue-clean.wav` is a clean, non-overlapping, multi-speaker speech fixture generated with the ElevenLabs text-to-speech API.

- Duration: about 28.3 seconds
- Format: 48 kHz stereo PCM signed 16-bit WAV
- Companion MP3: `rakkr-golden-dialogue-clean.mp3`
- Metadata: `rakkr-golden-dialogue-clean.json`
- Intended baseline: audible speech, no clipping, no flatline, low hum/static/broadband-noise likelihood

Use this file as the source for deterministic fault permutations such as low-volume speech, clipped speech, hum, static, broadband noise, and duplicated/inverted channels. Do not store API keys or provider credentials in this directory.
