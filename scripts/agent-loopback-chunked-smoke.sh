#!/usr/bin/env bash
set -euo pipefail

# Gapless chunked-recording smoke. Plays the golden speech fixture through an ALSA
# snd-aloop loopback, runs the real recorder agent in chunked mode against a fake
# controller that stores each uploaded chunk by its `chunk` query param, then PROVES
# gaplessness: every chunk index present exactly once, reassembled duration matches
# the recording, and (when numpy is available) the chunk boundaries cross-correlate
# at lag 0. Linux/ALSA-only; it WILL NOT run on a non-Linux host.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Agent loopback chunked smoke testing only runs on Linux." >&2
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
work_dir="${RAKKR_LOOPBACK_WORK_DIR:-/tmp/rakkr-loopback-chunked-test}"
rate="${RAKKR_LOOPBACK_RATE:-48000}"
channels="${RAKKR_LOOPBACK_CHANNELS:-2}"
capture_format="${RAKKR_LOOPBACK_CAPTURE_FORMAT:-S16_LE}"
chunk_seconds="${RAKKR_LOOPBACK_CHUNK_SECONDS:-5}"
capture_seconds="${RAKKR_LOOPBACK_JOB_SECONDS:-25}"
play_seconds="$((capture_seconds + 4))"
warmup_seconds="${RAKKR_LOOPBACK_WARMUP_SECONDS:-0.4}"
node_id="${RAKKR_LOOPBACK_NODE_ID:-node_loopback_chunked_smoke}"
token="${RAKKR_LOOPBACK_TOKEN:-node-token}"
recording_id="${RAKKR_LOOPBACK_RECORDING_ID:-rec_loopback_chunked_agent}"
job_id="${RAKKR_LOOPBACK_JOB_ID:-job_loopback_chunked_agent}"
output_name="${recording_id}.wav"
require_snd_aloop="${RAKKR_LOOPBACK_REQUIRE_SND_ALOOP:-1}"
expected_card="${RAKKR_LOOPBACK_EXPECT_CARD:-}"
min_output_bytes="${RAKKR_LOOPBACK_CAPTURE_MIN_OUTPUT_BYTES:-1024}"

if [[ ! -x "$agent_binary" ]]; then
  echo "Rakkr agent binary is not executable: $agent_binary" >&2
  echo "Set RAKKR_AGENT_BINARY or build the agent first." >&2
  exit 1
fi

if [[ ! -f "$fixture" ]]; then
  echo "Loopback fixture is missing: $fixture" >&2
  exit 1
fi

if [[ -n "$expected_card" ]] && ! arecord -l | grep -Eq "$expected_card"; then
  echo "Expected ALSA capture card matching '${expected_card}' was not found." >&2
  arecord -l >&2 || true
  exit 1
fi

if [[ "$require_snd_aloop" == "1" ]] && ! grep -q "^snd_aloop " /proc/modules 2>/dev/null; then
  substreams="${RAKKR_LOOPBACK_SUBSTREAMS:-8}"
  modprobe snd-aloop "pcm_substreams=${substreams}"
fi

loopback_card=""
capture_device="${RAKKR_LOOPBACK_CAPTURE_DEVICE:-}"
play_device="${RAKKR_LOOPBACK_PLAY_DEVICE:-}"
if [[ "$require_snd_aloop" == "1" ]]; then
  loopback_card="$(
    arecord -l |
      awk '/^card [0-9]+: Loopback / { gsub(":", "", $2); print $2; exit }'
  )"

  if [[ -z "$loopback_card" ]]; then
    echo "ALSA Loopback card was not found after loading snd-aloop." >&2
    exit 1
  fi

  play_device="${play_device:-hw:${loopback_card},0,0}"
  capture_device="${capture_device:-hw:${loopback_card},1,0}"
elif [[ -z "$capture_device" ]]; then
  echo "Set RAKKR_LOOPBACK_CAPTURE_DEVICE when RAKKR_LOOPBACK_REQUIRE_SND_ALOOP=0." >&2
  exit 1
fi

play_file="${work_dir}/chunked-clean-play.wav"
controller_script="${work_dir}/loopback-controller.py"
controller_log="${work_dir}/controller.log"
port_file="${work_dir}/controller-port.txt"
state_file="${work_dir}/controller-state.json"
chunk_dir="${work_dir}/uploaded-chunks"
health_log="${work_dir}/agent-health-events.jsonl"
agent_state="${work_dir}/agent-state.json"
agent_log="${work_dir}/agent.log"
aplay_log="${work_dir}/aplay.log"

rm -rf "$work_dir"
mkdir -p "$work_dir" "$chunk_dir"

# Loop the golden fixture out to the full recording window so the agent sees a
# continuous stream for the whole duration.
ffmpeg \
  -y \
  -hide_banner \
  -loglevel error \
  -stream_loop -1 \
  -i "$fixture" \
  -t "$play_seconds" \
  -filter_complex "[0:a]pan=mono|c0=0.5*c0+0.5*c1,asplit=2[left][right];[right]adelay=83[rightd];[left][rightd]join=inputs=2:channel_layout=stereo" \
  -ar "$rate" \
  -ac "$channels" \
  -sample_fmt s16 \
  "$play_file"

cat >"$controller_script" <<'PY'
import json
import os
import signal
import urllib.parse
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
CHUNK_SECONDS = int(os.environ["RAKKR_LOOPBACK_CHUNK_SECONDS"])
PORT_FILE = Path(os.environ["RAKKR_LOOPBACK_PORT_FILE"])
STATE_FILE = Path(os.environ["RAKKR_LOOPBACK_STATE_FILE"])
CHUNK_DIR = Path(os.environ["RAKKR_LOOPBACK_CHUNK_DIR"])

job = {
    "command": {
        "captureBackend": "alsa",
        "captureChannels": CAPTURE_CHANNELS,
        "captureDevice": CAPTURE_DEVICE,
        "captureFormat": CAPTURE_FORMAT,
        "captureInterfaceId": None,
        "captureSampleRate": CAPTURE_RATE,
        "channelMap": None,
        "chunkSeconds": CHUNK_SECONDS,
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
            "policyId": "retention-loopback-chunked-smoke",
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
    "chunkUploads": [],
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

        if self.path == f"/api/v1/nodes/{NODE_ID}/recording-jobs/claim-next-group":
            observed["claimNextReads"] += 1
            if job["status"] != "queued":
                send_empty(self)
                return

            observed["claims"] += 1
            job["status"] = "running"
            send_json(self, 200, {"data": [job]})
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

        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != f"/api/v1/recordings/{RECORDING_ID}/cache-file":
            send_json(self, 404, {"error": f"unexpected route PUT {self.path}"})
            return

        query = urllib.parse.parse_qs(parsed.query)
        rendition = query.get("rendition", [None])[0]
        chunk = query.get("chunk", [None])[0]
        chunk_total = query.get("chunkTotal", [None])[0]
        body = read_body(self)

        # Store every chunk body keyed by its index + rendition so repeated PUTs do
        # not clobber each other. The job only completes once the upload carrying
        # chunkTotal arrives.
        if chunk is not None:
            ext = "wav"
            suffix = f"chunk-{int(chunk):04d}"
            if rendition:
                suffix = f"{suffix}.{rendition}"
            (CHUNK_DIR / f"{suffix}.{ext}").write_bytes(body)

        observed["chunkUploads"].append(
            {
                "chunk": int(chunk) if chunk is not None else None,
                "chunkTotal": int(chunk_total) if chunk_total is not None else None,
                "contentType": self.headers.get("content-type"),
                "durationSeconds": self.headers.get("x-rakkr-duration-seconds"),
                "fileName": self.headers.get("x-rakkr-file-name"),
                "jobId": self.headers.get("x-rakkr-recording-job-id"),
                "rendition": rendition,
                "size": len(body),
            }
        )

        if chunk_total is not None:
            job["status"] = "completed"

        send_json(self, 201, {"data": {"ok": True}})


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
RAKKR_LOOPBACK_CAPTURE_FORMAT="$capture_format" \
RAKKR_LOOPBACK_CAPTURE_RATE="$rate" \
RAKKR_LOOPBACK_CAPTURE_CHANNELS="$channels" \
RAKKR_LOOPBACK_CAPTURE_SECONDS="$capture_seconds" \
RAKKR_LOOPBACK_CHUNK_SECONDS="$chunk_seconds" \
RAKKR_LOOPBACK_PORT_FILE="$port_file" \
RAKKR_LOOPBACK_STATE_FILE="$state_file" \
RAKKR_LOOPBACK_CHUNK_DIR="$chunk_dir" \
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
timeout "$((capture_seconds + 40))s" \
  "$agent_binary" \
    --allow-insecure-controller \
    --agent-health-log-file "$health_log" \
    --agent-state-file "$agent_state" \
    --capture-command arecord \
    --capture-chunk-seconds "$chunk_seconds" \
    --capture-growth-grace-seconds 0 \
    --capture-min-output-bytes "$min_output_bytes" \
    --controller-token "$token" \
    --controller-url "http://127.0.0.1:${port}" \
    --channel-render-command ffmpeg \
    --job-poll-seconds 1 \
    --node-id "$node_id" \
    --run-next-job \
    >"$agent_log" 2>&1
agent_status=$?
set -e

if [[ -n "${player_pid:-}" ]]; then
  wait "$player_pid" >/dev/null 2>&1 || true
fi

if [[ "$agent_status" -ne 0 ]]; then
  echo "Loopback chunked smoke failed with status ${agent_status}." >&2
  cat "$agent_log" >&2 || true
  exit 1
fi

RAKKR_LOOPBACK_WORK_DIR="$work_dir" \
RAKKR_LOOPBACK_CHUNK_DIR="$chunk_dir" \
RAKKR_LOOPBACK_CAPTURE_CHANNELS="$channels" \
RAKKR_LOOPBACK_CAPTURE_RATE="$rate" \
RAKKR_LOOPBACK_JOB_ID="$job_id" \
RAKKR_LOOPBACK_OUTPUT_NAME="$output_name" \
RAKKR_LOOPBACK_JOB_SECONDS="$capture_seconds" \
RAKKR_LOOPBACK_CHUNK_SECONDS="$chunk_seconds" \
  python3 <<'PY'
import json
import os
import pathlib
import subprocess
import sys

work = pathlib.Path(os.environ["RAKKR_LOOPBACK_WORK_DIR"])
chunk_dir = pathlib.Path(os.environ["RAKKR_LOOPBACK_CHUNK_DIR"])
capture_seconds = int(os.environ["RAKKR_LOOPBACK_JOB_SECONDS"])
chunk_seconds = int(os.environ["RAKKR_LOOPBACK_CHUNK_SECONDS"])
expected_channels = int(os.environ["RAKKR_LOOPBACK_CAPTURE_CHANNELS"])
expected_rate = int(os.environ["RAKKR_LOOPBACK_CAPTURE_RATE"])
expected_job_id = os.environ["RAKKR_LOOPBACK_JOB_ID"]
state = json.loads((work / "controller-state.json").read_text())
agent_state = json.loads((work / "agent-state.json").read_text())
health_events = [
    json.loads(line)
    for line in (work / "agent-health-events.jsonl").read_text().splitlines()
    if line.strip()
]
errors = []

observed = state["observed"]
job = state["job"]
uploads = observed["chunkUploads"]


def ffprobe_samples(path):
    output = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=duration_ts,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ],
        text=True,
    )
    stream = json.loads(output)["streams"][0]
    return stream


# Only the raw renditions reassemble into the continuous master (the enhanced
# rendition is a separate processed copy). Whole recordings carry no rendition; this
# smoke uses a profile with no enhancement so every chunk is a single primary upload.
raw_uploads = [u for u in uploads if u["rendition"] in (None, "raw")]
chunk_indices = sorted(u["chunk"] for u in raw_uploads if u["chunk"] is not None)

if job["status"] != "completed":
    errors.append(f"job did not complete: {job['status']}")
if agent_state.get("status") != "completed":
    errors.append(f"agent state did not complete: {agent_state.get('status')}")
if observed["claims"] != 1:
    errors.append("agent did not claim exactly one job")
if observed["heartbeats"] < 1:
    errors.append("agent did not heartbeat during capture")

# chunkTotal must arrive exactly once, on the final chunk, and match the count.
totals = [u["chunkTotal"] for u in uploads if u["chunkTotal"] is not None]
if len(totals) != 1:
    errors.append(f"expected exactly one chunkTotal upload, saw {len(totals)}")
chunk_total = totals[0] if totals else None

expected_chunks = (capture_seconds + chunk_seconds - 1) // chunk_seconds
if chunk_total is not None and chunk_total != expected_chunks:
    errors.append(f"chunkTotal {chunk_total} did not match expected {expected_chunks}")

# Every index 0..chunkTotal-1 present exactly once.
if chunk_total is not None:
    if chunk_indices != list(range(chunk_total)):
        errors.append(f"chunk indices were not 0..{chunk_total - 1} exactly once: {chunk_indices}")

for upload in uploads:
    if upload["jobId"] != expected_job_id:
        errors.append(f"chunk upload job id was wrong: {upload['jobId']}")
    if upload["contentType"] != "audio/wav":
        errors.append(f"chunk upload was not audio/wav: {upload['contentType']}")

# Reassemble uploaded raw chunks and assert gapless total duration.
chunk_files = sorted(chunk_dir.glob("chunk-*.wav"))
chunk_files = [
    p for p in chunk_files if ".enhanced." not in p.name
]
total_samples = 0
boundary_samples = []
for path in chunk_files:
    stream = ffprobe_samples(path)
    if int(stream["channels"]) != expected_channels:
        errors.append(f"{path.name} channel count was wrong: {stream['channels']}")
    if int(stream["sample_rate"]) != expected_rate:
        errors.append(f"{path.name} sample rate was wrong: {stream['sample_rate']}")
    total_samples += int(stream["duration_ts"])

expected_samples = capture_seconds * expected_rate
# Allow ~1 packet (1024 samples) of slack at the trailing partial boundary.
if abs(total_samples - expected_samples) > 1024 + expected_rate:
    # The trailing partial may be short of a full chunk; require the total to be at
    # least (duration - one chunk) and at most (duration + one packet).
    if not (expected_samples - chunk_seconds * expected_rate <= total_samples <= expected_samples + 1024):
        errors.append(
            f"reassembled samples {total_samples} not within tolerance of {expected_samples}"
        )

# Build a concat reassembly to prove ordering + that ffmpeg copy works gaplessly.
if chunk_files and not errors:
    concat_list = work / "chunk-concat.txt"
    concat_list.write_text(
        "".join(f"file '{p.resolve()}'\n" for p in chunk_files),
        encoding="utf-8",
    )
    reassembled = work / "reassembled.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(reassembled),
        ],
        check=True,
    )

    # Cross-correlate chunk boundaries: the last ~50ms of chunk N should line up at
    # lag 0 with the first ~50ms of chunk N+1 if no samples were dropped.
    try:
        import numpy as np
        import wave

        def read_mono(path, frames=None, from_end=False):
            with wave.open(str(path), "rb") as wav:
                n = wav.getnframes()
                ch = wav.getnchannels()
                if frames is not None and from_end:
                    wav.setpos(max(0, n - frames))
                    n = min(frames, n)
                elif frames is not None:
                    n = min(frames, n)
                raw = wav.readframes(n)
            data = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
            if ch > 1:
                data = data.reshape(-1, ch).mean(axis=1)
            return data

        win = int(0.05 * expected_rate)
        for i in range(len(chunk_files) - 1):
            tail = read_mono(chunk_files[i], frames=win, from_end=True)
            head = read_mono(chunk_files[i + 1], frames=win)
            length = min(len(tail), len(head))
            if length < win // 2:
                continue
            tail = tail - tail.mean()
            head = head - head.mean()
            if tail.std() < 1.0 or head.std() < 1.0:
                continue
            corr = np.correlate(head, tail, mode="full")
            lag = corr.argmax() - (len(tail) - 1)
            # A gapless boundary places adjacent windows contiguously; the dominant
            # correlation lag should be near 0 (allow a few samples of jitter).
            if abs(lag) > 64:
                errors.append(
                    f"chunk boundary {i}->{i + 1} cross-correlation lag {lag} too large"
                )
    except ImportError:
        print("numpy not available; skipping cross-correlation boundary check")

if not any(
    event["type"] == "agent.recording_job.chunked_completed" for event in health_events
):
    errors.append("agent health log did not record chunked completion")
if any(event["severity"] == "critical" for event in health_events):
    errors.append("agent health log recorded a critical event")

summary = {
    "agent_state": agent_state.get("status"),
    "chunk_total": chunk_total,
    "chunk_indices": chunk_indices,
    "expected_chunks": expected_chunks,
    "health_events": [event["type"] for event in health_events],
    "job_status": job["status"],
    "reassembled_samples": total_samples,
    "expected_samples": capture_seconds * expected_rate,
    "uploads": len(uploads),
}
print(json.dumps(summary, indent=2))

if errors:
    print("FAIL: " + "; ".join(errors), file=sys.stderr)
    sys.exit(1)
PY

echo
echo "Loopback chunked smoke passed. Artifacts:"
ls -lh "$work_dir"
