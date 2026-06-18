#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ALSA loopback smoke testing only runs on Linux." >&2
  exit 1
fi

for tool in arecord speaker-test; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils on the recorder node." >&2
    exit 1
  fi
done

load_module() {
  if grep -q "^snd_aloop " /proc/modules 2>/dev/null; then
    return
  fi

  local substreams="${RAKKR_LOOPBACK_SUBSTREAMS:-8}"
  if [[ "$(id -u)" -eq 0 ]]; then
    modprobe snd-aloop "pcm_substreams=${substreams}"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo modprobe snd-aloop "pcm_substreams=${substreams}"
    return
  fi

  echo "snd-aloop is not loaded and sudo is unavailable. Run as root or load it manually:" >&2
  echo "  modprobe snd-aloop pcm_substreams=${substreams}" >&2
  exit 1
}

if [[ "${RAKKR_LOOPBACK_LOAD_MODULE:-1}" == "1" ]]; then
  load_module
fi

loopback_card="$(
  arecord -l |
    awk '/^card [0-9]+: Loopback / { gsub(":", "", $2); print $2; exit }'
)"
default_play_device="hw:Loopback,0,0"
default_capture_device="hw:Loopback,1,0"

if [[ -n "$loopback_card" ]]; then
  default_play_device="hw:${loopback_card},0,0"
  default_capture_device="hw:${loopback_card},1,0"
fi

play_device="${RAKKR_LOOPBACK_PLAY_DEVICE:-$default_play_device}"
capture_device="${RAKKR_LOOPBACK_CAPTURE_DEVICE:-$default_capture_device}"
channels="${RAKKR_LOOPBACK_CHANNELS:-2}"
rate="${RAKKR_LOOPBACK_RATE:-48000}"
seconds="${RAKKR_LOOPBACK_SECONDS:-5}"
tone_hz="${RAKKR_LOOPBACK_TONE_HZ:-1000}"
warmup_seconds="${RAKKR_LOOPBACK_WARMUP_SECONDS:-1}"
output="${RAKKR_LOOPBACK_OUTPUT:-/tmp/rakkr-loopback-test.wav}"

mkdir -p "$(dirname "$output")"

echo "Playing ${tone_hz} Hz into ${play_device}; recording ${capture_device} to ${output}."
speaker-test \
  -D "$play_device" \
  -c "$channels" \
  -r "$rate" \
  -t sine \
  -f "$tone_hz" \
  >/tmp/rakkr-loopback-speaker-test.log 2>&1 &

speaker_pid=$!
cleanup() {
  kill "$speaker_pid" >/dev/null 2>&1 || true
  wait "$speaker_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sleep "$warmup_seconds"

arecord \
  -D "$capture_device" \
  -f S16_LE \
  -r "$rate" \
  -c "$channels" \
  -d "$seconds" \
  -t wav \
  "$output"

echo
ls -lh "$output"
echo
echo "Rakkr agent meter settings for this fake capture interface:"
echo "  RAKKR_CAPTURE_DEVICE=${capture_device}"
echo "  RAKKR_CAPTURE_CHANNELS=${channels}"
echo "  RAKKR_CAPTURE_SAMPLE_RATE=${rate}"
echo "  RAKKR_CAPTURE_FORMAT=S16_LE"
echo "  RAKKR_METER_BACKEND=alsa"
