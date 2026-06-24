#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Agent ALSA meter smoke testing only runs on Linux." >&2
  exit 1
fi

for tool in arecord python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils and python3 on the recorder node." >&2
    exit 1
  fi
done

agent_binary="${RAKKR_AGENT_BINARY:-target/release/rakkr-recorder-agent}"
device="${RAKKR_ALSA_METER_DEVICE:-${RAKKR_ALSA_CAPTURE_DEVICE:-default}}"
format="${RAKKR_ALSA_METER_FORMAT:-${RAKKR_ALSA_CAPTURE_FORMAT:-S16_LE}}"
rate="${RAKKR_ALSA_METER_RATE:-${RAKKR_ALSA_CAPTURE_RATE:-48000}}"
channels="${RAKKR_ALSA_METER_CHANNELS:-${RAKKR_ALSA_CAPTURE_CHANNELS:-2}}"
seconds="${RAKKR_ALSA_METER_SECONDS:-3}"
expected_card="${RAKKR_ALSA_METER_EXPECT_CARD:-${RAKKR_ALSA_CAPTURE_EXPECT_CARD:-}}"
output="${RAKKR_ALSA_METER_OUTPUT:-/tmp/rakkr-alsa-meter-smoke.json}"
label="${RAKKR_ALSA_METER_SMOKE_LABEL:-ALSA meter smoke}"
allow_clipping="${RAKKR_ALSA_METER_ALLOW_CLIPPING:-0}"

if [[ ! -x "$agent_binary" ]]; then
  echo "Rakkr agent binary is not executable: $agent_binary" >&2
  echo "Set RAKKR_AGENT_BINARY or build the agent first." >&2
  exit 1
fi

if [[ -n "$expected_card" ]] && ! arecord -l | grep -Eq "$expected_card"; then
  echo "Expected ALSA capture card matching '${expected_card}' was not found." >&2
  arecord -l >&2 || true
  exit 1
fi

mkdir -p "$(dirname "$output")"
rm -f "$output"

RAKKR_CAPTURE_DEVICE="$device" \
  RAKKR_CAPTURE_FORMAT="$format" \
  RAKKR_CAPTURE_SAMPLE_RATE="$rate" \
  RAKKR_CAPTURE_CHANNELS="$channels" \
  RAKKR_METER_BACKEND=alsa \
  RAKKR_METER_SAMPLE_SECONDS="$seconds" \
  "$agent_binary" --print-meter-frame >"$output"

RAKKR_ALSA_METER_OUTPUT="$output" \
RAKKR_ALSA_METER_CHANNELS="$channels" \
RAKKR_ALSA_METER_ALLOW_CLIPPING="$allow_clipping" \
RAKKR_ALSA_METER_LABEL="$label" \
  python3 <<'PY'
import json
import math
import os
import pathlib
import sys

path = pathlib.Path(os.environ["RAKKR_ALSA_METER_OUTPUT"])
expected_channels = int(os.environ["RAKKR_ALSA_METER_CHANNELS"])
allow_clipping = os.environ["RAKKR_ALSA_METER_ALLOW_CLIPPING"] == "1"
label = os.environ["RAKKR_ALSA_METER_LABEL"]
frame = json.loads(path.read_text(encoding="utf-8"))
levels = frame.get("levels", [])
errors = []

if len(levels) != expected_channels:
    errors.append(f"expected {expected_channels} meter channels, got {len(levels)}")

for index, level in enumerate(levels, start=1):
    if level.get("channelIndex") != index:
        errors.append(f"channel {index} had wrong channelIndex {level.get('channelIndex')}")
    for key in ["rmsDbfs", "peakDbfs"]:
        value = level.get(key)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            errors.append(f"channel {index} missing finite {key}")
    quality = level.get("quality") or {}
    for key in [
        "broadbandNoiseScore",
        "crestFactorDb",
        "estimatedSnrDb",
        "humScore",
        "intelligibilityScore",
        "noiseScore",
        "speechScore",
        "staticScore",
        "zeroCrossingRate",
    ]:
        value = quality.get(key)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            errors.append(f"channel {index} missing finite quality.{key}")

if not allow_clipping and any(level.get("clipping") for level in levels):
    errors.append("meter frame reported clipping")

summary = {
    "capturedAt": frame.get("capturedAt"),
    "channels": len(levels),
    "interfaceId": frame.get("interfaceId"),
    "maxPeakDbfs": max((level.get("peakDbfs", -160) for level in levels), default=None),
    "maxRmsDbfs": max((level.get("rmsDbfs", -160) for level in levels), default=None),
    "nodeId": frame.get("nodeId"),
}
print(json.dumps(summary, indent=2))

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)

print(f"{label} passed.")
PY
