#!/bin/sh
# Rakkr recorder-agent day-0 installer.
#
#   curl -fsSL https://rakkr.org/agent.sh | sudo sh -s -- \
#     --controller-url https://10.0.0.10:8787 \
#     --bootstrap-token rakkr_bs_... \
#     [--version agent-vYYYY.MM.DD-N] [--node-id node_...] \
#     [--node-alias "Studio A"] [--site "HQ"] [--room "Studio A"] \
#     [--allow-insecure] [--controller-ca /path/to/ca.pem]
#
# It downloads the checksum-verified static-musl agent from the matching GitHub
# release, creates the rakkr user + dirs + systemd unit (the same install layout
# as the Ansible recorder_node role), then runs `rakkr-recorder-agent --bootstrap`
# so the node mints its own SSH key, hands the private key to the controller, and
# receives a long-lived controller token. No SSH keys are baked into the image —
# only the single-use bootstrap token rides in.
set -eu

REPO="${RAKKR_AGENT_REPO:-yashau/Rakkr}"
INSTALL_DIR="/opt/rakkr/bin"
STATE_DIR="/var/lib/rakkr/agent"
CONFIG_DIR="/etc/rakkr"
ENV_FILE="${CONFIG_DIR}/recorder-agent.env"
SERVICE_NAME="rakkr-recorder-agent"
AGENT_USER="rakkr"
AGENT_GROUP="rakkr"
BINARY_PATH="${INSTALL_DIR}/rakkr-recorder-agent"

CONTROLLER_URL=""
BOOTSTRAP_TOKEN="${RAKKR_BOOTSTRAP_TOKEN:-}"
VERSION="latest"
NODE_ID=""
NODE_ALIAS=""
NODE_SITE=""
NODE_ROOM=""
ALLOW_INSECURE=""
CONTROLLER_CA=""

die() {
  echo "agent.sh: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --controller-url) CONTROLLER_URL="$2"; shift 2 ;;
    --bootstrap-token) BOOTSTRAP_TOKEN="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --node-id) NODE_ID="$2"; shift 2 ;;
    --node-alias) NODE_ALIAS="$2"; shift 2 ;;
    --site) NODE_SITE="$2"; shift 2 ;;
    --room) NODE_ROOM="$2"; shift 2 ;;
    --controller-ca) CONTROLLER_CA="$2"; shift 2 ;;
    --allow-insecure) ALLOW_INSECURE="true"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$CONTROLLER_URL" ] || die "--controller-url is required"
[ -n "$BOOTSTRAP_TOKEN" ] || die "--bootstrap-token (or RAKKR_BOOTSTRAP_TOKEN) is required"
[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is required (install openssh-client/openssh-server)"

case "$(uname -m)" in
  x86_64 | amd64) TARGET="x86_64-unknown-linux-musl" ;;
  aarch64 | arm64) TARGET="aarch64-unknown-linux-musl" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# Resolve the release tag (latest -> newest published release) and the bare
# calendar version the asset filenames use (tags are agent-v<version>).
RESOLVED_TAG="$VERSION"
if [ "$VERSION" = "latest" ] || [ -z "$VERSION" ]; then
  RESOLVED_TAG="$(
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
      grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
  )"
  [ -n "$RESOLVED_TAG" ] || die "could not resolve the latest recorder-agent release"
fi
CLEAN_VERSION="$(echo "$RESOLVED_TAG" | sed -E 's/^agent-v//')"

ARCHIVE="rakkr-recorder-agent-${CLEAN_VERSION}-${TARGET}.tar.gz"
ASSET_BASE="https://github.com/${REPO}/releases/download/${RESOLVED_TAG}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "agent.sh: downloading ${ARCHIVE} (${RESOLVED_TAG})"
curl -fsSL -o "${WORK_DIR}/${ARCHIVE}" "${ASSET_BASE}/${ARCHIVE}"
curl -fsSL -o "${WORK_DIR}/${ARCHIVE}.sha256" "${ASSET_BASE}/${ARCHIVE}.sha256"

EXPECTED_SHA="$(awk '{print $1}' "${WORK_DIR}/${ARCHIVE}.sha256")"
ACTUAL_SHA="$(sha256sum "${WORK_DIR}/${ARCHIVE}" | awk '{print $1}')"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || die "checksum mismatch for ${ARCHIVE}"

tar -xzf "${WORK_DIR}/${ARCHIVE}" -C "$WORK_DIR"
UNPACKED="${WORK_DIR}/rakkr-recorder-agent-${CLEAN_VERSION}-${TARGET}/rakkr-recorder-agent"
[ -f "$UNPACKED" ] || UNPACKED="$(find "$WORK_DIR" -type f -name rakkr-recorder-agent | head -n1)"
[ -f "$UNPACKED" ] || die "recorder-agent binary not found in archive"

# User, group, directories — mirrors the Ansible recorder_node role layout.
getent group "$AGENT_GROUP" >/dev/null 2>&1 || groupadd --system "$AGENT_GROUP"
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  useradd --system --gid "$AGENT_GROUP" --groups audio --home-dir "$STATE_DIR" \
    --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
fi

mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$CONFIG_DIR"
chown "$AGENT_USER:$AGENT_GROUP" "$STATE_DIR"
chmod 0755 "$STATE_DIR"

install -o root -g root -m 0755 "$UNPACKED" "$BINARY_PATH"

if [ -n "$CONTROLLER_CA" ]; then
  install -o root -g root -m 0644 "$CONTROLLER_CA" \
    /usr/local/share/ca-certificates/rakkr-controller-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi

NODE_ID="${NODE_ID:-$(hostname)}"

# Base agent env; the bootstrap step appends the controller-minted token.
{
  echo "RAKKR_CONTROLLER_URL=${CONTROLLER_URL}"
  echo "RAKKR_NODE_ID=${NODE_ID}"
  [ -n "$NODE_ALIAS" ] && echo "RAKKR_NODE_ALIAS=${NODE_ALIAS}"
  [ -n "$NODE_SITE" ] && echo "RAKKR_NODE_SITE=${NODE_SITE}"
  [ -n "$NODE_ROOM" ] && echo "RAKKR_NODE_ROOM=${NODE_ROOM}"
  [ -n "$ALLOW_INSECURE" ] && echo "RAKKR_ALLOW_INSECURE_CONTROLLER=true"
  echo "RAKKR_AGENT_HEALTH_LOG_FILE=${STATE_DIR}/health-events.jsonl"
  echo "RAKKR_AGENT_CACHE_DIR=${STATE_DIR}/cache"
} >"$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Rakkr Recorder Agent
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=${AGENT_USER}
Group=${AGENT_GROUP}
EnvironmentFile=${ENV_FILE}
ExecStart=${BINARY_PATH}
Restart=always
RestartSec=5
StateDirectory=rakkr/agent
WorkingDirectory=${STATE_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload

# One-shot bootstrap: the agent generates its keypair, installs the public key
# into the rakkr user's authorized_keys, POSTs the private key + inventory to the
# controller, and writes the returned controller token into the env file.
echo "agent.sh: running one-shot bootstrap against ${CONTROLLER_URL}"
BOOTSTRAP_ARGS="--bootstrap --controller-url ${CONTROLLER_URL} --bootstrap-token ${BOOTSTRAP_TOKEN} --node-id ${NODE_ID}"
[ -n "$ALLOW_INSECURE" ] && BOOTSTRAP_ARGS="${BOOTSTRAP_ARGS} --allow-insecure-controller"
[ -n "$CONTROLLER_CA" ] && BOOTSTRAP_ARGS="${BOOTSTRAP_ARGS} --controller-ca-cert-path /usr/local/share/ca-certificates/rakkr-controller-ca.crt"
# shellcheck disable=SC2086
"$BINARY_PATH" $BOOTSTRAP_ARGS

# sshd StrictModes requires the key files to be owned by the agent user.
chown -R "$AGENT_USER:$AGENT_GROUP" "${STATE_DIR}/.ssh"
chmod 0700 "${STATE_DIR}/.ssh"
[ -f "${STATE_DIR}/.ssh/authorized_keys" ] && chmod 0600 "${STATE_DIR}/.ssh/authorized_keys"

systemctl enable --now "$SERVICE_NAME"
echo "agent.sh: recorder agent installed and started (node ${NODE_ID})"
