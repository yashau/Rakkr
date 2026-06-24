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
expect_sync="${RAKKR_ALSA_HEALTH_EXPECT_SYNC:-0}"
work_dir="${RAKKR_ALSA_HEALTH_WORK_DIR:-/tmp/rakkr-alsa-health-smoke}"
label="${RAKKR_ALSA_HEALTH_SMOKE_LABEL:-ALSA health smoke}"
node_id="${RAKKR_ALSA_HEALTH_NODE_ID:-node_alsa_health_smoke}"
token="${RAKKR_ALSA_HEALTH_CONTROLLER_TOKEN:-alsa-health-smoke-token}"

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
controller_log="${work_dir}/controller.log"
controller_port_file="${work_dir}/controller-port.txt"
controller_script="${work_dir}/fake-controller.py"
controller_state_file="${work_dir}/controller-state.json"
rm -f "$health_log" "$agent_log" "$state_file" "$controller_log" "$controller_port_file" "$controller_script" "$controller_state_file"

controller_pid=""

cleanup() {
  if [[ -n "$controller_pid" ]] && kill -0 "$controller_pid" >/dev/null 2>&1; then
    kill "$controller_pid" >/dev/null 2>&1 || true
    wait "$controller_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

controller_args=()

if [[ "$expect_sync" == "1" ]]; then
  cat >"$controller_script" <<'PY'
import json
import os
import pathlib
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NODE_ID = os.environ["RAKKR_ALSA_HEALTH_NODE_ID"]
TOKEN = os.environ["RAKKR_ALSA_HEALTH_CONTROLLER_TOKEN"]
PORT_FILE = pathlib.Path(os.environ["RAKKR_ALSA_HEALTH_CONTROLLER_PORT_FILE"])
STATE_FILE = pathlib.Path(os.environ["RAKKR_ALSA_HEALTH_CONTROLLER_STATE_FILE"])

observed = {
    "claimNextReads": 0,
    "configReads": 0,
    "healthEvents": [],
    "meterFrames": 0,
    "nodeHeartbeats": 0,
}


def persist():
    STATE_FILE.write_text(json.dumps(observed, indent=2), encoding="utf-8")


def read_body(handler):
    length = int(handler.headers.get("content-length", "0") or "0")
    return handler.rfile.read(length) if length else b""


def send_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
    persist()


def send_empty(handler):
    handler.send_response(204)
    handler.send_header("content-length", "0")
    handler.end_headers()
    persist()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def authorized(self):
        if self.headers.get("authorization") == f"Bearer {TOKEN}":
            return True

        read_body(self)
        send_json(self, 401, {"error": "invalid token"})
        return False

    def do_GET(self):
        if not self.authorized():
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/config":
            observed["configReads"] += 1
            send_json(
                self,
                200,
                {
                    "data": {
                        "recordingCapacity": {"maxConcurrentRecordings": 1},
                        "recorderCachePolicies": [],
                    }
                },
            )
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/recording-jobs/next":
            send_empty(self)
            return

        send_json(self, 404, {"error": f"unexpected route GET {self.path}"})

    def do_POST(self):
        if not self.authorized():
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/health-events":
            event = json.loads(read_body(self).decode("utf-8"))
            observed["healthEvents"].append(event)
            send_json(self, 201, {"data": {"id": f"health_{len(observed['healthEvents'])}"}})
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/heartbeat":
            read_body(self)
            observed["nodeHeartbeats"] += 1
            send_json(self, 202, {"data": {"ok": True}})
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/meter-frame":
            read_body(self)
            observed["meterFrames"] += 1
            send_json(self, 202, {"data": {"ok": True}})
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/recording-jobs/claim-next":
            read_body(self)
            observed["claimNextReads"] += 1
            send_empty(self)
            return

        send_json(self, 404, {"error": f"unexpected route POST {self.path}"})


def stop(_signum, _frame):
    persist()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT_FILE.write_text(str(server.server_port), encoding="utf-8")
persist()
server.serve_forever()
PY

  RAKKR_ALSA_HEALTH_NODE_ID="$node_id" \
  RAKKR_ALSA_HEALTH_CONTROLLER_TOKEN="$token" \
  RAKKR_ALSA_HEALTH_CONTROLLER_PORT_FILE="$controller_port_file" \
  RAKKR_ALSA_HEALTH_CONTROLLER_STATE_FILE="$controller_state_file" \
    python3 "$controller_script" >"$controller_log" 2>&1 &
  controller_pid=$!

  for _ in $(seq 1 100); do
    if [[ -s "$controller_port_file" ]]; then
      break
    fi

    sleep 0.05
  done

  if [[ ! -s "$controller_port_file" ]]; then
    echo "Fake controller did not start." >&2
    cat "$controller_log" >&2 || true
    exit 1
  fi

  controller_port="$(cat "$controller_port_file")"
  controller_args=(
    --allow-insecure-controller
    --controller-token "$token"
    --controller-url "http://127.0.0.1:${controller_port}"
    --node-id "$node_id"
  )
fi

set +e
RAKKR_CAPTURE_DEVICE="$device" \
  RAKKR_CAPTURE_FORMAT="$format" \
  RAKKR_CAPTURE_SAMPLE_RATE="$rate" \
  RAKKR_CAPTURE_CHANNELS="$channels" \
  RAKKR_METER_BACKEND=alsa \
  RAKKR_METER_SAMPLE_SECONDS="$meter_seconds" \
  RAKKR_MONITOR_CHUNK_SYNC_ENABLED=false \
  RAKKR_SYSTEM_HEALTH_ENABLED=false \
  timeout "${run_seconds}s" \
    "$agent_binary" \
      --agent-health-log-file "$health_log" \
      --agent-state-file "$state_file" \
      --heartbeat-seconds "$heartbeat_seconds" \
      "${controller_args[@]}" \
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
RAKKR_ALSA_HEALTH_EXPECT_SYNC="$expect_sync" \
RAKKR_ALSA_HEALTH_CONTROLLER_STATE_FILE="$controller_state_file" \
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
expect_sync = os.environ.get("RAKKR_ALSA_HEALTH_EXPECT_SYNC") == "1"
controller_state_path = pathlib.Path(os.environ["RAKKR_ALSA_HEALTH_CONTROLLER_STATE_FILE"])

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
    if expected_event == "agent.meter.low_signal":
        max_rms = details.get("maxRmsDbfs")
        low_signal_dbfs = details.get("lowSignalDbfs")
        max_speech_score = details.get("maxSpeechScore")
        if not isinstance(max_rms, (int, float)) or not math.isfinite(max_rms):
            errors.append("low-signal event did not include finite details.maxRmsDbfs")
        if not isinstance(low_signal_dbfs, (int, float)) or not math.isfinite(low_signal_dbfs):
            errors.append("low-signal event did not include finite details.lowSignalDbfs")
        if not isinstance(max_speech_score, (int, float)) or not math.isfinite(max_speech_score):
            errors.append("low-signal event did not include finite details.maxSpeechScore")
        if isinstance(max_rms, (int, float)) and isinstance(low_signal_dbfs, (int, float)):
            if max_rms > low_signal_dbfs:
                errors.append(
                    f"low-signal maxRmsDbfs {max_rms} exceeded threshold {low_signal_dbfs}"
                )
        if "agent.meter.flatline" in [event.get("type") for event in events]:
            errors.append("low-signal smoke unexpectedly wrote agent.meter.flatline")

unexpected_meter_failures = {
    "agent.meter.capture_failed",
    "agent.meter.device_unavailable",
    "agent.meter.xrun",
}
seen_types = [event.get("type") for event in events]
unexpected = sorted(unexpected_meter_failures.intersection(seen_types))
if unexpected:
    errors.append(f"unexpected meter capture health event(s): {', '.join(unexpected)}")

synced_events = []
if expect_sync:
    if not controller_state_path.exists():
        errors.append(f"controller state was not created: {controller_state_path}")
    else:
        try:
            controller_state = json.loads(controller_state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            errors.append(f"controller state was not valid JSON: {error}")
            controller_state = {}

        synced_events = controller_state.get("healthEvents") or []
        synced_match = [event for event in synced_events if event.get("type") == expected_event]
        if not synced_match:
            errors.append(f"expected synced health event {expected_event!r} was not posted")
        else:
            synced_event = synced_match[0]
            synced_details = synced_event.get("details") or {}
            if synced_event.get("severity") != expected_severity:
                errors.append(
                    f"synced {expected_event} severity was {synced_event.get('severity')!r}, expected {expected_severity!r}"
                )
            if not synced_details.get("interfaceId"):
                errors.append(f"synced {expected_event} did not include details.interfaceId")
            if not synced_details.get("nodeId"):
                errors.append(f"synced {expected_event} did not include details.nodeId")

        if controller_state.get("nodeHeartbeats", 0) < 1:
            errors.append("fake controller did not observe a node heartbeat")
        if controller_state.get("meterFrames", 0) < 1:
            errors.append("fake controller did not observe a meter frame")

summary = {
    "eventCount": len(events),
    "expectedEvent": expected_event,
    "matchedCount": len(matched),
    "seenTypes": seen_types,
    "syncedEventCount": len(synced_events),
}
print(json.dumps(summary, indent=2))

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)

print(f"{label} passed.")
PY
