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
    // `controller.` and `watchdog.` are controller-authored event namespaces; a
    // node must not forge them (the watchdog keys its active-event state on the
    // type string, so a forged `watchdog.*` event would pollute that bookkeeping
    // and the audit trail). Agents use `agent.*`.
    type: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(
        (value) => !value.startsWith("controller.") && !value.startsWith("watchdog."),
        "Health event type must not use a controller-reserved prefix",
      ),
  })
  .strict();

export const nodeHeartbeatSchema = z
  .object({
    agentVersion: z.string().trim().min(1).max(80),
    hostname: z.string().trim().min(1).max(255),
    // A heartbeat is liveness-critical, so an over-cap ipAddresses list must not
    // fail the whole heartbeat closed and strand the node as "offline". A
    // multi-homed host's `hostname -I` can exceed 16 (IPv6 SLAAC/privacy addresses
    // + Docker/libvirt/VLAN bridges); truncate to the documented cap and accept
    // (the kept 16 are the primary addresses) rather than 400 every heartbeat
    // forever and desync the node (audit R7-IPCAP).
    ipAddresses: z
      .preprocess(
        (value) => (Array.isArray(value) ? value.slice(0, 16) : value),
        z.array(z.string().trim().min(1).max(120)).max(16),
      )
      .default([]),
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
