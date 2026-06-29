---
title: Audio enhancement
description: In-process noise suppression (DeepFilterNet3 and RNNoise) and the configurable voice-enhancement chain applied to recordings, with raw audio always preserved.
sidebar:
  order: 6
---

# Audio enhancement

Rakkr can produce a noise-suppressed, level-normalized **enhanced** rendition of a
recording alongside the untouched **raw** master. Enhancement runs entirely
in-process on the recorder agent — no extra packages are deployed to nodes — using
two pure-Rust engines with embedded models:

- **DeepFilterNet3** (default) — a deep-learning denoiser, strongest on
  non-stationary noise (HVAC, crowd, handling).
- **RNNoise** — a lighter recurrent-network denoiser.

Both operate at 48 kHz. On a typical recorder node DeepFilterNet3 runs at roughly
12× real time and RNNoise far faster, so enhancement is comfortably cheaper than
real time.

## Raw is always preserved

Enhancement is an additional, switchable layer — never a replacement. The raw
capture is kept as the master so you can always reproduce exactly what the
microphones heard. DNN denoisers can occasionally alter content (suppress quiet
speech, smear overlapping talkers), so for a system of record the raw rendition is
the source of truth and the enhanced rendition is a convenience for intelligibility.

This is a data-integrity choice, not a legal one: applying a filter does not make a
recording inadmissible.

## The chain (configured per recording profile)

The enhancement chain lives on the **recording profile** (the preset/template), so
it is RBAC-gated and audited like any other settings change. Every stage is
independently toggleable with configurable parameters, applied in this order:

1. **High-pass** — remove rumble / HVAC / handling (default on, 80 Hz).
2. **Denoise** — DeepFilterNet3 or RNNoise (default on, DeepFilterNet3).
3. **De-esser** — tame sibilance (default off).
4. **Compressor** — even out speakers at different mic distances (default off).
5. **Loudness normalization** — EBU R128, so every recording sits at a consistent
   level (default on, −16 LUFS / −1.5 dBTP / 11 LRA).
6. **Low-pass** — optional high-frequency roll-off (default off).
7. **Noise gate** — optional, threshold in dB (default off).

`keepRaw` (default on) controls whether the raw master is uploaded alongside the
enhanced rendition. Edit all of this under **Settings → recording profile**.

v1 targets voice profiles (mono / stereo / mono-to-stereo-mix); the denoiser runs
on the channel-mapped mono signal.

## Playback: raw vs enhanced

When a recording has both renditions, the playback dock shows an **Enhanced / Raw**
toggle. Default playback is the enhanced rendition. The renditions are served by:

```text
GET /api/v1/recordings/:id/stream                  # default (enhanced if present)
GET /api/v1/recordings/:id/stream?rendition=raw    # raw master
GET /api/v1/recordings/:id/stream?rendition=enhanced
```

## Live listen: raw vs enhanced

The live listen monitor has the same **Raw / Enhanced** toggle. Switching it
restarts the monitor session with the chosen rendition; the controller serves the
matching chunk and the recorder agent only spends CPU denoising the live stream
**while a listener is actually requesting enhanced audio** (on-demand). When no one
is listening enhanced, the agent produces only the raw monitor chunk.

Because the agent learns of the request on its next controller config poll, enhanced
live audio appears a few seconds after you flip the toggle; until the first enhanced
chunk arrives the stream falls back to raw. Live enhancement always uses
DeepFilterNet3 and needs no per-node configuration — it is driven entirely by the
listener toggle.

## How it is produced

For each recording the agent renders the raw rendition as before, then — when the
profile enables enhancement — produces the enhanced rendition: ffmpeg channel-maps
and downmixes the raw capture to 48 kHz mono, the in-process denoiser cleans it, and
ffmpeg applies the enabled voice-chain filters and encodes to the profile codec. The
enhanced rendition is uploaded as the primary (`?rendition=enhanced`) and the raw
render as a supplementary master (`?rendition=raw`). Enhancement is best-effort: if
it fails, the recording still completes with the raw rendition.
