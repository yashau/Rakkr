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
import { canReadAuditEvent } from "./audit-scope.js";
import { isDatabaseUnavailableError } from "./database-unavailable.js";
import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { ListenMonitorStore } from "./listen-monitor-store.js";
import type { MeterFrameStore } from "./meter-store.js";
import { renderPrometheusMetrics } from "./metrics.js";
import { visibleHealthEvent } from "./health-visibility.js";
import type { NodeStore } from "./node-store.js";
import { recordingCacheFileSize, recordingChunkCacheFileSize } from "./recording-cache.js";
import { listRecordingChunksForRecording } from "./recording-chunks.js";
import { listRecordingJobs } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import { listUploadQueueItems } from "./upload-queue.js";

interface MetricsScopeDependencies {
  auditStore: AuditStore;
  // Whether the caller may receive a node's whole-node monitor chunk (owns every
  // channel's room). Gates listen-monitor chunk metrics so a shared node's chunk
  // is not exposed to a single-room principal. Defaults permissive for tests; the
  // real wiring MUST pass the room-aware implementation.
  canServeWholeNodeMonitor?: (
    user: NonNullable<AuthResult["user"]>,
    node: RecorderNode,
  ) => Promise<boolean>;
  // Strict per-channel meter filtering: drops levels for channels the caller's
  // rooms do not own, so per-channel gauges never leak a sibling room's telemetry.
  // Defaults to identity for tests; the real wiring MUST pass filterMeterFrameForUser.
  filterMeterFrame?: (
    user: NonNullable<AuthResult["user"]>,
    node: RecorderNode,
    frame: MeterFrame,
  ) => Promise<MeterFrame>;
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
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

export function registerMetricsRoutes(dependencies: MetricsRouteDependencies) {
  dependencies.app.get(
    "/metrics",
    dependencies.requirePermission("metrics:read", "metrics.read"),
    async (c) => {
      const user = dependencies.currentUser(c);
      const contentType = "text/plain; version=0.0.4; charset=utf-8";

      try {
        const result = await controllerPrometheusMetrics(user, dependencies);

        await dependencies.recordAuditEvent(c, {
          action: "metrics.read.succeeded",
          auth: { user },
          details: result.details,
          outcome: "succeeded",
          permission: "metrics:read",
          target: { type: "controller" },
        });

        return c.text(`${result.output}${databaseUnavailableGauge(false)}`, 200, {
          "Content-Type": contentType,
        });
      } catch (error) {
        if (!isDatabaseUnavailableError(error)) {
          throw error;
        }

        // Degrade instead of 503: keep the scrape alive during a DB outage —
        // that is exactly when the operator needs the signal — and expose the
        // outage itself as a gauge.
        await dependencies.recordAuditEvent(c, {
          action: "metrics.read.succeeded",
          auth: { user },
          details: { databaseUnavailable: true },
          outcome: "succeeded",
          permission: "metrics:read",
          target: { type: "controller" },
        });

        return c.text(databaseUnavailableGauge(true), 200, { "Content-Type": contentType });
      }
    },
  );
}

function databaseUnavailableGauge(unavailable: boolean): string {
  return [
    "# HELP rakkr_database_unavailable Controller database reachability (1 = unavailable).",
    "# TYPE rakkr_database_unavailable gauge",
    `rakkr_database_unavailable ${unavailable ? 1 : 0}`,
    "",
  ].join("\n");
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
    scopedListenMonitorChunks(user, nodes, dependencies),
    scopedMeterFrames(user, nodes, dependencies),
  ]);
  const recordingCacheBytes = await recordingCacheByteMap(recordings);
  const output = renderPrometheusMetrics({
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

  return {
    details: {
      auditEventCount: auditEvents.length,
      healthEventCount: healthEvents.length,
      listenMonitorChunkCount: listenMonitorChunks.length,
      meterFrameCount: meterFrames.length,
      nodeCount: nodes.length,
      recordingCacheBytes: Object.values(recordingCacheBytes).reduce(
        (sum, bytes) => sum + bytes,
        0,
      ),
      recordingCount: recordings.length,
      recordingJobCount: recordingJobs.length,
      uploadQueueItemCount: uploadQueueItems.length,
    },
    output,
  };
}

async function scopedListenMonitorChunks(
  user: NonNullable<AuthResult["user"]>,
  nodes: RecorderNode[],
  dependencies: Pick<MetricsScopeDependencies, "canServeWholeNodeMonitor" | "listenMonitorStore">,
) {
  const canServeWholeNodeMonitor = dependencies.canServeWholeNodeMonitor ?? (async () => true);
  const chunks = [];

  for (const node of nodes) {
    // The monitor chunk is whole-node audio; only surface its metrics to a caller
    // who owns every channel's room (mirrors the listen-stream gate).
    if (!(await canServeWholeNodeMonitor(user, node))) {
      continue;
    }

    const chunk = await dependencies.listenMonitorStore.latest(node.id);

    if (chunk !== undefined) {
      chunks.push(chunk);
    }
  }

  return chunks;
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

async function scopedMeterFrames(
  user: NonNullable<AuthResult["user"]>,
  nodes: RecorderNode[],
  dependencies: MetricsScopeDependencies,
) {
  const filterMeterFrame =
    dependencies.filterMeterFrame ?? (async (_user, _node, frame: MeterFrame) => frame);
  const frames: MeterFrame[] = [];

  for (const node of nodes) {
    const frame = await dependencies.meterFrameStore.latest(node.id);

    if (frame) {
      // Drop channel levels the caller's rooms do not own so per-channel gauges
      // never expose a shared node's sibling-room telemetry (matches /meters).
      frames.push(await filterMeterFrame(user, node, frame));
    }
  }

  return frames;
}

export async function recordingCacheByteMap(
  recordings: RecordingSummary[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    recordings.map(async (recording): Promise<[string, number]> => {
      // Chunked recordings carry no recording-level cachePath, so their footprint
      // lives entirely on the chunk files — sum both or the metric under-reports.
      let total = (await recordingCacheFileSize(recording)) ?? 0;

      for (const chunk of await listRecordingChunksForRecording(recording.id)) {
        total += await recordingChunkCacheFileSize(chunk);
      }

      return [recording.id, total];
    }),
  );

  return Object.fromEntries(entries);
}
