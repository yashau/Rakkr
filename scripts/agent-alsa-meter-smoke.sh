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
iterations="${RAKKR_ALSA_METER_ITERATIONS:-1}"
interval_seconds="${RAKKR_ALSA_METER_INTERVAL_SECONDS:-1}"
expected_card="${RAKKR_ALSA_METER_EXPECT_CARD:-${RAKKR_ALSA_CAPTURE_EXPECT_CARD:-}}"
output="${RAKKR_ALSA_METER_OUTPUT:-/tmp/rakkr-alsa-meter-smoke.json}"
label="${RAKKR_ALSA_METER_SMOKE_LABEL:-ALSA meter smoke}"
allow_clipping="${RAKKR_ALSA_METER_ALLOW_CLIPPING:-0}"

if [[ ! "$iterations" =~ ^[1-9][0-9]*$ ]]; then
  echo "RAKKR_ALSA_METER_ITERATIONS must be a positive integer." >&2
  exit 1
fi

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

frame_paths=()
if [[ "$iterations" -eq 1 ]]; then
  frame_paths+=("$output")
else
  frame_dir="${output%.json}-frames"
  rm -rf "$frame_dir"
  mkdir -p "$frame_dir"

  for ((iteration = 1; iteration <= iterations; iteration++)); do
    frame_paths+=("${frame_dir}/frame-${iteration}.json")
  done
fi

for ((iteration = 1; iteration <= iterations; iteration++)); do
  frame_output="${frame_paths[$((iteration - 1))]}"

  RAKKR_CAPTURE_DEVICE="$device" \
    RAKKR_CAPTURE_FORMAT="$format" \
    RAKKR_CAPTURE_SAMPLE_RATE="$rate" \
    RAKKR_CAPTURE_CHANNELS="$channels" \
    RAKKR_METER_BACKEND=alsa \
    RAKKR_METER_SAMPLE_SECONDS="$seconds" \
    "$agent_binary" --print-meter-frame >"$frame_output"

  if [[ "$iteration" -lt "$iterations" ]]; then
    sleep "$interval_seconds"
  fi
done

frame_path_list="$(
  IFS=:
  echo "${frame_paths[*]}"
)"

RAKKR_ALSA_METER_OUTPUT="$output" \
RAKKR_ALSA_METER_FRAME_PATHS="$frame_path_list" \
RAKKR_ALSA_METER_CHANNELS="$channels" \
RAKKR_ALSA_METER_ALLOW_CLIPPING="$allow_clipping" \
RAKKR_ALSA_METER_LABEL="$label" \
  python3 <<'PY'
import json
import math
import os
import pathlib
import sys

output_path = pathlib.Path(os.environ["RAKKR_ALSA_METER_OUTPUT"])
frame_paths = [
    pathlib.Path(path)
    for path in os.environ["RAKKR_ALSA_METER_FRAME_PATHS"].split(os.pathsep)
    if path
]
expected_channels = int(os.environ["RAKKR_ALSA_METER_CHANNELS"])
allow_clipping = os.environ["RAKKR_ALSA_METER_ALLOW_CLIPPING"] == "1"
label = os.environ["RAKKR_ALSA_METER_LABEL"]
errors = []
frames = []

for frame_path in frame_paths:
    frame = json.loads(frame_path.read_text(encoding="utf-8"))
    frame_errors = []
    levels = frame.get("levels", [])

    if len(levels) != expected_channels:
        frame_errors.append(f"expected {expected_channels} meter channels, got {len(levels)}")

    for index, level in enumerate(levels, start=1):
        if level.get("channelIndex") != index:
            frame_errors.append(
                f"channel {index} had wrong channelIndex {level.get('channelIndex')}"
            )
        for key in ["rmsDbfs", "peakDbfs"]:
            value = level.get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                frame_errors.append(f"channel {index} missing finite {key}")
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
                frame_errors.append(f"channel {index} missing finite quality.{key}")

    if not allow_clipping and any(level.get("clipping") for level in levels):
        frame_errors.append("meter frame reported clipping")

    if frame_errors:
        errors.extend(f"{frame_path}: {error}" for error in frame_errors)

    frames.append((frame_path, frame, levels))

interface_ids = {frame.get("interfaceId") for _, frame, _ in frames}
node_ids = {frame.get("nodeId") for _, frame, _ in frames}
if len(interface_ids) > 1:
    errors.append(
        "meter frames reported inconsistent interface IDs: "
        f"{sorted(str(value) for value in interface_ids)}"
    )
if len(node_ids) > 1:
    errors.append(
        "meter frames reported inconsistent node IDs: "
        f"{sorted(str(value) for value in node_ids)}"
    )

all_levels = [level for _, _, levels in frames for level in levels]

summary = {
    "channels": expected_channels,
    "firstCapturedAt": frames[0][1].get("capturedAt") if frames else None,
    "frameCount": len(frames),
    "framePaths": [str(path) for path, _, _ in frames],
    "interfaceId": frames[0][1].get("interfaceId") if frames else None,
    "lastCapturedAt": frames[-1][1].get("capturedAt") if frames else None,
    "maxPeakDbfs": max((level.get("peakDbfs", -160) for level in all_levels), default=None),
    "maxRmsDbfs": max((level.get("rmsDbfs", -160) for level in all_levels), default=None),
    "minPeakDbfs": min((level.get("peakDbfs", -160) for level in all_levels), default=None),
    "minRmsDbfs": min((level.get("rmsDbfs", -160) for level in all_levels), default=None),
    "nodeId": frames[0][1].get("nodeId") if frames else None,
}

if len(frames) > 1:
    output_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

print(json.dumps(summary, indent=2))

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)

print(f"{label} passed.")
PY
