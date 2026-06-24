#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Agent loopback fixture smoke testing only runs on Linux." >&2
  exit 1
fi

for tool in aplay arecord ffmpeg ffprobe modprobe python3 awk; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils, ffmpeg, kmod, and python3 on the recorder node." >&2
    exit 1
  fi
done

agent_binary="${RAKKR_AGENT_BINARY:-target/release/rakkr-recorder-agent}"
fixture="${RAKKR_LOOPBACK_FIXTURE:-fixtures/audio/rakkr-golden-dialogue-clean.wav}"
work_dir="${RAKKR_LOOPBACK_WORK_DIR:-/tmp/rakkr-loopback-fixture-test}"
rate="${RAKKR_LOOPBACK_RATE:-48000}"
channels="${RAKKR_LOOPBACK_CHANNELS:-2}"
capture_seconds="${RAKKR_LOOPBACK_CAPTURE_SECONDS:-29}"
meter_seconds="${RAKKR_LOOPBACK_METER_SECONDS:-8}"
warmup_seconds="${RAKKR_LOOPBACK_WARMUP_SECONDS:-0.4}"

if [[ ! -x "$agent_binary" ]]; then
  echo "Rakkr agent binary is not executable: $agent_binary" >&2
  echo "Set RAKKR_AGENT_BINARY or build the agent first." >&2
  exit 1
fi

if [[ ! -f "$fixture" ]]; then
  echo "Loopback fixture is missing: $fixture" >&2
  exit 1
fi

if ! grep -q "^snd_aloop " /proc/modules 2>/dev/null; then
  substreams="${RAKKR_LOOPBACK_SUBSTREAMS:-8}"
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
clean_play="${work_dir}/clean-play.wav"
fault_play="${work_dir}/fault-clipped-noisy-play.wav"
clean_capture="${work_dir}/clean-capture.wav"
fault_capture="${work_dir}/fault-clipped-noisy-capture.wav"
clean_meter="${work_dir}/clean-meter.json"
fault_meter="${work_dir}/fault-clipped-noisy-meter.json"

mkdir -p "$work_dir"

ffmpeg \
  -y \
  -hide_banner \
  -loglevel error \
  -i "$fixture" \
  -ar "$rate" \
  -ac "$channels" \
  -sample_fmt s16 \
  "$clean_play"

ffmpeg \
  -y \
  -hide_banner \
  -loglevel error \
  -i "$clean_play" \
  -filter_complex "[0:a]volume=18dB[a];anoisesrc=color=white:amplitude=0.12:sample_rate=${rate}:duration=${capture_seconds}[n];[a][n]amix=inputs=2:duration=first:dropout_transition=0,volume=4dB" \
  -ar "$rate" \
  -ac "$channels" \
  -sample_fmt s16 \
  "$fault_play"

loop_capture() {
  local input="$1"
  local output="$2"

  rm -f "$output"
  timeout "$((capture_seconds + 12))s" \
    arecord \
      -D "$capture_device" \
      -f S16_LE \
      -r "$rate" \
      -c "$channels" \
      -d "$capture_seconds" \
      -t wav \
      "$output" \
      >"${work_dir}/arecord.log" 2>&1 &

  local recorder_pid=$!
  sleep "$warmup_seconds"
  timeout "$((capture_seconds + 8))s" aplay -D "$play_device" "$input" >"${work_dir}/aplay.log" 2>&1 || true
  wait "$recorder_pid"
}

loop_meter() {
  local input="$1"
  local output="$2"

  rm -f "$output"
  timeout "$((meter_seconds + 18))s" aplay -D "$play_device" "$input" >"${work_dir}/meter-aplay.log" 2>&1 &
  local player_pid=$!
  sleep "$warmup_seconds"

  RAKKR_CAPTURE_DEVICE="$capture_device" \
    RAKKR_CAPTURE_FORMAT=S16_LE \
    RAKKR_CAPTURE_SAMPLE_RATE="$rate" \
    RAKKR_CAPTURE_CHANNELS="$channels" \
    RAKKR_METER_BACKEND=alsa \
    RAKKR_METER_SAMPLE_SECONDS="$meter_seconds" \
    "$agent_binary" --print-meter-frame >"$output"

  wait "$player_pid" >/dev/null 2>&1 || true
}

loop_capture "$clean_play" "$clean_capture"
loop_capture "$fault_play" "$fault_capture"
loop_meter "$clean_play" "$clean_meter"
loop_meter "$fault_play" "$fault_meter"

RAKKR_LOOPBACK_WORK_DIR="$work_dir" python3 <<'PY'
import json
import os
import pathlib
import subprocess
import sys

work = pathlib.Path(os.environ["RAKKR_LOOPBACK_WORK_DIR"])


def ffprobe_duration(path):
    output = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    )
    return float(output.strip())


def volumedetect(path):
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-filter:a",
            "volumedetect",
            "-f",
            "null",
            "/dev/null",
        ],
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    values = {}

    for line in proc.stderr.splitlines():
        if "mean_volume:" in line:
            values["mean_volume"] = float(line.rsplit("mean_volume:", 1)[1].strip().split()[0])
        if "max_volume:" in line:
            values["max_volume"] = float(line.rsplit("max_volume:", 1)[1].strip().split()[0])

    return values


def meter(path):
    frame = json.loads(path.read_text())
    levels = frame["levels"]

    return {
        "channels": len(levels),
        "clipping": [level["clipping"] for level in levels],
        "peak_dbfs": [level["peakDbfs"] for level in levels],
        "rms_dbfs": [level["rmsDbfs"] for level in levels],
        "speech_score": [level.get("quality", {}).get("speechScore") for level in levels],
        "noise_score": [level.get("quality", {}).get("noiseScore") for level in levels],
        "broadband_noise_score": [
            level.get("quality", {}).get("broadbandNoiseScore") for level in levels
        ],
        "static_score": [level.get("quality", {}).get("staticScore") for level in levels],
    }


summary = {
    "clean_capture": {
        "duration": round(ffprobe_duration(work / "clean-capture.wav"), 3),
        **volumedetect(work / "clean-capture.wav"),
    },
    "fault_capture": {
        "duration": round(ffprobe_duration(work / "fault-clipped-noisy-capture.wav"), 3),
        **volumedetect(work / "fault-clipped-noisy-capture.wav"),
    },
    "clean_meter": meter(work / "clean-meter.json"),
    "fault_meter": meter(work / "fault-clipped-noisy-meter.json"),
}
print(json.dumps(summary, indent=2))

errors = []
if summary["clean_capture"]["duration"] < 25:
    errors.append("clean capture duration too short")
if summary["fault_capture"]["duration"] < 25:
    errors.append("fault capture duration too short")
if any(summary["clean_meter"]["clipping"]):
    errors.append("clean meter unexpectedly clipped")
if not any(summary["fault_meter"]["clipping"]):
    errors.append("fault meter did not detect clipping")
if max(summary["fault_meter"]["peak_dbfs"]) < -1.0:
    errors.append("fault peak did not reach clipping threshold")
if max(summary["clean_meter"]["peak_dbfs"]) >= -1.0:
    errors.append("clean peak is too close to clipping")

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)
PY

echo
echo "Loopback fixture smoke passed. Artifacts:"
ls -lh "$work_dir"
