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
  if (offlineAfterSeconds <= 0) {
    return node.status;
  }

  const lastSeenMs = Date.parse(node.lastSeenAt);

  if (!Number.isFinite(lastSeenMs)) {
    return node.status;
  }

  const staleMs = offlineAfterSeconds * 1_000;

  return now.getTime() - lastSeenMs > staleMs ? "offline" : node.status;
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
