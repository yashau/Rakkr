import type { Context, Hono } from "hono";
import type {
  HealthEvent,
  MeterFrame,
  RecorderNode,
  RecordingJob,
  RecordingSummary,
  UploadQueueItem,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type { AppBindings, AuditTarget, RequirePermission } from "./http-types.js";
import type { MeterFrameStore } from "./meter-store.js";
import { renderPrometheusMetrics } from "./metrics.js";
import type { NodeStore } from "./node-store.js";
import { listRecordingJobs } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import { listUploadQueueItems } from "./upload-queue.js";

interface MetricsScopeDependencies {
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
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
    if (await canReadHealthEvent(user, event, dependencies)) {
      result.push(event);
    }
  }

  return result;
}

async function controllerPrometheusMetrics(
  user: NonNullable<AuthResult["user"]>,
  dependencies: MetricsScopeDependencies,
) {
  const [nodes, recordings, recordingJobs, healthEvents, uploadQueueItems] = await Promise.all([
    scopedNodes(user, dependencies),
    scopedRecordings(user, dependencies),
    scopedRecordingJobs(user, dependencies),
    scopedHealthEvents(user, dependencies),
    scopedUploadQueueItems(user, dependencies),
  ]);
  const meterFrames = await scopedMeterFrames(nodes, dependencies);

  return renderPrometheusMetrics({
    healthEvents,
    meterFrames,
    nodes,
    recordingJobs,
    recordings,
    startedAt: dependencies.startedAt,
    uploadQueueItems,
  });
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

  for (const job of await listRecordingJobs()) {
    if (!(await dependencies.hasResourceScope(user, { id: job.nodeId, type: "node" }))) {
      continue;
    }

    const recording = await dependencies.recordingStore.find(job.recordingId);

    if (
      recording &&
      !(await dependencies.hasResourceScope(user, { id: recording.id, type: "recording" }))
    ) {
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

async function scopedMeterFrames(nodes: RecorderNode[], dependencies: MetricsScopeDependencies) {
  const frames = await Promise.all(
    nodes.map((node) => dependencies.meterFrameStore.latest(node.id)),
  );

  return frames.filter((frame): frame is MeterFrame => Boolean(frame));
}

async function canReadHealthEvent(
  user: NonNullable<AuthResult["user"]>,
  event: HealthEvent,
  dependencies: Pick<MetricsScopeDependencies, "hasResourceScope">,
) {
  const targets = healthEventScopeTargets(event);

  if (targets.length === 0) {
    return true;
  }

  for (const target of targets) {
    if (await dependencies.hasResourceScope(user, target)) {
      return true;
    }
  }

  return false;
}

function healthEventScopeTargets(event: HealthEvent) {
  const targets: AuditTarget[] = [];

  if (event.recordingId) {
    targets.push({ id: event.recordingId, type: "recording" });
  }

  if (event.scheduleId) {
    targets.push({ id: event.scheduleId, type: "schedule" });
  }

  if (event.nodeId) {
    targets.push({ id: event.nodeId, type: "node" });
  }

  return targets;
}
