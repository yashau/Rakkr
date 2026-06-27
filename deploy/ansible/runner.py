from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
import subprocess
import tempfile
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
    config = target_config(target.get("nodeId"))
    host = config_value(config, "host") or host_override(target.get("nodeId")) or target.get("host")

    if action not in ACTIONS:
        raise ValueError("unsupported_lifecycle_action")

    if not isinstance(host, str) or not host.strip():
        raise ValueError("target_host_required")

    run_id = f"ansible_{uuid.uuid4()}"
    with tempfile.TemporaryDirectory() as tmpdir:
        inventory = os.path.join(tmpdir, "inventory.json")
        write_inventory(inventory, host.strip(), options, config, tmpdir)
        process = subprocess.run(
            ansible_command(inventory, action, target, options, config),
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


def write_inventory(path, host, options, config, tmpdir):
    user = (
        options.get("sshUser")
        or config_value(config, "sshUser")
        or os.environ.get("RAKKR_ANSIBLE_DEFAULT_SSH_USER", "rakkr")
    )
    key_file = prepare_key_file(
        config_value(config, "sshKeyFile") or os.environ.get("RAKKR_ANSIBLE_SSH_KEY_FILE"),
        tmpdir,
    )
    password = config_value(config, "sshPassword") or (
        None if key_file else os.environ.get("RAKKR_ANSIBLE_SSH_PASSWORD")
    )
    become_password = (
        config_value(config, "becomePassword")
        or os.environ.get("RAKKR_ANSIBLE_BECOME_PASSWORD")
        or password
    )
    host_vars = {
        "ansible_host": host,
        "ansible_python_interpreter": "/usr/bin/python3",
        "ansible_remote_tmp": "/tmp/.ansible-rakkr",
        "ansible_user": user,
    }

    if password:
        host_vars["ansible_password"] = password

    if become_password:
        host_vars["ansible_become_password"] = become_password

    if key_file:
        host_vars["ansible_ssh_private_key_file"] = key_file

    inventory_data = {
        "rakkr_targets": {
            "hosts": {
                "target": host_vars,
            },
        },
    }
    with open(path, "w", encoding="utf-8") as inventory_file:
        json.dump(inventory_data, inventory_file)
        inventory_file.write("\n")


def prepare_key_file(key_file, tmpdir):
    if not key_file:
        return None

    if not os.path.exists(key_file):
        raise ValueError("ssh_key_file_not_found")

    target = os.path.join(tmpdir, "ssh_private_key")
    shutil.copyfile(key_file, target)
    os.chmod(target, 0o600)
    return target


def ansible_command(inventory, action, target, options, config):
    extra_vars = {
        "rakkr_agent_binary_src": os.environ.get(
            "RAKKR_ANSIBLE_BINARY_SRC",
            "/opt/rakkr-artifacts/rakkr-recorder-agent",
        ),
        "rakkr_lifecycle_action": action,
        "rakkr_node_alias": target.get("nodeAlias"),
        "rakkr_node_id": target.get("nodeId"),
        "rakkr_rollout_serial": os.environ.get("RAKKR_ANSIBLE_ROLLOUT_SERIAL", "1"),
    }
    optional_vars = {
        "rakkr_agent_version": options.get("agentVersion"),
        "rakkr_controller_ca_src": os.environ.get("RAKKR_ANSIBLE_CONTROLLER_CA_SRC"),
        "rakkr_node_smoke_command": config_value(config, "smokeCommand")
        or os.environ.get("RAKKR_ANSIBLE_SMOKE_COMMAND"),
    }

    for key, value in optional_vars.items():
        if isinstance(value, str) and value.strip():
            extra_vars[key] = value

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
        json.dumps(extra_vars),
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


def target_config(node_id):
    raw = os.environ.get("RAKKR_ANSIBLE_TARGETS", "{}")

    try:
        targets = json.loads(raw)
    except json.JSONDecodeError:
        return {}

    if not isinstance(targets, dict) or not isinstance(node_id, str):
        return {}

    value = targets.get(node_id)
    return value if isinstance(value, dict) else {}


def config_value(config, key):
    value = config.get(key)
    return value if isinstance(value, str) and value.strip() else None


if __name__ == "__main__":
    host = os.environ.get("RAKKR_ANSIBLE_RUNNER_HOST", "0.0.0.0")
    port = int(os.environ.get("RAKKR_ANSIBLE_RUNNER_PORT", "8790"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Rakkr Ansible runner listening on http://{host}:{port}", flush=True)
    server.serve_forever()
