---
title: Configure recording profiles
description: Create the encode presets — codec, quality, channel mode, and the voice-enhancement chain — that ad-hoc and scheduled recordings use.
sidebar:
  order: 13
---

# Configure recording profiles

A **recording profile** is the preset that decides how a capture is encoded and
enhanced. Operators pick a profile when they record; you define the profiles so
nobody sets codecs by hand.

> **Who can do this:** viewing needs `settings:read`; creating and editing need
> `settings:manage`.

## Where to find them

Open **Settings** in the left nav and scroll to **Recording Profiles**
(*"Central audio defaults and templates."*).

## Create or edit a profile

1. Click **New** (or the pencil on an existing profile).
2. Set the encode preset:
   - **Codec** — MP3, FLAC, or WAV.
   - **Bitrate** and **VBR** (for MP3).
   - **Channel mode**.
   - Optional **silence handling**.
   - **Maximum track length** — used to auto-split long scheduled captures into
     chunks.
3. Toggle **Enabled** so it's available to operators.
4. Save.

The built-in default is a voice MP3-VBR profile (~128 kbps). Defaults are
configuration, never hard-coded — so change them freely.

Use **Set default** on any profile to make it the one **pre-selected** in the
scheduling and ad-hoc recording forms; it then shows a **Default** badge. There
is one default per type, so setting a new one clears the previous.

## Voice enhancement

Each profile also carries a **voice-enhancement chain** that produces an
**enhanced** rendition alongside the always-preserved **raw** master. The stages,
applied in order, are each independently toggleable:

1. **High-pass** (default on, 80 Hz) — remove rumble/HVAC/handling.
2. **Denoise** (default on) — DeepFilterNet3 or RNNoise.
3. **De-esser** (default off) — tame sibilance.
4. **Compressor** (default off) — even out speakers at different distances.
5. **Loudness normalization** (default on, EBU R128) — consistent levels.
6. **Low-pass** (default off) — high-frequency roll-off.
7. **Noise gate** (default off).

`keepRaw` (default on) controls whether the raw master is uploaded alongside the
enhanced rendition. The raw capture is **always kept** as the source of truth.

## See also

- [Audio enhancement guide](../guides/audio-enhancement.md) — how the chain works and raw vs enhanced
- [Record a session](record-a-session.md) · [Schedule recordings](schedule-recordings.md) — where profiles are chosen
- [Set up storage & uploads](set-up-uploads.md) — where finished recordings go
