import { randomUUID } from "node:crypto";
import type { AuditEvent, HealthEvent, RecorderNode } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import {
  nodeHeartbeatAgeSeconds,
  nodeHeartbeatStale,
  nodeOfflineAfterSeconds,
} from "./node-liveness.js";

export const nodeOfflineEventType = "watchdog.node_offline";

export interface NodeLivenessResult {
  eventId?: string;
  nodeId?: string;
  outcome: "alert_created" | "alert_resolved" | "alert_updated" | "skipped";
  reason?: string;
}

export async function reconcileNodeLivenessEvents({
  auditStore,
  healthEventStore,
  nodes,
  now,
}: {
  auditStore: AuditStore;
  healthEventStore: HealthEventStore;
  nodes: RecorderNode[];
  now: Date;
}): Promise<NodeLivenessResult[]> {
  const results: NodeLivenessResult[] = [];

  for (const node of nodes) {
    // A never-provisioned node has never been online, so "went offline" cannot
    // apply — skip it entirely (no offline alert) until its first heartbeat
    // flips it to a live status.
    if (node.status === "provisioning") {
      results.push({ nodeId: node.id, outcome: "skipped", reason: "node_never_provisioned" });
      continue;
    }

    // Isolate each node's reconcile: a store failure (or health-event write
    // error) for one node must not abort the sweep and leave every later node
    // unreconciled — skip the failing one and keep going (audit R4-2).
    try {
      const existing = await activeNodeOfflineEvent(healthEventStore, node.id);

      if (nodeHeartbeatStale(node, now)) {
        results.push(
          await writeNodeOfflineEvent({
            auditStore,
            existing,
            healthEventStore,
            node,
            now,
          }),
        );
        continue;
      }

      if (existing) {
        results.push(
          await resolveNodeOfflineEvent({
            auditStore,
            existing,
            healthEventStore,
            node,
            now,
          }),
        );
      }
    } catch {
      results.push({ nodeId: node.id, outcome: "skipped", reason: "reconcile_failed" });
    }
  }

  return results;
}

async function writeNodeOfflineEvent({
  auditStore,
  existing,
  healthEventStore,
  node,
  now,
}: {
  auditStore: AuditStore;
  existing?: HealthEvent;
  healthEventStore: HealthEventStore;
  node: RecorderNode;
  now: Date;
}): Promise<NodeLivenessResult> {
  const details = nodeOfflineDetails(node, now, existing);

  if (!existing) {
    const event = await healthEventStore.create({
      details,
      nodeId: node.id,
      severity: "critical",
      type: nodeOfflineEventType,
    });

    await appendNodeWatchdogAudit(auditStore, {
      action: "health.watchdog.node_offline.created",
      after: healthEventSnapshot(event),
      event,
      node,
      now,
      outcome: "succeeded",
    });

    return {
      eventId: event.id,
      nodeId: node.id,
      outcome: "alert_created",
      reason: "node_heartbeat_stale",
    };
  }

  const event = await healthEventStore.update(existing.id, {
    details,
    severity: "critical",
    status: existing.status,
  });

  return {
    eventId: event?.id ?? existing.id,
    nodeId: node.id,
    outcome: event ? "alert_updated" : "skipped",
    reason: event ? "node_heartbeat_stale" : "health_event_missing_during_update",
  };
}

async function resolveNodeOfflineEvent({
  auditStore,
  existing,
  healthEventStore,
  node,
  now,
}: {
  auditStore: AuditStore;
  existing: HealthEvent;
  healthEventStore: HealthEventStore;
  node: RecorderNode;
  now: Date;
}): Promise<NodeLivenessResult> {
  const resolved = await healthEventStore.updateLifecycle(existing.id, {
    details: {
      ...existing.details,
      autoResolvedAt: now.toISOString(),
      autoResolvedReason: "node_heartbeat_recovered",
      lastSeenAt: node.lastSeenAt,
    },
    resolvedAt: now,
    resolvedBy: "system:watchdog",
    status: "resolved",
  });

  if (!resolved) {
    return {
      nodeId: node.id,
      outcome: "skipped",
      reason: "health_event_missing_during_resolve",
    };
  }

  await appendNodeWatchdogAudit(auditStore, {
    action: "health.watchdog.node_offline.resolved",
    after: healthEventSnapshot(resolved),
    before: healthEventSnapshot(existing),
    event: resolved,
    node,
    now,
    outcome: "succeeded",
  });

  return {
    eventId: resolved.id,
    nodeId: node.id,
    outcome: "alert_resolved",
    reason: "node_heartbeat_recovered",
  };
}

async function activeNodeOfflineEvent(healthEventStore: HealthEventStore, nodeId: string) {
  // Filter by `type` in the query so the 500-row cap applies per-type, not across
  // all of the node's events (which could hide the open one → duplicate).
  const events = await healthEventStore.list({ limit: 500, nodeId, type: nodeOfflineEventType });

  return events.find((event) => event.status !== "resolved");
}

function nodeOfflineDetails(node: RecorderNode, now: Date, existing?: HealthEvent) {
  const existingDetails = record(existing?.details) ?? {};
  const firstObservedAt =
    stringDetail(existingDetails.firstObservedAt) ?? existing?.openedAt ?? now.toISOString();

  return {
    ...existingDetails,
    alias: node.alias,
    firstObservedAt,
    hostname: node.hostname,
    ipAddresses: node.ipAddresses,
    lastObservedAt: now.toISOString(),
    lastSeenAt: node.lastSeenAt,
    location: node.location,
    offlineAfterSeconds: nodeOfflineAfterSeconds(),
    offlineForSeconds: nodeHeartbeatAgeSeconds(node, now),
    reportedStatus: node.status,
    tags: node.tags,
  };
}

async function appendNodeWatchdogAudit(
  auditStore: AuditStore,
  input: {
    action: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
    event: HealthEvent;
    node: RecorderNode;
    now: Date;
    outcome: AuditEvent["outcome"];
  },
) {
  await auditStore.append({
    action: input.action,
    actor: {
      id: "system:watchdog",
      name: "Rakkr Watchdog",
      roles: [],
      type: "system",
    },
    actorContext: {},
    after: input.after,
    before: input.before,
    correlationIds: {
      healthEventId: input.event.id,
      nodeId: input.node.id,
    },
    createdAt: input.now.toISOString(),
    details: {
      lastSeenAt: input.node.lastSeenAt,
      nodeId: input.node.id,
    },
    id: `audit_${randomUUID()}`,
    outcome: input.outcome,
    permission: "health:acknowledge",
    target: {
      id: input.event.id,
      name: input.event.type,
      type: "health_event",
    },
  });
}

function healthEventSnapshot(event: HealthEvent) {
  return {
    acknowledgedAt: event.acknowledgedAt,
    acknowledgedBy: event.acknowledgedBy,
    details: event.details,
    nodeId: event.nodeId,
    recordingId: event.recordingId,
    resolvedAt: event.resolvedAt,
    resolvedBy: event.resolvedBy,
    scheduleId: event.scheduleId,
    severity: event.severity,
    status: event.status,
    suppressedAt: event.suppressedAt,
    suppressedBy: event.suppressedBy,
    suppressedUntil: event.suppressedUntil,
    type: event.type,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringDetail(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
