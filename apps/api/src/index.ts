import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context, MiddlewareHandler } from "hono";

import {
  auditOutcomeSchema,
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  type AuditEvent,
  type AuditOutcome,
  type Permission,
  type RecordingSummary,
} from "@rakkr/shared";

import { createAuditStore, type AuditEventFilters } from "./audit-store.js";
import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import { buildMeterFrame, nodes, prometheusMetrics, recordings, schedules } from "./demo-data.js";
import { loadRecordingFile, recordingFileName, recordingHasCachedFile } from "./recording-cache.js";

const startedAt = new Date();
const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.RAKKR_WEB_ORIGIN ?? "http://localhost:5173";

type AuditTarget = AuditEvent["target"];
type AppBindings = {
  Variables: {
    auth: AuthResult;
  };
};

const auditStore = createAuditStore();
const authService = new LocalAuthService();
const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const optionalTextFilterSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().max(160).optional(),
);
const optionalDateFilterSchema = optionalTextFilterSchema.refine(
  (value) => !value || !Number.isNaN(Date.parse(value)),
  "Expected an ISO date/time value",
);
const auditEventsQuerySchema = z.object({
  action: optionalTextFilterSchema,
  actor: optionalTextFilterSchema,
  from: optionalDateFilterSchema,
  limit: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).max(500).optional(),
  ),
  outcome: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    auditOutcomeSchema.optional(),
  ),
  target: optionalTextFilterSchema,
  to: optionalDateFilterSchema,
});

function requestContext(c: Context<AppBindings>, sessionId?: string) {
  return {
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
    sessionId: sessionId ?? c.req.header("x-rakkr-session-id"),
    userAgent: c.req.header("user-agent"),
  };
}

async function recordAuditEvent(
  c: Context<AppBindings>,
  input: {
    action: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
    correlationIds?: Record<string, string>;
    details?: Record<string, unknown>;
    outcome: AuditOutcome;
    permission?: Permission;
    reason?: string;
    target: AuditTarget;
    auth?: AuthResult;
  },
) {
  const actor = input.auth?.user
    ? {
        id: input.auth.user.id,
        name: input.auth.user.name,
        roles: input.auth.user.roles,
        type: "user" as const,
      }
    : {
        id: "anonymous",
        name: "Anonymous",
        roles: [],
        type: "user" as const,
      };
  const event: AuditEvent = {
    action: input.action,
    actor,
    actorContext: requestContext(c, input.auth?.sessionId),
    after: input.after,
    before: input.before,
    correlationIds: input.correlationIds,
    createdAt: new Date().toISOString(),
    details: {
      method: c.req.method,
      path: c.req.path,
      ...input.details,
    },
    id: `audit_${randomUUID()}`,
    outcome: input.outcome,
    permission: input.permission,
    reason: input.reason,
    target: input.target,
  };

  await auditStore.append(event);

  return event;
}

function requirePermission(
  permission: Permission,
  action: string,
  target: (c: Context<AppBindings>) => AuditTarget = () => ({ type: "controller" }),
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = await authService.authenticate(c.req.header("authorization"));
    const auditTarget = target(c);
    const hasPermission = auth.user?.permissions.includes(permission) ?? false;
    const hasScope = auth.user ? hasResourceScope(auth.user, auditTarget) : false;
    const allowed = hasPermission && hasScope;
    const reason = authorizationReason({
      authenticated: Boolean(auth.user),
      hasPermission,
      hasScope,
    });

    await recordAuditEvent(c, {
      action,
      auth,
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: auth.user?.roles ?? [],
      },
      outcome: allowed ? "allowed" : "denied",
      permission,
      reason,
      target: auditTarget,
    });

    if (!allowed) {
      return c.json(
        {
          error: auth.user ? "Forbidden" : "Unauthorized",
          permission,
        },
        auth.user ? 403 : 401,
      );
    }

    c.set("auth", auth);
    await next();
  };
}

function authorizationReason(input: {
  authenticated: boolean;
  hasPermission: boolean;
  hasScope: boolean;
}) {
  if (!input.authenticated) {
    return "unauthenticated";
  }

  if (!input.hasPermission) {
    return "missing_permission";
  }

  if (!input.hasScope) {
    return "missing_resource_scope";
  }

  return undefined;
}

function auditFilters(input: z.infer<typeof auditEventsQuerySchema>): AuditEventFilters {
  return {
    action: input.action,
    actor: input.actor,
    from: input.from ? new Date(input.from) : undefined,
    limit: input.limit,
    outcome: input.outcome,
    target: input.target,
    to: input.to ? new Date(input.to) : undefined,
  };
}

function hasResourceScope(user: AuthResult["user"], target: AuditTarget) {
  if (!user || !target.id) {
    return Boolean(user);
  }

  if (user.roles.includes("owner") || user.roles.includes("admin")) {
    return true;
  }

  return resourceScopeTargets(target).some((candidate) =>
    user.resourceGrants.some(
      (grant) =>
        (grant.resourceType === candidate.type || grant.resourceType === "*") &&
        (grant.resourceId === candidate.id || grant.resourceId === "*"),
    ),
  );
}

function resourceScopeTargets(target: AuditTarget): AuditTarget[] {
  const targets = [target];

  if (target.type === "recording" && target.id) {
    const recording = recordings.find((candidate) => candidate.id === target.id);

    if (recording?.nodeId) {
      targets.push({ id: recording.nodeId, type: "node" });
    }

    if (recording?.scheduleId) {
      targets.push({ id: recording.scheduleId, type: "schedule" });
    }
  }

  if (target.type === "schedule" && target.id) {
    const schedule = schedules.find((candidate) => candidate.id === target.id);

    if (schedule?.nodeId) {
      targets.push({ id: schedule.nodeId, type: "node" });
    }
  }

  return targets.filter(
    (candidate, index, allTargets) =>
      candidate.id &&
      allTargets.findIndex(
        (other) => other.type === candidate.type && other.id === candidate.id,
      ) === index,
  );
}

function currentAuth(c: Context<AppBindings>) {
  return c.get("auth");
}

function currentUser(c: Context<AppBindings>) {
  const user = currentAuth(c).user;

  if (!user) {
    throw new Error("Authenticated route reached without a user");
  }

  return user;
}

function scopedNodes(user: NonNullable<AuthResult["user"]>) {
  return nodes.filter((node) => hasResourceScope(user, { id: node.id, type: "node" }));
}

function scopedSchedules(user: NonNullable<AuthResult["user"]>) {
  return schedules.filter((schedule) =>
    hasResourceScope(user, { id: schedule.id, type: "schedule" }),
  );
}

function scopedRecordings(user: NonNullable<AuthResult["user"]>) {
  return recordings.filter((recording) =>
    hasResourceScope(user, { id: recording.id, type: "recording" }),
  );
}

async function recordRecordingFileFailure(
  c: Context<AppBindings>,
  input: {
    action: string;
    permission: Permission;
    reason: string;
    recordingId: string;
    targetName?: string;
  },
) {
  await recordAuditEvent(c, {
    action: input.action,
    auth: currentAuth(c),
    outcome: "failed",
    permission: input.permission,
    reason: input.reason,
    target: {
      id: input.recordingId,
      name: input.targetName,
      type: "recording",
    },
  });
}

async function serveRecordingFile(
  c: Context<AppBindings>,
  recordingId: string,
  disposition: "attachment" | "inline",
  permission: Permission,
) {
  const recording = recordings.find((candidate) => candidate.id === recordingId);
  const action =
    disposition === "attachment" ? "recordings.download.file" : "recordings.playback.stream";

  if (!recording || !recordingHasCachedFile(recording)) {
    await recordRecordingFileFailure(c, {
      action: `${action}.failed`,
      permission,
      reason: recording ? "recording_not_cached" : "recording_not_found",
      recordingId,
      targetName: recording?.name,
    });

    return c.json(
      { error: recording ? "Recording is not cached" : "Recording not found" },
      recording ? 409 : 404,
    );
  }

  const file = await loadRecordingFile(recording);

  await recordAuditEvent(c, {
    action: `${action}.succeeded`,
    auth: currentAuth(c),
    details: {
      disposition,
      fileName: file.fileName,
      size: file.size,
    },
    outcome: "succeeded",
    permission,
    target: {
      id: recording.id,
      name: recording.name,
      type: "recording",
    },
  });

  return c.body(new Uint8Array(file.bytes), 200, {
    "Content-Disposition": `${disposition}; filename="${file.fileName}"`,
    "Content-Length": file.size.toString(),
    "Content-Type": file.mimeType,
  });
}

export const app = new Hono<AppBindings>();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    origin: webOrigin,
  }),
);

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    service: "rakkr-api",
    startedAt: startedAt.toISOString(),
  }),
);

app.get("/metrics", requirePermission("metrics:read", "metrics.read"), (c) =>
  c.text(prometheusMetrics(), 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  }),
);

app.get("/api/v1/status", requirePermission("node:read", "status.read"), (c) => {
  const visibleNodes = scopedNodes(currentUser(c));
  const visibleRecordings = scopedRecordings(currentUser(c));

  return c.json({
    activeRecordings: visibleRecordings.filter((recording) => recording.status === "recording")
      .length,
    cachedRecordings: visibleRecordings.filter((recording) => recording.cached).length,
    criticalAlerts: 0,
    nodeCount: visibleNodes.length,
    onlineNodes: visibleNodes.filter((node) => node.status === "online").length,
    recordingProfile: defaultVoiceRecordingProfile,
    startedAt: startedAt.toISOString(),
    watchdogPolicy: defaultScheduledVoiceWatchdogPolicy,
  });
});

app.post("/api/v1/auth/login", async (c) => {
  const body = loginRequestSchema.safeParse(await c.req.json().catch(() => ({})));

  if (!body.success) {
    await recordAuditEvent(c, {
      action: "auth.login.failed",
      details: {
        reason: "invalid_request",
      },
      outcome: "failed",
      reason: "invalid_request",
      target: {
        type: "user",
      },
    });

    return c.json({ error: "Invalid login request" }, 400);
  }

  try {
    const result = await authService.login(body.data.email, body.data.password, requestContext(c));

    await recordAuditEvent(c, {
      action: "auth.login.succeeded",
      auth: {
        sessionId: result.sessionId,
        user: result.user,
      },
      outcome: "succeeded",
      target: {
        id: result.user.id,
        name: result.user.email,
        type: "user",
      },
    });

    return c.json({ data: result });
  } catch (error) {
    const reason = error instanceof AuthError ? error.code : "unknown_auth_error";

    await recordAuditEvent(c, {
      action: "auth.login.failed",
      details: {
        email: body.data.email,
      },
      outcome: "failed",
      reason,
      target: {
        name: body.data.email,
        type: "user",
      },
    });

    return c.json({ error: "Invalid credentials" }, 401);
  }
});

app.post("/api/v1/auth/logout", async (c) => {
  const auth = await authService.authenticate(c.req.header("authorization"));

  await authService.logout(c.req.header("authorization"));

  await recordAuditEvent(c, {
    action: "auth.logout.succeeded",
    auth,
    outcome: "succeeded",
    target: {
      id: auth.user?.id,
      name: auth.user?.email,
      type: "user",
    },
  });

  return c.body(null, 204);
});

app.get("/api/v1/auth/me", async (c) => {
  const auth = await authService.authenticate(c.req.header("authorization"));

  if (!auth.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    data: auth.user,
  });
});

app.get("/api/v1/audit-events", requirePermission("audit:read", "audit.events.read"), async (c) => {
  const query = auditEventsQuerySchema.safeParse(c.req.query());

  if (!query.success) {
    return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
  }

  return c.json({ data: await auditStore.list(auditFilters(query.data)) });
});

app.get("/api/v1/nodes", requirePermission("node:read", "nodes.read"), (c) =>
  c.json({ data: scopedNodes(currentUser(c)) }),
);
app.get(
  "/api/v1/nodes/:nodeId/meters",
  requirePermission("node:read", "meters.read", (c) => ({
    id: c.req.param("nodeId"),
    type: "node",
  })),
  async (c) => {
    const nodeId = c.req.param("nodeId");
    const frame = buildMeterFrame();

    if (nodeId !== frame.nodeId) {
      return c.json({ error: "Node not found" }, 404);
    }

    return c.json({ data: frame });
  },
);

app.post(
  "/api/v1/nodes/:nodeId/listen",
  requirePermission("listen:monitor", "listen.monitor.start", (c) => ({
    id: c.req.param("nodeId"),
    type: "node",
  })),
  async (c) => {
    const nodeId = c.req.param("nodeId");
    const node = nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      await recordAuditEvent(c, {
        action: "listen.monitor.start.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "listen:monitor",
        reason: "node_not_found",
        target: {
          id: nodeId,
          type: "node",
        },
      });

      return c.json({ error: "Node not found" }, 404);
    }

    const sessionId = `listen_${randomUUID()}`;

    await recordAuditEvent(c, {
      action: "listen.monitor.start.succeeded",
      auth: currentAuth(c),
      correlationIds: {
        listenSessionId: sessionId,
      },
      details: {
        mode: "stubbed",
        targetLatencyMs: 1500,
      },
      outcome: "succeeded",
      permission: "listen:monitor",
      target: {
        id: node.id,
        name: node.alias,
        type: "node",
      },
    });

    return c.json(
      {
        data: {
          mode: "stubbed",
          nodeId: node.id,
          sessionId,
          startedAt: new Date().toISOString(),
          targetLatencyMs: 1500,
        },
      },
      202,
    );
  },
);

app.get("/api/v1/meter-events", requirePermission("node:read", "meters.stream"), (c) => {
  const user = currentUser(c);

  return streamSSE(c, async (stream) => {
    while (true) {
      const frame = buildMeterFrame();

      if (hasResourceScope(user, { id: frame.nodeId, type: "node" })) {
        await stream.writeSSE({
          data: JSON.stringify(frame),
          event: "meter",
        });
      }

      await stream.sleep(1000);
    }
  });
});

app.get("/api/v1/schedules", requirePermission("schedule:read", "schedules.read"), (c) =>
  c.json({ data: scopedSchedules(currentUser(c)) }),
);
app.get("/api/v1/recordings", requirePermission("recording:read", "recordings.read"), (c) =>
  c.json({ data: scopedRecordings(currentUser(c)) }),
);

app.post(
  "/api/v1/recordings/:recordingId/playback",
  requirePermission("recording:playback", "recordings.playback.start", (c) => ({
    id: c.req.param("recordingId"),
    type: "recording",
  })),
  async (c) => {
    const recordingId = c.req.param("recordingId");
    const recording = recordings.find((candidate) => candidate.id === recordingId);

    if (!recording) {
      await recordRecordingFileFailure(c, {
        action: "recordings.playback.failed",
        permission: "recording:playback",
        reason: "recording_not_found",
        recordingId,
      });

      return c.json({ error: "Recording not found" }, 404);
    }

    if (!recordingHasCachedFile(recording)) {
      await recordRecordingFileFailure(c, {
        action: "recordings.playback.failed",
        permission: "recording:playback",
        reason: "recording_not_cached",
        recordingId,
        targetName: recording.name,
      });

      return c.json({ error: "Recording is not ready for playback" }, 409);
    }

    const sessionId = `playback_${randomUUID()}`;

    await recordAuditEvent(c, {
      action: "recordings.playback.started",
      auth: currentAuth(c),
      correlationIds: {
        playbackSessionId: sessionId,
        recordingId: recording.id,
      },
      details: {
        mode: "stubbed",
        source: recording.source,
      },
      outcome: "succeeded",
      permission: "recording:playback",
      target: {
        id: recording.id,
        name: recording.name,
        type: "recording",
      },
    });

    return c.json(
      {
        data: {
          mode: "stubbed",
          recordingId: recording.id,
          sessionId,
          startedAt: new Date().toISOString(),
          streamUrl: `/api/v1/recordings/${recording.id}/stream`,
        },
      },
      202,
    );
  },
);

app.post(
  "/api/v1/recordings/:recordingId/download",
  requirePermission("recording:download", "recordings.download.prepare", (c) => ({
    id: c.req.param("recordingId"),
    type: "recording",
  })),
  async (c) => {
    const recordingId = c.req.param("recordingId");
    const recording = recordings.find((candidate) => candidate.id === recordingId);

    if (!recording) {
      await recordRecordingFileFailure(c, {
        action: "recordings.download.failed",
        permission: "recording:download",
        reason: "recording_not_found",
        recordingId,
      });

      return c.json({ error: "Recording not found" }, 404);
    }

    if (!recordingHasCachedFile(recording)) {
      await recordRecordingFileFailure(c, {
        action: "recordings.download.failed",
        permission: "recording:download",
        reason: "recording_not_cached",
        recordingId,
        targetName: recording.name,
      });

      return c.json({ error: "Recording is not ready for download" }, 409);
    }

    const downloadId = `download_${randomUUID()}`;

    await recordAuditEvent(c, {
      action: "recordings.download.prepared",
      auth: currentAuth(c),
      correlationIds: {
        downloadId,
        recordingId: recording.id,
      },
      details: {
        fileName: recordingFileName(recording),
        mode: "stubbed",
      },
      outcome: "succeeded",
      permission: "recording:download",
      target: {
        id: recording.id,
        name: recording.name,
        type: "recording",
      },
    });

    return c.json(
      {
        data: {
          downloadId,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          fileName: recordingFileName(recording),
          mode: "stubbed",
          recordingId: recording.id,
          url: `/api/v1/recordings/${recording.id}/file`,
        },
      },
      202,
    );
  },
);

app.get(
  "/api/v1/recordings/:recordingId/stream",
  requirePermission("recording:playback", "recordings.playback.stream", (c) => ({
    id: c.req.param("recordingId"),
    type: "recording",
  })),
  async (c) => serveRecordingFile(c, c.req.param("recordingId"), "inline", "recording:playback"),
);

app.get(
  "/api/v1/recordings/:recordingId/file",
  requirePermission("recording:download", "recordings.download.file", (c) => ({
    id: c.req.param("recordingId"),
    type: "recording",
  })),
  async (c) =>
    serveRecordingFile(c, c.req.param("recordingId"), "attachment", "recording:download"),
);

app.post(
  "/api/v1/recordings",
  requirePermission("recording:create", "recordings.start", () => ({
    id: "node_x32_test",
    name: "Council Chamber Rack",
    type: "node",
  })),
  async (c) => {
    const now = new Date();
    const recording: RecordingSummary = {
      cached: false,
      durationSeconds: 0,
      folder: `Ad Hoc/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
      healthStatus: "unknown",
      id: `rec_${randomUUID()}`,
      name: `${now.toISOString().slice(0, 16).replace("T", "_")}_Ad Hoc_Council Chamber Rack`,
      nodeId: "node_x32_test",
      recordedAt: now.toISOString(),
      source: "ad_hoc",
      status: "recording",
      tags: ["ad-hoc", "voice"],
    };

    recordings.unshift(recording);

    await recordAuditEvent(c, {
      action: "recordings.start.succeeded",
      auth: currentAuth(c),
      correlationIds: {
        recordingId: recording.id,
      },
      details: {
        profileId: defaultVoiceRecordingProfile.id,
        source: recording.source,
      },
      outcome: "succeeded",
      permission: "recording:create",
      target: {
        id: recording.id,
        name: recording.name,
        type: "recording",
      },
    });

    return c.json({ data: recording }, 202);
  },
);

app.post(
  "/api/v1/recordings/:recordingId/stop",
  requirePermission("recording:control", "recordings.stop", (c) => ({
    id: c.req.param("recordingId"),
    type: "recording",
  })),
  async (c) => {
    const recordingId = c.req.param("recordingId");
    const recording = recordings.find((candidate) => candidate.id === recordingId);

    if (!recording) {
      await recordAuditEvent(c, {
        action: "recordings.stop.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "recording:control",
        reason: "recording_not_found",
        target: {
          id: recordingId,
          type: "recording",
        },
      });

      return c.json({ error: "Recording not found" }, 404);
    }

    const before = { status: recording.status };

    recording.cached = true;
    recording.cachePath = `ad-hoc/${recording.id}.mp3`;
    recording.durationSeconds = Math.max(recording.durationSeconds, 1);
    recording.status = "cached";

    await recordAuditEvent(c, {
      action: "recordings.stop.succeeded",
      auth: currentAuth(c),
      after: {
        status: recording.status,
      },
      before,
      correlationIds: {
        recordingId: recording.id,
      },
      outcome: "succeeded",
      permission: "recording:control",
      target: {
        id: recording.id,
        name: recording.name,
        type: "recording",
      },
    });

    return c.json({ data: recording });
  },
);

if (process.env.RAKKR_API_NO_LISTEN !== "1") {
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`Rakkr API listening on http://localhost:${info.port}`);
    },
  );
}
