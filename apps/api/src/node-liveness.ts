import type { NodeStatus, RecorderNode } from "@rakkr/shared";

const defaultNodeOfflineAfterSeconds = 120;

export function nodeOfflineAfterSeconds(env: NodeJS.ProcessEnv = process.env) {
  return nonnegativeInteger(env.RAKKR_NODE_OFFLINE_AFTER_SECONDS, defaultNodeOfflineAfterSeconds);
}

export function deriveNodeStatus(
  node: RecorderNode,
  now = new Date(),
  offlineAfterSeconds = nodeOfflineAfterSeconds(),
): NodeStatus {
  // A never-provisioned node stays "provisioning" — it has never been online, so
  // heartbeat-staleness (and offline alerting) does not apply. Its first
  // heartbeat sets a live status, after which liveness derivation resumes.
  if (node.status === "provisioning") {
    return "provisioning";
  }

  return nodeHeartbeatStale(node, now, offlineAfterSeconds) ? "offline" : node.status;
}

export function nodeWithDerivedLiveness(
  node: RecorderNode,
  now = new Date(),
  offlineAfterSeconds = nodeOfflineAfterSeconds(),
): RecorderNode {
  const status = deriveNodeStatus(node, now, offlineAfterSeconds);

  return status === node.status ? node : { ...node, status };
}

function nonnegativeInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

export function nodeHeartbeatAgeSeconds(node: RecorderNode, now = new Date()) {
  const lastSeenMs = Date.parse(node.lastSeenAt);

  if (!Number.isFinite(lastSeenMs)) {
    return undefined;
  }

  return Math.max(0, Math.floor((now.getTime() - lastSeenMs) / 1_000));
}

export function nodeHeartbeatStale(
  node: RecorderNode,
  now = new Date(),
  offlineAfterSeconds = nodeOfflineAfterSeconds(),
) {
  const ageSeconds = nodeHeartbeatAgeSeconds(node, now);

  return ageSeconds !== undefined && offlineAfterSeconds > 0 && ageSeconds > offlineAfterSeconds;
}
