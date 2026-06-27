from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import tempfile
import time
import uuid

ACTIONS = {
    "install_dependencies",
    "update_binary",
    "restart_service",
    "rotate_trust",
    "smoke_check",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.respond(200, {"data": {"ok": True}})
            return

        self.respond(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/runs":
            self.respond(404, {"error": "not_found"})
            return

        try:
            payload = self.read_json()
            print(f"starting lifecycle run action={payload.get('action')}", flush=True)
            result = run_lifecycle(payload)
            print(
                f"finished lifecycle run action={payload.get('action')} exit={result.get('exitCode')}",
                flush=True,
            )
            self.respond(200, {"data": result})
        except ValueError as error:
            self.respond(400, {"error": str(error)})
        except Exception as error:
            self.respond(500, {"error": str(error)})

    def read_json(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def respond(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        print(format % args, flush=True)


def run_lifecycle(payload):
    action = payload.get("action")
    target = payload.get("target") or {}
    options = payload.get("options") or {}
    host = host_override(target.get("nodeId")) or target.get("host")

    if action not in ACTIONS:
        raise ValueError("unsupported_lifecycle_action")

    if not isinstance(host, str) or not host.strip():
        raise ValueError("target_host_required")

    run_id = f"ansible_{uuid.uuid4()}"
    with tempfile.TemporaryDirectory() as tmpdir:
        inventory = os.path.join(tmpdir, "inventory.ini")
        write_inventory(inventory, host.strip(), options)
        process = subprocess.run(
            ansible_command(inventory, action, target, options),
            capture_output=True,
            env=ansible_env(),
            text=True,
            timeout=timeout_seconds(),
        )

    return {
        "exitCode": process.returncode,
        "runId": run_id,
        "stderr": process.stderr[-12000:],
        "stdout": process.stdout[-20000:],
        "targetHost": host.strip(),
    }


def write_inventory(path, host, options):
    user = options.get("sshUser") or os.environ.get("RAKKR_ANSIBLE_DEFAULT_SSH_USER", "rakkr")
    password = os.environ.get("RAKKR_ANSIBLE_SSH_PASSWORD")
    key_file = os.environ.get("RAKKR_ANSIBLE_SSH_KEY_FILE")
    lines = [
        "[rakkr_targets]",
        f"target ansible_host={host} ansible_user={user} ansible_python_interpreter=/usr/bin/python3 ansible_remote_tmp=/tmp/.ansible-rakkr",
    ]

    if password:
        lines[-1] += " ansible_password={0} ansible_become_password={0}".format(password)

    if key_file:
        lines[-1] += f" ansible_ssh_private_key_file={key_file}"

    with open(path, "w", encoding="utf-8") as inventory:
        inventory.write("\n".join(lines) + "\n")


def ansible_command(inventory, action, target, options):
    command = [
        "ansible-playbook",
        os.environ.get("RAKKR_ANSIBLE_PLAYBOOK", "/opt/rakkr/deploy/ansible/playbooks/node-lifecycle.yml"),
        "-i",
        inventory,
        "--limit",
        "rakkr_targets",
        "--ssh-common-args",
        ssh_common_args(),
        "-e",
        json.dumps(
            {
                "rakkr_lifecycle_action": action,
                "rakkr_agent_binary_src": os.environ.get(
                    "RAKKR_ANSIBLE_BINARY_SRC",
                    "/opt/rakkr-artifacts/rakkr-recorder-agent",
                ),
                "rakkr_agent_version": options.get("agentVersion"),
                "rakkr_controller_ca_src": os.environ.get("RAKKR_ANSIBLE_CONTROLLER_CA_SRC"),
                "rakkr_node_alias": target.get("nodeAlias"),
                "rakkr_node_id": target.get("nodeId"),
                "rakkr_rollout_serial": os.environ.get("RAKKR_ANSIBLE_ROLLOUT_SERIAL", "1"),
            }
        ),
    ]

    return command


def ansible_env():
    env = os.environ.copy()
    env["ANSIBLE_HOST_KEY_CHECKING"] = os.environ.get("RAKKR_ANSIBLE_HOST_KEY_CHECKING", "0")
    env["ANSIBLE_ROLES_PATH"] = os.environ.get(
        "RAKKR_ANSIBLE_ROLES_PATH",
        "/opt/rakkr/deploy/ansible/roles",
    )
    return env


def ssh_common_args():
    if os.environ.get("RAKKR_ANSIBLE_HOST_KEY_CHECKING", "0") == "1":
        return ""

    return "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"


def timeout_seconds():
    return int(os.environ.get("RAKKR_ANSIBLE_TIMEOUT_SECONDS", "120"))


def host_override(node_id):
    raw = os.environ.get("RAKKR_ANSIBLE_HOST_OVERRIDES", "{}")

    try:
        overrides = json.loads(raw)
    except json.JSONDecodeError:
        return None

    if not isinstance(overrides, dict):
        return None

    value = overrides.get(node_id)
    return value if isinstance(value, str) and value.strip() else None


if __name__ == "__main__":
    host = os.environ.get("RAKKR_ANSIBLE_RUNNER_HOST", "0.0.0.0")
    port = int(os.environ.get("RAKKR_ANSIBLE_RUNNER_PORT", "8790"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Rakkr Ansible runner listening on http://{host}:{port}", flush=True)
    server.serve_forever()
