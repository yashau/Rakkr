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
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  type AuditEvent,
  type AuditOutcome,
  type MeterFrame,
  type Permission,
  type RecorderNode,
  type RecordingSummary,
  type ScheduleSummary,
} from "@rakkr/shared";

import { createAuditStore } from "./audit-store";
import { AuthError, LocalAuthService, type AuthResult } from "./auth-service";

const startedAt = new Date();
const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.RAKKR_WEB_ORIGIN ?? "http://localhost:5173";

type AuditTarget = AuditEvent["target"];

const auditStore = createAuditStore();
const authService = new LocalAuthService();
const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function requestContext(c: Context, sessionId?: string) {
  return {
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
    sessionId: sessionId ?? c.req.header("x-rakkr-session-id"),
    userAgent: c.req.header("user-agent"),
  };
}

async function recordAuditEvent(
  c: Context,
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
  target: (c: Context) => AuditTarget = () => ({ type: "controller" }),
): MiddlewareHandler {
  return async (c, next) => {
    const auth = await authService.authenticate(c.req.header("authorization"));
    const allowed = auth.user?.permissions.includes(permission) ?? false;
    const auditTarget = target(c);

    await recordAuditEvent(c, {
      action,
      auth,
      details: {
        requiredPermission: permission,
        roles: auth.user?.roles ?? [],
      },
      outcome: allowed ? "allowed" : "denied",
      permission,
      reason: allowed ? undefined : auth.user ? "missing_permission" : "unauthenticated",
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

    await next();
  };
}

const nodes: RecorderNode[] = [
  {
    agentVersion: "0.1.0",
    alias: "Council Chamber Rack",
    hostname: "rakkr-x32-01",
    id: "node_x32_test",
    interfaces: [
      {
        alias: "X32 USB",
        backend: "alsa",
        channelCount: 32,
        channels: Array.from({ length: 8 }, (_, index) => ({
          alias: `X32 Channel ${index + 1}`,
          index: index + 1,
        })),
        id: "iface_x32_usb",
        sampleRates: [48000],
        systemName: "Behringer X32 Rack USB",
      },
    ],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: new Date().toISOString(),
    location: {
      room: "Council Chamber",
      site: "Main Office",
    },
    notes: "Initial Debian test rig with X32 Rack over USB.",
    status: "online",
    tags: ["x32", "voice", "test-rig"],
  },
];

const schedules: ScheduleSummary[] = [
  {
    id: "sched_council_weekly",
    name: "Council Meeting",
    nextRunAt: "2026-06-22T05:00:00.000Z",
    nodeId: "node_x32_test",
    room: "Council Chamber",
    tags: ["council", "scheduled", "voice"],
    timezone: "Indian/Maldives",
  },
];

const recordings: RecordingSummary[] = [
  {
    cached: true,
    durationSeconds: 3720,
    folder: "Meetings/2026/06/Council Meeting",
    healthStatus: "healthy",
    id: "rec_demo_001",
    name: "2026-06-15_0900_Council Meeting_Council Chamber Rack",
    recordedAt: "2026-06-15T04:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: ["council", "voice"],
  },
];

function buildMeterFrame(): MeterFrame {
  const capturedAt = new Date().toISOString();
  const phase = Date.now() / 650;

  return {
    capturedAt,
    interfaceId: "iface_x32_usb",
    levels: Array.from({ length: 8 }, (_, index) => {
      const wave = Math.sin(phase + index * 0.58);
      const bump = Math.cos(phase / 2 + index * 0.23);
      const rmsDbfs = Math.max(-72, -42 + wave * 12 + bump * 5);
      const peakDbfs = Math.min(-3, rmsDbfs + 11 + Math.abs(wave) * 6);

      return {
        channelIndex: index + 1,
        clipping: peakDbfs > -1,
        label: `Ch ${index + 1}`,
        peakDbfs: Number(peakDbfs.toFixed(1)),
        rmsDbfs: Number(rmsDbfs.toFixed(1)),
      };
    }),
    nodeId: "node_x32_test",
  };
}

function prometheusMetrics() {
  const frame = buildMeterFrame();
  const lines = [
    "# HELP rakkr_node_online Whether a recorder node is online.",
    "# TYPE rakkr_node_online gauge",
    'rakkr_node_online{node_id="node_x32_test",alias="Council Chamber Rack"} 1',
    "# HELP rakkr_recording_active Active recording jobs on a node.",
    "# TYPE rakkr_recording_active gauge",
    'rakkr_recording_active{node_id="node_x32_test"} 0',
    "# HELP rakkr_input_rms_dbfs Current RMS level by audio channel.",
    "# TYPE rakkr_input_rms_dbfs gauge",
    ...frame.levels.map(
      (level) =>
        `rakkr_input_rms_dbfs{node_id="node_x32_test",interface_id="iface_x32_usb",channel="${level.channelIndex}"} ${level.rmsDbfs}`,
    ),
    "# HELP rakkr_input_peak_dbfs Current peak level by audio channel.",
    "# TYPE rakkr_input_peak_dbfs gauge",
    ...frame.levels.map(
      (level) =>
        `rakkr_input_peak_dbfs{node_id="node_x32_test",interface_id="iface_x32_usb",channel="${level.channelIndex}"} ${level.peakDbfs}`,
    ),
  ];

  return `${lines.join("\n")}\n`;
}

const app = new Hono();

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

app.get("/api/v1/status", requirePermission("node:read", "status.read"), (c) =>
  c.json({
    activeRecordings: recordings.filter((recording) => recording.status === "recording").length,
    cachedRecordings: recordings.filter((recording) => recording.cached).length,
    criticalAlerts: 0,
    nodeCount: nodes.length,
    onlineNodes: nodes.filter((node) => node.status === "online").length,
    recordingProfile: defaultVoiceRecordingProfile,
    startedAt: startedAt.toISOString(),
    watchdogPolicy: defaultScheduledVoiceWatchdogPolicy,
  }),
);

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
    const result = await authService.login(body.data.email, body.data.password);

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

app.get("/api/v1/audit-events", requirePermission("audit:read", "audit.events.read"), async (c) =>
  c.json({ data: await auditStore.list() }),
);

app.get("/api/v1/nodes", requirePermission("node:read", "nodes.read"), (c) =>
  c.json({ data: nodes }),
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

app.get("/api/v1/meter-events", requirePermission("node:read", "meters.stream"), (c) =>
  streamSSE(c, async (stream) => {
    while (true) {
      await stream.writeSSE({
        data: JSON.stringify(buildMeterFrame()),
        event: "meter",
      });
      await stream.sleep(1000);
    }
  }),
);

app.get("/api/v1/schedules", requirePermission("schedule:read", "schedules.read"), (c) =>
  c.json({ data: schedules }),
);
app.get("/api/v1/recordings", requirePermission("recording:read", "recordings.read"), (c) =>
  c.json({ data: recordings }),
);

app.post(
  "/api/v1/recordings",
  requirePermission("recording:create", "recordings.start"),
  async (c) => {
    const now = new Date();
    const recording: RecordingSummary = {
      cached: false,
      durationSeconds: 0,
      folder: `Ad Hoc/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
      healthStatus: "unknown",
      id: `rec_${randomUUID()}`,
      name: `${now.toISOString().slice(0, 16).replace("T", "_")}_Ad Hoc_Council Chamber Rack`,
      recordedAt: now.toISOString(),
      source: "ad_hoc",
      status: "recording",
      tags: ["ad-hoc", "voice"],
    };

    recordings.unshift(recording);

    await recordAuditEvent(c, {
      action: "recordings.start.succeeded",
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
    recording.durationSeconds = Math.max(recording.durationSeconds, 1);
    recording.status = "cached";

    await recordAuditEvent(c, {
      action: "recordings.stop.succeeded",
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

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Rakkr API listening on http://localhost:${info.port}`);
  },
);
