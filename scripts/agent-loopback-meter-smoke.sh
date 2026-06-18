#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Agent loopback meter smoke testing only runs on Linux." >&2
  exit 1
fi

agent_binary="${RAKKR_AGENT_BINARY:-target/release/rakkr-recorder-agent}"

if [[ ! -x "$agent_binary" ]]; then
  echo "Rakkr agent binary is not executable: $agent_binary" >&2
  echo "Set RAKKR_AGENT_BINARY or build the agent first." >&2
  exit 1
fi

for tool in arecord speaker-test modprobe awk; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils and kmod on the recorder node." >&2
    exit 1
  fi
done

substreams="${RAKKR_LOOPBACK_SUBSTREAMS:-8}"
if ! grep -q "^snd_aloop " /proc/modules 2>/dev/null; then
  modprobe snd-aloop "pcm_substreams=${substreams}"
fi

loopback_card="$(
  arecord -l |
    awk '/^card [0-9]+: Loopback / { gsub(":", "", $2); print $2; exit }'
)"

if [[ -z "$loopback_card" ]]; then
  echo "ALSA Loopback card was not found after loading snd-aloop." >&2
  exit 1
fi

play_device="${RAKKR_LOOPBACK_PLAY_DEVICE:-hw:${loopback_card},0,0}"
capture_device="${RAKKR_LOOPBACK_CAPTURE_DEVICE:-hw:${loopback_card},1,0}"
channels="${RAKKR_LOOPBACK_CHANNELS:-2}"
rate="${RAKKR_LOOPBACK_RATE:-48000}"
tone_hz="${RAKKR_LOOPBACK_TONE_HZ:-1000}"
warmup_seconds="${RAKKR_LOOPBACK_WARMUP_SECONDS:-1}"

echo "Playing ${tone_hz} Hz into ${play_device}; sampling Rakkr meter from ${capture_device}."
speaker-test \
  -D "$play_device" \
  -c "$channels" \
  -r "$rate" \
  -t sine \
  -f "$tone_hz" \
  >/tmp/rakkr-agent-loopback-speaker.log 2>&1 &

speaker_pid=$!
cleanup() {
  kill "$speaker_pid" >/dev/null 2>&1 || true
  wait "$speaker_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sleep "$warmup_seconds"

RAKKR_CAPTURE_DEVICE="$capture_device" \
  RAKKR_CAPTURE_FORMAT=S16_LE \
  RAKKR_CAPTURE_SAMPLE_RATE="$rate" \
  RAKKR_METER_BACKEND=alsa \
  RAKKR_METER_SAMPLE_SECONDS="${RAKKR_METER_SAMPLE_SECONDS:-1}" \
  "$agent_binary" --print-meter-frame
