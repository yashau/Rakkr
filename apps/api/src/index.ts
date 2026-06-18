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
  resourceGrantSchema,
  rolePermissions,
  roleSchema,
  type AuditEvent,
  type AuditOutcome,
  type CurrentUser,
  type Permission,
} from "@rakkr/shared";

import { createAuditStore, type AuditEventFilters } from "./audit-store.js";
import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import { buildMeterFrame, nodes, prometheusMetrics, recordings, schedules } from "./demo-data.js";
import type { AppBindings, AuditTarget } from "./http-types.js";
import { registerRecordingRoutes } from "./recording-routes.js";

const startedAt = new Date();
const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.RAKKR_WEB_ORIGIN ?? "http://localhost:5173";

const auditStore = createAuditStore();
const authService = new LocalAuthService();
type NodeRecord = (typeof nodes)[number];
type InterfaceRecord = NodeRecord["interfaces"][number];
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
const userAccessRequestSchema = z
  .object({
    resourceGrants: z.array(resourceGrantSchema).default([]),
    roles: z.array(roleSchema).min(1),
  })
  .refine((value) => value.roles.some((role) => rolePermissions[role].includes("auth:manage")), {
    message: "Local access manager must keep auth:manage",
    path: ["roles"],
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
  target: (c: Context<AppBindings>) => AuditTarget | Promise<AuditTarget> = () => ({
    type: "controller",
  }),
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = await authService.authenticate(c.req.header("authorization"));
    const auditTarget = await target(c);
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

function accessSnapshot(user: CurrentUser | undefined) {
  return {
    resourceGrants: user?.resourceGrants ?? [],
    roles: user?.roles ?? [],
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

    if (recording?.scheduleId) {
      addScheduleScopeTargets(targets, recording.scheduleId);
    }

    if (recording?.nodeId) {
      addNodeScopeTargets(targets, recording.nodeId);
    }
  }

  if (target.type === "schedule" && target.id) {
    addScheduleScopeTargets(targets, target.id);
  }

  if (target.type === "node" && target.id) {
    addNodeScopeTargets(targets, target.id);
  }

  if (target.type === "interface" && target.id) {
    addInterfaceScopeTargets(targets, target.id);
  }

  if (target.type === "channel" && target.id) {
    addChannelScopeTargets(targets, target.id);
  }

  return targets.filter(
    (candidate, index, allTargets) =>
      candidate.id &&
      allTargets.findIndex(
        (other) => other.type === candidate.type && other.id === candidate.id,
      ) === index,
  );
}

function addScheduleScopeTargets(targets: AuditTarget[], scheduleId: string) {
  const schedule = schedules.find((candidate) => candidate.id === scheduleId);

  if (!schedule) {
    return;
  }

  targets.push({ id: schedule.id, type: "schedule" }, { id: schedule.room, type: "room" });
  addNodeScopeTargets(targets, schedule.nodeId);
}

function addNodeScopeTargets(targets: AuditTarget[], nodeId: string) {
  const node = nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return;
  }

  targets.push({ id: node.id, type: "node" });
  addRoomScopeTargets(targets, node);
}

function addInterfaceScopeTargets(targets: AuditTarget[], interfaceId: string) {
  const match = interfaceNode(interfaceId);

  if (!match) {
    return;
  }

  targets.push({ id: match.audioInterface.id, type: "interface" });
  addNodeScopeTargets(targets, match.node.id);
}

function addChannelScopeTargets(targets: AuditTarget[], channelId: string) {
  const match = channelNode(channelId);

  if (!match) {
    return;
  }

  targets.push({ id: match.channelId, type: "channel" });
  addInterfaceScopeTargets(targets, match.audioInterface.id);
}

function addRoomScopeTargets(targets: AuditTarget[], node: NodeRecord) {
  targets.push({ id: node.location.site, type: "site" }, { id: node.location.room, type: "room" });

  if (node.location.site && node.location.room) {
    targets.push({ id: `${node.location.site}/${node.location.room}`, type: "room" });
  }
}

function interfaceNode(interfaceId: string) {
  for (const node of nodes) {
    const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);

    if (audioInterface) {
      return { audioInterface, node };
    }
  }

  return undefined;
}

function channelNode(channelId: string) {
  for (const node of nodes) {
    for (const audioInterface of node.interfaces) {
      const channel = audioInterface.channels.find((candidate) =>
        channelScopeIds(node, audioInterface, candidate.index).includes(channelId),
      );

      if (channel) {
        return {
          audioInterface,
          channel,
          channelId: `${audioInterface.id}:${channel.index}`,
          node,
        };
      }
    }
  }

  return undefined;
}

function channelScopeIds(node: NodeRecord, audioInterface: InterfaceRecord, channelIndex: number) {
  return [
    `${audioInterface.id}:${channelIndex}`,
    `${node.id}:${audioInterface.id}:${channelIndex}`,
  ];
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

app.get(
  "/api/v1/auth/users",
  requirePermission("auth:manage", "auth.users.read", () => ({ type: "auth" })),
  async (c) => {
    const users = await authService.localUsers();

    await recordAuditEvent(c, {
      action: "auth.users.read.succeeded",
      auth: currentAuth(c),
      details: {
        count: users.length,
      },
      outcome: "succeeded",
      permission: "auth:manage",
      target: {
        type: "auth",
      },
    });

    return c.json({ data: users });
  },
);

app.patch(
  "/api/v1/auth/users/:userId/access",
  requirePermission("auth:manage", "auth.users.access.update", (c) => ({
    id: c.req.param("userId"),
    type: "user",
  })),
  async (c) => {
    const userId = c.req.param("userId");
    const body = userAccessRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordAuditEvent(c, {
        action: "auth.users.access.update.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "auth:manage",
        reason: "invalid_request",
        target: {
          id: userId,
          type: "user",
        },
      });

      return c.json({ error: "Invalid access update", issues: body.error.issues }, 400);
    }

    const before = await authService.localUser(userId);
    const updated = await authService.updateLocalUserAccess(userId, body.data);

    if (!updated) {
      await recordAuditEvent(c, {
        action: "auth.users.access.update.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "auth:manage",
        reason: "user_not_found",
        target: {
          id: userId,
          type: "user",
        },
      });

      return c.json({ error: "User not found" }, 404);
    }

    await recordAuditEvent(c, {
      action: "auth.users.access.update.succeeded",
      after: accessSnapshot(updated),
      auth: currentAuth(c),
      before: accessSnapshot(before),
      outcome: "succeeded",
      permission: "auth:manage",
      target: {
        id: updated.id,
        name: updated.email,
        type: "user",
      },
    });

    return c.json({ data: updated });
  },
);

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

registerRecordingRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordings,
  requirePermission,
  scopedRecordings,
});

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
