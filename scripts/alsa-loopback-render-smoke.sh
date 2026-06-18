#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ALSA loopback render smoke testing only runs on Linux." >&2
  exit 1
fi

for tool in arecord speaker-test ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils and ffmpeg on the recorder node." >&2
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
raw_output="${RAKKR_LOOPBACK_RAW_OUTPUT:-/tmp/rakkr-loopback-raw.wav}"
rendered_output="${RAKKR_LOOPBACK_RENDERED_OUTPUT:-/tmp/rakkr-loopback-rendered.wav}"
render_filter="${RAKKR_LOOPBACK_RENDER_FILTER:-pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1}"
expected_channels="${RAKKR_LOOPBACK_EXPECTED_RENDER_CHANNELS:-2}"
min_max_volume_dbfs="${RAKKR_LOOPBACK_MIN_MAX_VOLUME_DBFS:--60}"

mkdir -p "$(dirname "$raw_output")" "$(dirname "$rendered_output")"

echo "Playing ${tone_hz} Hz into ${play_device}; recording ${capture_device} to ${raw_output}."
speaker-test \
  -D "$play_device" \
  -c "$channels" \
  -r "$rate" \
  -t sine \
  -f "$tone_hz" \
  >/tmp/rakkr-loopback-render-speaker-test.log 2>&1 &

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
  "$raw_output"

echo "Rendering ${raw_output} to ${rendered_output} with: ${render_filter}"
ffmpeg \
  -y \
  -hide_banner \
  -loglevel error \
  -i "$raw_output" \
  -filter_complex "$render_filter" \
  -ac "$expected_channels" \
  "$rendered_output"

rendered_channels="$(
  ffprobe \
    -v error \
    -select_streams a:0 \
    -show_entries stream=channels \
    -of default=noprint_wrappers=1:nokey=1 \
    "$rendered_output"
)"

if [[ "$rendered_channels" != "$expected_channels" ]]; then
  echo "Expected ${expected_channels} rendered channels, got ${rendered_channels}." >&2
  exit 1
fi

max_volume="$(
  ffmpeg -hide_banner -nostats -i "$rendered_output" -filter:a volumedetect -f null /dev/null 2>&1 |
    awk -F': ' '/max_volume/ { print $2; exit }'
)"

if [[ -z "$max_volume" || "$max_volume" == "-inf dB" ]]; then
  echo "Rendered output appears silent; no max_volume was reported." >&2
  exit 1
fi

max_volume_value="${max_volume% dB}"
if ! awk -v value="$max_volume_value" -v floor="$min_max_volume_dbfs" \
  'BEGIN { exit !(value > floor) }'; then
  echo "Rendered max volume ${max_volume} is not above ${min_max_volume_dbfs} dBFS." >&2
  exit 1
fi

echo
ls -lh "$raw_output" "$rendered_output"
echo
echo "Rendered output validated:"
echo "  channels=${rendered_channels}"
echo "  maxVolume=${max_volume}"
echo "  captureDevice=${capture_device}"
