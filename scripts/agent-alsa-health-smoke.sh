#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Agent ALSA health smoke testing only runs on Linux." >&2
  exit 1
fi

for tool in arecord python3 timeout; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'. Install alsa-utils, coreutils, and python3 on the recorder node." >&2
    exit 1
  fi
done

agent_binary="${RAKKR_AGENT_BINARY:-target/release/rakkr-recorder-agent}"
device="${RAKKR_ALSA_HEALTH_DEVICE:-${RAKKR_ALSA_CAPTURE_DEVICE:-default}}"
format="${RAKKR_ALSA_HEALTH_FORMAT:-${RAKKR_ALSA_CAPTURE_FORMAT:-S16_LE}}"
rate="${RAKKR_ALSA_HEALTH_RATE:-${RAKKR_ALSA_CAPTURE_RATE:-48000}}"
channels="${RAKKR_ALSA_HEALTH_CHANNELS:-${RAKKR_ALSA_CAPTURE_CHANNELS:-2}}"
meter_seconds="${RAKKR_ALSA_HEALTH_METER_SECONDS:-3}"
run_seconds="${RAKKR_ALSA_HEALTH_RUN_SECONDS:-8}"
heartbeat_seconds="${RAKKR_ALSA_HEALTH_HEARTBEAT_SECONDS:-1}"
expected_card="${RAKKR_ALSA_HEALTH_EXPECT_CARD:-${RAKKR_ALSA_CAPTURE_EXPECT_CARD:-}}"
expected_event="${RAKKR_ALSA_HEALTH_EXPECT_EVENT:-agent.meter.flatline}"
expected_severity="${RAKKR_ALSA_HEALTH_EXPECT_SEVERITY:-warning}"
work_dir="${RAKKR_ALSA_HEALTH_WORK_DIR:-/tmp/rakkr-alsa-health-smoke}"
label="${RAKKR_ALSA_HEALTH_SMOKE_LABEL:-ALSA health smoke}"

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

mkdir -p "$work_dir"
health_log="${work_dir}/health-events.jsonl"
agent_log="${work_dir}/agent.log"
state_file="${work_dir}/agent-state.json"
rm -f "$health_log" "$agent_log" "$state_file"

set +e
RAKKR_CAPTURE_DEVICE="$device" \
  RAKKR_CAPTURE_FORMAT="$format" \
  RAKKR_CAPTURE_SAMPLE_RATE="$rate" \
  RAKKR_CAPTURE_CHANNELS="$channels" \
  RAKKR_METER_BACKEND=alsa \
  RAKKR_METER_SAMPLE_SECONDS="$meter_seconds" \
  RAKKR_SYSTEM_HEALTH_ENABLED=false \
  timeout "${run_seconds}s" \
    "$agent_binary" \
      --agent-health-log-file "$health_log" \
      --agent-state-file "$state_file" \
      --heartbeat-seconds "$heartbeat_seconds" \
      >"$agent_log" 2>&1
agent_status=$?
set -e

if [[ "$agent_status" -ne 124 ]]; then
  echo "Agent health smoke exited before timeout with status ${agent_status}." >&2
  cat "$agent_log" >&2 || true
  exit 1
fi

RAKKR_ALSA_HEALTH_LOG="$health_log" \
RAKKR_ALSA_HEALTH_EXPECT_EVENT="$expected_event" \
RAKKR_ALSA_HEALTH_EXPECT_SEVERITY="$expected_severity" \
RAKKR_ALSA_HEALTH_LABEL="$label" \
  python3 <<'PY'
import json
import math
import os
import pathlib
import sys

path = pathlib.Path(os.environ["RAKKR_ALSA_HEALTH_LOG"])
expected_event = os.environ["RAKKR_ALSA_HEALTH_EXPECT_EVENT"]
expected_severity = os.environ["RAKKR_ALSA_HEALTH_EXPECT_SEVERITY"]
label = os.environ["RAKKR_ALSA_HEALTH_LABEL"]

events = []
errors = []

if not path.exists():
    errors.append(f"health log was not created: {path}")
else:
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as error:
            errors.append(f"health log line {line_number} was not valid JSON: {error}")

matched = [event for event in events if event.get("type") == expected_event]
if not matched:
    errors.append(f"expected health event {expected_event!r} was not written")
else:
    event = matched[0]
    details = event.get("details") or {}
    if event.get("severity") != expected_severity:
        errors.append(
            f"{expected_event} severity was {event.get('severity')!r}, expected {expected_severity!r}"
        )
    if not details.get("interfaceId"):
        errors.append(f"{expected_event} did not include details.interfaceId")
    if not details.get("nodeId"):
        errors.append(f"{expected_event} did not include details.nodeId")
    if expected_event == "agent.meter.flatline":
        max_rms = details.get("maxRmsDbfs")
        flatline_dbfs = details.get("flatlineDbfs")
        if not isinstance(max_rms, (int, float)) or not math.isfinite(max_rms):
            errors.append("flatline event did not include finite details.maxRmsDbfs")
        if not isinstance(flatline_dbfs, (int, float)) or not math.isfinite(flatline_dbfs):
            errors.append("flatline event did not include finite details.flatlineDbfs")
        if isinstance(max_rms, (int, float)) and isinstance(flatline_dbfs, (int, float)):
            if max_rms > flatline_dbfs:
                errors.append(
                    f"flatline maxRmsDbfs {max_rms} exceeded threshold {flatline_dbfs}"
                )

unexpected_meter_failures = {
    "agent.meter.capture_failed",
    "agent.meter.device_unavailable",
    "agent.meter.xrun",
}
seen_types = [event.get("type") for event in events]
unexpected = sorted(unexpected_meter_failures.intersection(seen_types))
if unexpected:
    errors.append(f"unexpected meter capture health event(s): {', '.join(unexpected)}")

summary = {
    "eventCount": len(events),
    "expectedEvent": expected_event,
    "matchedCount": len(matched),
    "seenTypes": seen_types,
}
print(json.dumps(summary, indent=2))

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)

print(f"{label} passed.")
PY
