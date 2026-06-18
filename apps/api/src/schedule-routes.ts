import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { RecordingSummary, ScheduleSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import { createRecordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";

interface ScheduleRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  schedules: ScheduleSummary[];
  scopedSchedules: (user: NonNullable<AuthResult["user"]>) => Promise<ScheduleSummary[]>;
}

export function registerScheduleRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  schedules,
  scopedSchedules,
}: ScheduleRouteDependencies) {
  app.get("/api/v1/schedules", requirePermission("schedule:read", "schedules.read"), async (c) =>
    c.json({ data: await scopedSchedules(currentUser(c)) }),
  );

  app.post(
    "/api/v1/schedules/:scheduleId/run-now",
    requirePermission("schedule:manage", "schedules.run_now", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const schedule = schedules.find((candidate) => candidate.id === scheduleId);

      if (!schedule) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_not_found");
        return c.json({ error: "Schedule not found" }, 404);
      }

      const node = await nodeStore.find(schedule.nodeId);

      if (!node) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_node_not_found", schedule.name);
        return c.json({ error: "Schedule node not found" }, 409);
      }

      const recording = materializeScheduledRecording(schedule, node);
      const before = scheduleExecutionSnapshot(schedule);

      await recordingStore.create(recording);
      const job = await createRecordingJob(recording);

      await recordAuditEvent(c, {
        action: "schedules.run_now.succeeded",
        after: {
          jobId: job.id,
          recordingId: recording.id,
          recordingMetadata: recordingMetadataSnapshot(recording),
        },
        auth: currentAuth(c),
        before,
        correlationIds: {
          jobId: job.id,
          recordingId: recording.id,
          scheduleId: schedule.id,
        },
        details: {
          folderTemplate: schedule.folderTemplate,
          recordingProfileId: schedule.recordingProfileId,
          titleTemplate: schedule.titleTemplate,
          watchdogPolicyId: schedule.watchdogPolicyId,
        },
        outcome: "succeeded",
        permission: "schedule:manage",
        target: {
          id: schedule.id,
          name: schedule.name,
          type: "schedule",
        },
      });

      return c.json({ data: recording, job }, 202);
    },
  );

  async function recordScheduleRunFailure(
    c: Context<AppBindings>,
    scheduleId: string,
    reason: string,
    name?: string,
  ) {
    await recordAuditEvent(c, {
      action: "schedules.run_now.failed",
      auth: currentAuth(c),
      outcome: "failed",
      permission: "schedule:manage",
      reason,
      target: {
        id: scheduleId,
        name,
        type: "schedule",
      },
    });
  }
}

function materializeScheduledRecording(
  schedule: ScheduleSummary,
  node: { alias: string; hostname: string; id: string; location: { room: string; site: string } },
  now = new Date(),
): RecordingSummary {
  const context = templateContext(schedule, node, now);

  return {
    cached: false,
    durationSeconds: 0,
    folder: safePath(renderTemplate(schedule.folderTemplate, context)),
    healthStatus: "unknown",
    id: `rec_${randomUUID()}`,
    name: safeText(renderTemplate(schedule.titleTemplate, context)),
    nodeId: schedule.nodeId,
    recordedAt: now.toISOString(),
    recordingProfileId: schedule.recordingProfileId,
    scheduleId: schedule.id,
    source: "schedule",
    status: "recording",
    tags: uniqueTags(schedule.tags),
    watchdogPolicyId: schedule.watchdogPolicyId,
  };
}

function templateContext(
  schedule: ScheduleSummary,
  node: { alias: string; hostname: string; id: string; location: { room: string; site: string } },
  now: Date,
) {
  const clock = scheduleClock(now, schedule.timezone);

  return new Map([
    ["date", clock.date],
    ["node.alias", node.alias],
    ["node.hostname", node.hostname],
    ["node.id", node.id],
    ["room", schedule.room],
    ["schedule.id", schedule.id],
    ["schedule.name", schedule.name],
    ["site", node.location.site],
    ["time", clock.time],
    ["timestamp", now.toISOString()],
  ]);
}

function renderTemplate(template: string, values: Map<string, string>) {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey: string) => {
    const key = rawKey.trim();

    return values.get(key) ?? "";
  });
}

function scheduleClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";

  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}${value("minute")}`,
  };
}

function safePath(value: string) {
  const path = value
    .split(/[\\/]+/)
    .map(safeText)
    .filter(Boolean)
    .join("/");

  return path || "Scheduled";
}

function safeText(value: string) {
  const text = value
    .replace(/[<>:"\\|?*]+/g, "-")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\t", " ")
    .replace(/\s+/g, " ")
    .trim();

  return text || "Scheduled Recording";
}

function uniqueTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function scheduleExecutionSnapshot(schedule: ScheduleSummary) {
  return {
    folderTemplate: schedule.folderTemplate,
    recordingProfileId: schedule.recordingProfileId,
    tags: schedule.tags,
    titleTemplate: schedule.titleTemplate,
    watchdogPolicyId: schedule.watchdogPolicyId,
  };
}

function recordingMetadataSnapshot(recording: RecordingSummary) {
  return {
    folder: recording.folder,
    name: recording.name,
    recordingProfileId: recording.recordingProfileId,
    tags: recording.tags,
    watchdogPolicyId: recording.watchdogPolicyId,
  };
}
