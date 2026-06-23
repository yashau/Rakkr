#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ALSA capture smoke testing only runs on Linux." >&2
  exit 1
fi

for tool in arecord ffprobe awk stat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils, ffmpeg, and coreutils on the recorder node." >&2
    exit 1
  fi
done

device="${RAKKR_ALSA_CAPTURE_DEVICE:-default}"
format="${RAKKR_ALSA_CAPTURE_FORMAT:-S16_LE}"
rate="${RAKKR_ALSA_CAPTURE_RATE:-48000}"
channels="${RAKKR_ALSA_CAPTURE_CHANNELS:-2}"
seconds="${RAKKR_ALSA_CAPTURE_SECONDS:-2}"
output="${RAKKR_ALSA_CAPTURE_OUTPUT:-/tmp/rakkr-alsa-capture-smoke.wav}"
min_bytes="${RAKKR_ALSA_CAPTURE_MIN_BYTES:-128}"
expected_card="${RAKKR_ALSA_CAPTURE_EXPECT_CARD:-}"

if [[ -n "$expected_card" ]] && ! arecord -l | grep -Eq "$expected_card"; then
  echo "Expected ALSA capture card matching '${expected_card}' was not found." >&2
  arecord -l >&2 || true
  exit 1
fi

mkdir -p "$(dirname "$output")"
rm -f "$output"

echo "Recording ${seconds}s from ${device} (${channels}ch ${format} @ ${rate} Hz) to ${output}."
arecord \
  -D "$device" \
  -f "$format" \
  -r "$rate" \
  -c "$channels" \
  -d "$seconds" \
  -t wav \
  "$output"

size_bytes="$(stat -c '%s' "$output")"
if ! awk -v size="$size_bytes" -v min="$min_bytes" 'BEGIN { exit !(size >= min) }'; then
  echo "Capture output is too small: ${output} has ${size_bytes} bytes, expected at least ${min_bytes}." >&2
  exit 1
fi

probe_channels="$(
  ffprobe \
    -v error \
    -select_streams a:0 \
    -show_entries stream=channels \
    -of default=noprint_wrappers=1:nokey=1 \
    "$output"
)"
probe_rate="$(
  ffprobe \
    -v error \
    -select_streams a:0 \
    -show_entries stream=sample_rate \
    -of default=noprint_wrappers=1:nokey=1 \
    "$output"
)"
probe_duration="$(
  ffprobe \
    -v error \
    -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 \
    "$output"
)"

if [[ "$probe_channels" != "$channels" ]]; then
  echo "Expected ${channels} captured channels, got ${probe_channels}." >&2
  exit 1
fi

if [[ "$probe_rate" != "$rate" ]]; then
  echo "Expected ${rate} Hz capture rate, got ${probe_rate}." >&2
  exit 1
fi

min_duration="$(awk -v seconds="$seconds" 'BEGIN { value = seconds - 0.5; print value > 0 ? value : 0 }')"
if ! awk -v duration="$probe_duration" -v min="$min_duration" \
  'BEGIN { exit !(duration >= min) }'; then
  echo "Expected duration near ${seconds}s, got ${probe_duration}s." >&2
  exit 1
fi

echo
ls -lh "$output"
echo
echo "ALSA capture smoke passed:"
echo "  device=${device}"
echo "  channels=${probe_channels}"
echo "  sampleRate=${probe_rate}"
echo "  duration=${probe_duration}"
echo "  sizeBytes=${size_bytes}"
