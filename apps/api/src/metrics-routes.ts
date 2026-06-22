import type { Context, Hono } from "hono";
import type {
  AuditEvent,
  HealthEvent,
  MeterFrame,
  RecorderNode,
  RecordingJob,
  RecordingSummary,
  UploadQueueItem,
} from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type { AppBindings, AuditTarget, RequirePermission } from "./http-types.js";
import type { ListenMonitorStore } from "./listen-monitor-store.js";
import type { MeterFrameStore } from "./meter-store.js";
import { renderPrometheusMetrics } from "./metrics.js";
import { visibleHealthEvent } from "./health-visibility.js";
import type { NodeStore } from "./node-store.js";
import { recordingCacheFileSize } from "./recording-cache.js";
import { listRecordingJobs } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import { listUploadQueueItems } from "./upload-queue.js";

interface MetricsScopeDependencies {
  auditStore: AuditStore;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
  listenMonitorStore: ListenMonitorStore;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordingStore: RecordingStore;
  startedAt: Date;
}

interface MetricsRouteDependencies extends MetricsScopeDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  requirePermission: RequirePermission;
}

export function registerMetricsRoutes(dependencies: MetricsRouteDependencies) {
  dependencies.app.get(
    "/metrics",
    dependencies.requirePermission("metrics:read", "metrics.read"),
    async (c) =>
      c.text(await controllerPrometheusMetrics(dependencies.currentUser(c), dependencies), 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      }),
  );
}

export async function scopedHealthEvents(
  user: NonNullable<AuthResult["user"]>,
  dependencies: Pick<MetricsScopeDependencies, "hasResourceScope" | "healthEventStore">,
) {
  const result: HealthEvent[] = [];

  for (const event of await dependencies.healthEventStore.list({ limit: 500 })) {
    if (await visibleHealthEvent(user, event, dependencies.hasResourceScope)) {
      result.push(event);
    }
  }

  return result;
}

async function controllerPrometheusMetrics(
  user: NonNullable<AuthResult["user"]>,
  dependencies: MetricsScopeDependencies,
) {
  const [nodes, recordings, recordingJobs, healthEvents, uploadQueueItems, auditEvents] =
    await Promise.all([
      scopedNodes(user, dependencies),
      scopedRecordings(user, dependencies),
      scopedRecordingJobs(user, dependencies),
      scopedHealthEvents(user, dependencies),
      scopedUploadQueueItems(user, dependencies),
      scopedAuditEvents(user, dependencies),
    ]);
  const [listenMonitorChunks, meterFrames] = await Promise.all([
    scopedListenMonitorChunks(nodes, dependencies),
    scopedMeterFrames(nodes, dependencies),
  ]);
  const recordingCacheBytes = await recordingCacheByteMap(recordings);

  return renderPrometheusMetrics({
    auditEvents,
    healthEvents,
    listenMonitorChunks,
    meterFrames,
    nodes,
    observedAt: new Date(),
    recordingCacheBytes,
    recordingJobs,
    recordings,
    startedAt: dependencies.startedAt,
    uploadQueueItems,
  });
}

async function scopedListenMonitorChunks(
  nodes: RecorderNode[],
  dependencies: Pick<MetricsScopeDependencies, "listenMonitorStore">,
) {
  const chunks = await Promise.all(
    nodes.map((node) => dependencies.listenMonitorStore.latest(node.id)),
  );

  return chunks.filter((chunk) => chunk !== undefined);
}

async function scopedNodes(
  user: NonNullable<AuthResult["user"]>,
  dependencies: MetricsScopeDependencies,
) {
  const result: RecorderNode[] = [];

  for (const node of await dependencies.nodeStore.list()) {
    if (await dependencies.hasResourceScope(user, { id: node.id, type: "node" })) {
      result.push(node);
    }
  }

  return result;
}

async function scopedRecordings(
  user: NonNullable<AuthResult["user"]>,
  dependencies: MetricsScopeDependencies,
) {
  const result: RecordingSummary[] = [];

  for (const recording of await dependencies.recordingStore.list()) {
    if (await dependencies.hasResourceScope(user, { id: recording.id, type: "recording" })) {
      result.push(recording);
    }
  }

  return result;
}

async function scopedRecordingJobs(
  user: NonNullable<AuthResult["user"]>,
  dependencies: MetricsScopeDependencies,
) {
  const result: RecordingJob[] = [];
  const visibleRecordingIds = new Set(
    (await scopedRecordings(user, dependencies)).map((recording) => recording.id),
  );

  for (const job of await listRecordingJobs()) {
    if (!(await dependencies.hasResourceScope(user, { id: job.nodeId, type: "node" }))) {
      continue;
    }

    if (!visibleRecordingIds.has(job.recordingId)) {
      continue;
    }

    result.push(job);
  }

  return result;
}

async function scopedUploadQueueItems(
  user: NonNullable<AuthResult["user"]>,
  dependencies: MetricsScopeDependencies,
) {
  const result: UploadQueueItem[] = [];

  for (const item of await listUploadQueueItems()) {
    if (await dependencies.hasResourceScope(user, { id: item.recordingId, type: "recording" })) {
      result.push(item);
    }
  }

  return result;
}

async function scopedAuditEvents(
  user: NonNullable<AuthResult["user"]>,
  dependencies: Pick<MetricsScopeDependencies, "auditStore" | "hasResourceScope">,
) {
  const result: AuditEvent[] = [];

  for (const event of await dependencies.auditStore.list({ limit: 500 })) {
    if (await canReadAuditEvent(user, event, dependencies)) {
      result.push(event);
    }
  }

  return result;
}

async function scopedMeterFrames(nodes: RecorderNode[], dependencies: MetricsScopeDependencies) {
  const frames = await Promise.all(
    nodes.map((node) => dependencies.meterFrameStore.latest(node.id)),
  );

  return frames.filter((frame): frame is MeterFrame => Boolean(frame));
}

async function recordingCacheByteMap(recordings: RecordingSummary[]) {
  const entries = await Promise.all(
    recordings.map(async (recording) => [recording.id, await recordingCacheFileSize(recording)]),
  );

  return Object.fromEntries(entries);
}

async function canReadAuditEvent(
  user: NonNullable<AuthResult["user"]>,
  event: AuditEvent,
  dependencies: Pick<MetricsScopeDependencies, "hasResourceScope">,
) {
  if (!isResourceScopedAuditTarget(event.target)) {
    return true;
  }

  return dependencies.hasResourceScope(user, event.target);
}

function isResourceScopedAuditTarget(target: AuditTarget) {
  return Boolean(
    target.id &&
    ["channel", "interface", "node", "recording", "room", "schedule"].includes(target.type),
  );
}
