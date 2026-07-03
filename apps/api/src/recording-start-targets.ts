import type { Context } from "hono";
import { z } from "zod";
import type { RecorderNode } from "@rakkr/shared";

import type { AppBindings } from "./http-types.js";

const recordingStartTargetSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
});

export async function recordingStartTarget(c: Context<AppBindings>) {
  const body = recordingStartTargetSchema.safeParse(
    await c.req.raw
      .clone()
      .json()
      .catch(() => ({})),
  );

  return {
    id: body.success ? body.data.nodeId : "__invalid_node__",
    type: "node" as const,
  };
}

export function defaultAdHocFolder(now: Date, node: RecorderNode, roomName?: string) {
  // Prefer the capturing channels' room; fall back to the node's install room when
  // the selection has no owning room (unassigned channels on a room-less node).
  const room = roomName ?? node.location.room;

  return `Ad Hoc/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${room}`;
}

export function defaultAdHocName(now: Date, node: RecorderNode) {
  return `${now.toISOString().slice(0, 16).replace("T", "_")}_Ad Hoc_${node.alias}`;
}

export function recordingExportFileName(now: Date) {
  return `rakkr-recordings-${now.toISOString().replaceAll(":", "-").replace(".", "-")}.csv`;
}

export function requestedInterfaceBelongsToNode(
  node: RecorderNode,
  captureInterfaceId: string | undefined,
) {
  return (
    !captureInterfaceId || node.interfaces.some((candidate) => candidate.id === captureInterfaceId)
  );
}
