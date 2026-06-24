#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Agent loopback job smoke testing only runs on Linux." >&2
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
work_dir="${RAKKR_LOOPBACK_WORK_DIR:-/tmp/rakkr-loopback-job-test}"
rate="${RAKKR_LOOPBACK_RATE:-48000}"
channels="${RAKKR_LOOPBACK_CHANNELS:-2}"
capture_seconds="${RAKKR_LOOPBACK_JOB_SECONDS:-8}"
warmup_seconds="${RAKKR_LOOPBACK_WARMUP_SECONDS:-0.4}"
node_id="${RAKKR_LOOPBACK_NODE_ID:-node_loopback_job_smoke}"
token="${RAKKR_LOOPBACK_TOKEN:-node-token}"
recording_id="rec_loopback_full_agent"
job_id="job_loopback_full_agent"
output_name="${recording_id}.wav"

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
play_file="${work_dir}/job-clean-play.wav"
controller_script="${work_dir}/loopback-controller.py"
controller_log="${work_dir}/controller.log"
port_file="${work_dir}/controller-port.txt"
state_file="${work_dir}/controller-state.json"
upload_file="${work_dir}/uploaded-${output_name}"
health_log="${work_dir}/agent-health-events.jsonl"
agent_state="${work_dir}/agent-state.json"
agent_log="${work_dir}/agent.log"
aplay_log="${work_dir}/aplay.log"

rm -rf "$work_dir"
mkdir -p "$work_dir"

ffmpeg \
  -y \
  -hide_banner \
  -loglevel error \
  -i "$fixture" \
  -filter_complex "[0:a]pan=mono|c0=0.5*c0+0.5*c1,asplit=2[left][right];[right]adelay=83[rightd];[left][rightd]join=inputs=2:channel_layout=stereo" \
  -ar "$rate" \
  -ac "$channels" \
  -sample_fmt s16 \
  "$play_file"

cat >"$controller_script" <<'PY'
import json
import os
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

NODE_ID = os.environ["RAKKR_LOOPBACK_NODE_ID"]
TOKEN = os.environ["RAKKR_LOOPBACK_TOKEN"]
JOB_ID = os.environ["RAKKR_LOOPBACK_JOB_ID"]
RECORDING_ID = os.environ["RAKKR_LOOPBACK_RECORDING_ID"]
OUTPUT_NAME = os.environ["RAKKR_LOOPBACK_OUTPUT_NAME"]
CAPTURE_DEVICE = os.environ["RAKKR_LOOPBACK_CAPTURE_DEVICE"]
CAPTURE_FORMAT = os.environ["RAKKR_LOOPBACK_CAPTURE_FORMAT"]
CAPTURE_RATE = int(os.environ["RAKKR_LOOPBACK_CAPTURE_RATE"])
CAPTURE_CHANNELS = int(os.environ["RAKKR_LOOPBACK_CAPTURE_CHANNELS"])
CAPTURE_SECONDS = int(os.environ["RAKKR_LOOPBACK_CAPTURE_SECONDS"])
PORT_FILE = Path(os.environ["RAKKR_LOOPBACK_PORT_FILE"])
STATE_FILE = Path(os.environ["RAKKR_LOOPBACK_STATE_FILE"])
UPLOAD_FILE = Path(os.environ["RAKKR_LOOPBACK_UPLOAD_FILE"])

job = {
    "command": {
        "captureBackend": "alsa",
        "captureChannels": CAPTURE_CHANNELS,
        "captureDevice": CAPTURE_DEVICE,
        "captureFormat": CAPTURE_FORMAT,
        "captureInterfaceId": None,
        "captureSampleRate": CAPTURE_RATE,
        "channelMap": None,
        "durationSeconds": CAPTURE_SECONDS,
        "outputBitrateKbps": None,
        "outputCodec": "wav",
        "outputFileName": OUTPUT_NAME,
        "outputVbr": False,
        "recorderCacheRetention": {
            "deleteAfterUpload": True,
            "maxAgeDays": None,
            "maxBytes": None,
            "minFreeDiskPercent": None,
            "policyId": "retention-loopback-job-smoke",
        },
        "trackGroupId": None,
        "trackIndex": None,
        "trackTotal": None,
    },
    "failureReason": None,
    "id": JOB_ID,
    "nodeId": NODE_ID,
    "recordingId": RECORDING_ID,
    "status": "queued",
}
observed = {
    "cacheUploads": [],
    "channelMapReads": 0,
    "claimNextReads": 0,
    "claims": 0,
    "failures": 0,
    "healthEvents": [],
    "heartbeats": 0,
    "jobStatusReads": 0,
}


def persist():
    STATE_FILE.write_text(
        json.dumps({"job": job, "observed": observed}, indent=2),
        encoding="utf-8",
    )


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

        if self.path == f"/api/v1/nodes/{NODE_ID}/recording-jobs/next":
            send_json(self, 200, {"data": job}) if job["status"] == "queued" else send_empty(self)
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/channel-map-assignments":
            observed["channelMapReads"] += 1
            send_json(self, 200, {"data": []})
            return

        if self.path == f"/api/v1/recording-jobs/{JOB_ID}":
            observed["jobStatusReads"] += 1
            send_json(self, 200, {"data": job})
            return

        send_json(self, 404, {"error": f"unexpected route GET {self.path}"})

    def do_POST(self):
        if not self.authorized():
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/recording-jobs/claim-next":
            observed["claimNextReads"] += 1
            if job["status"] != "queued":
                send_empty(self)
                return

            observed["claims"] += 1
            job["status"] = "running"
            send_json(self, 200, {"data": job})
            return

        if self.path == f"/api/v1/recording-jobs/{JOB_ID}/heartbeat":
            read_body(self)
            observed["heartbeats"] += 1
            send_json(self, 200, {"data": job})
            return

        if self.path == f"/api/v1/recording-jobs/{JOB_ID}/failed":
            read_body(self)
            observed["failures"] += 1
            job["failureReason"] = self.headers.get("x-rakkr-reason")
            job["status"] = "failed"
            send_json(self, 200, {"data": job})
            return

        if self.path == f"/api/v1/nodes/{NODE_ID}/health-events":
            event = json.loads(read_body(self).decode("utf-8"))
            observed["healthEvents"].append(event)
            send_json(self, 201, {"data": {"id": f"health_{len(observed['healthEvents'])}"}})
            return

        send_json(self, 404, {"error": f"unexpected route POST {self.path}"})

    def do_PUT(self):
        if not self.authorized():
            return

        if self.path == f"/api/v1/recordings/{RECORDING_ID}/cache-file":
            body = read_body(self)
            UPLOAD_FILE.write_bytes(body)
            observed["cacheUploads"].append(
                {
                    "contentType": self.headers.get("content-type"),
                    "durationSeconds": self.headers.get("x-rakkr-duration-seconds"),
                    "fileName": self.headers.get("x-rakkr-file-name"),
                    "jobId": self.headers.get("x-rakkr-recording-job-id"),
                    "recordingId": RECORDING_ID,
                    "size": len(body),
                }
            )
            job["status"] = "completed"
            send_json(self, 201, {"data": {"ok": True}})
            return

        send_json(self, 404, {"error": f"unexpected route PUT {self.path}"})


def stop(_signum, _frame):
    persist()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT_FILE.write_text(str(server.server_port), encoding="utf-8")
persist()
server.serve_forever()
PY

RAKKR_LOOPBACK_NODE_ID="$node_id" \
RAKKR_LOOPBACK_TOKEN="$token" \
RAKKR_LOOPBACK_JOB_ID="$job_id" \
RAKKR_LOOPBACK_RECORDING_ID="$recording_id" \
RAKKR_LOOPBACK_OUTPUT_NAME="$output_name" \
RAKKR_LOOPBACK_CAPTURE_DEVICE="$capture_device" \
RAKKR_LOOPBACK_CAPTURE_FORMAT=S16_LE \
RAKKR_LOOPBACK_CAPTURE_RATE="$rate" \
RAKKR_LOOPBACK_CAPTURE_CHANNELS="$channels" \
RAKKR_LOOPBACK_CAPTURE_SECONDS="$capture_seconds" \
RAKKR_LOOPBACK_PORT_FILE="$port_file" \
RAKKR_LOOPBACK_STATE_FILE="$state_file" \
RAKKR_LOOPBACK_UPLOAD_FILE="$upload_file" \
  python3 "$controller_script" >"$controller_log" 2>&1 &
controller_pid=$!

cleanup() {
  if kill -0 "$controller_pid" >/dev/null 2>&1; then
    kill "$controller_pid" >/dev/null 2>&1 || true
    wait "$controller_pid" >/dev/null 2>&1 || true
  fi

  if [[ -n "${player_pid:-}" ]] && kill -0 "$player_pid" >/dev/null 2>&1; then
    kill "$player_pid" >/dev/null 2>&1 || true
    wait "$player_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  if [[ -s "$port_file" ]]; then
    break
  fi

  sleep 0.05
done

if [[ ! -s "$port_file" ]]; then
  echo "Fake controller did not start." >&2
  cat "$controller_log" >&2 || true
  exit 1
fi

port="$(cat "$port_file")"

timeout "$((capture_seconds + 18))s" aplay -D "$play_device" "$play_file" >"$aplay_log" 2>&1 &
player_pid=$!
sleep "$warmup_seconds"

set +e
timeout "$((capture_seconds + 30))s" \
  "$agent_binary" \
    --allow-insecure-controller \
    --agent-health-log-file "$health_log" \
    --agent-state-file "$agent_state" \
    --capture-command arecord \
    --capture-growth-grace-seconds 0 \
    --capture-min-output-bytes 1024 \
    --controller-token "$token" \
    --controller-url "http://127.0.0.1:${port}" \
    --channel-render-command ffmpeg \
    --job-poll-seconds 1 \
    --node-id "$node_id" \
    --run-next-job \
    >"$agent_log" 2>&1
agent_status=$?
set -e

wait "$player_pid" >/dev/null 2>&1 || true

if [[ "$agent_status" -ne 0 ]]; then
  echo "Loopback full-agent job failed with status ${agent_status}." >&2
  cat "$agent_log" >&2 || true
  exit 1
fi

RAKKR_LOOPBACK_WORK_DIR="$work_dir" python3 <<'PY'
import json
import os
import pathlib
import subprocess
import sys

work = pathlib.Path(os.environ["RAKKR_LOOPBACK_WORK_DIR"])
capture_seconds = int(os.environ.get("RAKKR_LOOPBACK_JOB_SECONDS", "8"))
state = json.loads((work / "controller-state.json").read_text())
agent_state = json.loads((work / "agent-state.json").read_text())
health_events = [
    json.loads(line)
    for line in (work / "agent-health-events.jsonl").read_text().splitlines()
    if line.strip()
]
upload = work / "uploaded-rec_loopback_full_agent.wav"
errors = []

observed = state["observed"]
job = state["job"]
uploads = observed["cacheUploads"]

if job["status"] != "completed":
    errors.append(f"job did not complete: {job['status']}")
if agent_state.get("status") != "completed":
    errors.append(f"agent state did not complete: {agent_state.get('status')}")
if observed["claimNextReads"] != 1 or observed["claims"] != 1:
    errors.append("agent did not claim exactly one loopback job")
if observed["heartbeats"] < 1:
    errors.append("agent did not heartbeat during loopback capture")
if observed["jobStatusReads"] < 1:
    errors.append("agent did not poll loopback job status")
if observed["channelMapReads"] != 1:
    errors.append("agent did not fetch channel-map assignments")
if len(uploads) != 1:
    errors.append("agent did not upload exactly one cache file")
else:
    uploaded = uploads[0]
    if uploaded["contentType"] != "audio/wav":
        errors.append(f"cache upload was not audio/wav: {uploaded['contentType']}")
    if uploaded["durationSeconds"] != str(capture_seconds):
        errors.append(f"cache upload duration header was wrong: {uploaded['durationSeconds']}")
    if uploaded["fileName"] != "rec_loopback_full_agent.wav":
        errors.append(f"cache upload file name was wrong: {uploaded['fileName']}")
    if uploaded["jobId"] != "job_loopback_full_agent":
        errors.append(f"cache upload job id was wrong: {uploaded['jobId']}")
    if uploaded["size"] <= 1024:
        errors.append("cache upload body was too small")
if not any(event["type"] == "agent.recording_job.recorder_cache_deleted" for event in health_events):
    errors.append("agent health log did not record recorder-cache deletion")
if any(event["severity"] == "critical" for event in health_events):
    errors.append("agent health log recorded a critical event")
if not upload.exists():
    errors.append("fake controller did not save uploaded WAV")

if upload.exists():
    ffprobe = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=channels,sample_rate:format=duration",
            "-of",
            "json",
            str(upload),
        ],
        text=True,
    )
    metadata = json.loads(ffprobe)
    stream = metadata["streams"][0]
    duration = float(metadata["format"]["duration"])
    if duration < capture_seconds - 0.5:
        errors.append(f"uploaded WAV duration too short: {duration}")
    if int(stream["channels"]) != 2:
        errors.append(f"uploaded WAV channel count was wrong: {stream['channels']}")
    if int(stream["sample_rate"]) != 48000:
        errors.append(f"uploaded WAV sample rate was wrong: {stream['sample_rate']}")

    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(upload),
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
    mean_volume = None
    max_volume = None
    for line in proc.stderr.splitlines():
        if "mean_volume:" in line:
            mean_volume = float(line.rsplit("mean_volume:", 1)[1].strip().split()[0])
        if "max_volume:" in line:
            max_volume = float(line.rsplit("max_volume:", 1)[1].strip().split()[0])
    if mean_volume is None or mean_volume < -45:
        errors.append(f"uploaded WAV mean volume was too quiet: {mean_volume}")
    if max_volume is None or max_volume < -20:
        errors.append(f"uploaded WAV max volume was too quiet: {max_volume}")

summary = {
    "agent_state": agent_state.get("status"),
    "cache_upload": uploads[0] if uploads else None,
    "health_events": [event["type"] for event in health_events],
    "job_status": job["status"],
    "observed": observed,
}
print(json.dumps(summary, indent=2))

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)
PY

echo
echo "Loopback full-agent job smoke passed. Artifacts:"
ls -lh "$work_dir"
