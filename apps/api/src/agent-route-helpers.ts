import {
  healthSeveritySchema,
  nodeRuntimeSchema,
  nodeStatusSchema,
  type ChannelMapTemplateAssignment,
  type RecordingSummary,
} from "@rakkr/shared";
import { z } from "zod";

import type { NodeCredentialAuth, NodeStore } from "./node-store.js";
import type { SettingsStore } from "./settings-store.js";

export const nodeHealthEventSchema = z
  .object({
    details: z.record(z.string(), z.unknown()).default({}),
    id: z.string().trim().min(1).max(160).optional(),
    openedAt: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !Number.isNaN(Date.parse(value)), "Expected ISO date/time")
      .optional(),
    recordingId: z.string().trim().min(1).max(160).optional(),
    scheduleId: z.string().trim().min(1).max(160).optional(),
    severity: healthSeveritySchema,
    type: z.string().trim().min(1).max(160),
  })
  .strict();

export const nodeHeartbeatSchema = z
  .object({
    agentVersion: z.string().trim().min(1).max(80),
    hostname: z.string().trim().min(1).max(255),
    ipAddresses: z.array(z.string().trim().min(1).max(120)).max(16).default([]),
    runtime: nodeRuntimeSchema.optional(),
    status: nodeStatusSchema.default("online"),
  })
  .passthrough();

export function nodeHeartbeatSnapshot(node: Awaited<ReturnType<NodeStore["find"]>> | undefined) {
  return node
    ? {
        agentVersion: node.agentVersion,
        hostname: node.hostname,
        ipAddresses: node.ipAddresses,
        runtime: node.runtime,
        status: node.status,
      }
    : undefined;
}

export function nodeHeartbeatChanged(
  before: Awaited<ReturnType<NodeStore["find"]>> | undefined,
  after: NonNullable<Awaited<ReturnType<NodeStore["find"]>>>,
) {
  return (
    JSON.stringify(nodeHeartbeatSnapshot(before)) !== JSON.stringify(nodeHeartbeatSnapshot(after))
  );
}

export function nodeActor(credential: NodeCredentialAuth) {
  return {
    id: credential.nodeId,
    name: credential.nodeId,
    roles: [],
    type: "node" as const,
  };
}

export function nodeHealthEventDetails(input: z.infer<typeof nodeHealthEventSchema>) {
  return {
    ...input.details,
    localEventId: input.id,
  };
}

export function recordingFileSnapshot(recording: RecordingSummary) {
  return {
    cachePath: recording.cachePath,
    cached: recording.cached,
    checksum: recording.checksum,
    durationSeconds: recording.durationSeconds,
    status: recording.status,
    waveformPeaks: recording.waveformPreview?.peaks.length,
  };
}

export function durationFromHeader(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const duration = Number(value);

  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : "invalid";
}

export async function assignedChannelMaps(
  node: NonNullable<Awaited<ReturnType<NodeStore["find"]>>>,
  settingsStore: SettingsStore,
) {
  const interfaceIds = new Set(node.interfaces.map((audioInterface) => audioInterface.id));
  const assignments = (await settingsStore.listChannelMapAssignments()).filter((assignment) =>
    matchesNodeAssignment(assignment, node.id, interfaceIds),
  );
  const result = [];

  for (const assignment of assignments) {
    const template = await settingsStore.findChannelMapTemplate(assignment.templateId);

    if (template) {
      result.push({ assignment, template });
    }
  }

  return result;
}

function matchesNodeAssignment(
  assignment: ChannelMapTemplateAssignment,
  nodeId: string,
  interfaceIds: Set<string>,
) {
  if (assignment.targetType === "node") {
    return assignment.targetId === nodeId;
  }

  return interfaceIds.has(assignment.targetId);
}
