# 🎙️ Rakkr Audio Fixtures

Curated audio sources for recorder-agent, loopback, and health-watchdog validation.

## ✨ Why This Exists

Rakkr needs repeatable "room-like" audio that can be replayed through Linux
loopback and then intentionally damaged. The clean fixture gives the agent a
human speech baseline; derived lanes prove the watchdog can score faults
without relying on an LLM.

## 📦 Fixture Catalog

| Fixture | Purpose |
| ------- | ------- |
| `rakkr-golden-dialogue-clean.wav` | Clean multi-speaker speech baseline for loopback and watchdog smokes |
| `rakkr-golden-dialogue-clean.mp3` | Compact listening/reference copy of the clean fixture |
| `rakkr-golden-dialogue-clean.json` | Generation and fixture metadata, excluding provider secrets |

## 🗣️ Golden Dialogue

`rakkr-golden-dialogue-clean.wav` is a clean, non-overlapping, multi-speaker speech fixture generated with the ElevenLabs text-to-speech API.

| Property | Value |
| -------- | ----- |
| Duration | About 28.3 seconds |
| Format | 48 kHz stereo PCM signed 16-bit WAV |
| Intended baseline | Audible speech, no clipping, no flatline, low hum/static/broadband-noise likelihood |

## 🧪 Fault Permutations

Use the clean WAV as the source for deterministic fault lanes:

| Fault Lane | What It Exercises |
| ---------- | ----------------- |
| Low-volume speech | Low-signal scoring and health events |
| Clipped speech | Peak/clipping detection |
| Hum/static/broadband noise | Quality anomaly scoring |
| Duplicated or inverted channels | Channel-correlation detection |
| Delayed-stereo healthy lane | Speech quality without false duplicated-channel positives |

The ALSA loopback fixture smoke derives the healthy and fault lanes from this source, replays them through loopback, and checks daemon health logs for clipping, low signal, and channel-correlation behavior.

## ✅ Current Validation Path

```powershell
mise run agent:loopback-fixture-smoke
mise run agent:loopback-job-smoke
```

The first smoke checks current-agent meter quality fields and fault events. The
second runs a full fake-controller job through ALSA loopback, uploads the
captured WAV, and validates recorder-cache cleanup health.

## 🧼 Handling

- Keep source fixtures small enough for normal repository use.
- Store generated metadata next to the audio fixture.
- Do not store API keys, provider credentials, or temporary generated secrets in this directory.
