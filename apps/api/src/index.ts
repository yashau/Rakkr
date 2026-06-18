import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context, MiddlewareHandler } from "hono";

import { registerAgentRoutes } from "./agent-routes.js";
import {
  accessGroupIdSchema,
  accessPolicyInputSchema,
  auditOutcomeSchema,
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  resourceGrantSchema,
  roleSchema,
  type AuditEvent,
  type CurrentUser,
  type Permission,
  type RecorderNode,
  type ScheduleSummary,
} from "@rakkr/shared";

import { createAuditStore, type AuditEventFilters } from "./audit-store.js";
import { registerAuthLifecycleRoutes } from "./auth-lifecycle-routes.js";
import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import { accessKeepsAuthManage, accessSnapshot } from "./auth-utils.js";
import { registerHealthRoutes } from "./health-routes.js";
import { createHealthEventStore } from "./health-store.js";
import type { RecordAuditEvent } from "./http-types.js";
import {
  nodes as seedNodes,
  buildMeterFrame,
  prometheusMetrics,
  recordings,
  schedules as seedSchedules,
} from "./demo-data.js";
import type { AppBindings, AuditTarget } from "./http-types.js";
import { createMeterFrameStore } from "./meter-store.js";
import { registerNodeRoutes } from "./node-routes.js";
import { createNodeStore } from "./node-store.js";
import { registerRecordingRoutes } from "./recording-routes.js";
import { createRecordingStore } from "./recording-store.js";
import { registerScheduleRoutes } from "./schedule-routes.js";
import { createScheduleRunner } from "./schedule-runner.js";
import { createScheduleStore } from "./schedule-store.js";
import { createWatchdogRunner } from "./watchdog-runner.js";

const startedAt = new Date();
const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.RAKKR_WEB_ORIGIN ?? "http://localhost:5173";

const auditStore = createAuditStore();
const authService = new LocalAuthService();
const healthEventStore = createHealthEventStore();
const meterFrameStore = createMeterFrameStore();
const nodeStore = createNodeStore(seedNodes);
const recordingStore = createRecordingStore(recordings);
const scheduleStore = createScheduleStore(seedSchedules);
export const scheduleRunner = createScheduleRunner({
  auditStore,
  nodeStore,
  recordingStore,
  scheduleStore,
});
export const watchdogRunner = createWatchdogRunner({
  auditStore,
  healthEventStore,
  meterFrameProvider: (nodeId) => watchdogMeterFrame(nodeId),
  recordingStore,
});
type NodeRecord = RecorderNode;
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
    groupIds: z.array(accessGroupIdSchema).max(64).default([]),
    resourceGrants: z.array(resourceGrantSchema).default([]),
    roles: z.array(roleSchema).min(1),
  })
  .strict();
const localUserCreateRequestSchema = userAccessRequestSchema.extend({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(160),
  password: z.string().min(8).max(200),
});
const accessPolicyUpdateSchema = z.object({
  policies: z.array(accessPolicyInputSchema).default([]),
});

function requestContext(c: Context<AppBindings>, sessionId?: string) {
  return {
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
    sessionId: sessionId ?? c.req.header("x-rakkr-session-id"),
    userAgent: c.req.header("user-agent"),
  };
}

const recordAuditEvent: RecordAuditEvent = async (c, input) => {
  const actor =
    input.actor ??
    (input.auth?.user
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
        });
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
};

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
    const scope = auth.user
      ? await resourceScopeDecision(auth.user, auditTarget)
      : { allowed: false, reason: "unauthenticated" };
    const allowed = hasPermission && scope.allowed;
    const reason = authorizationReason({
      authenticated: Boolean(auth.user),
      hasPermission,
      hasScope: scope.allowed,
      scopeReason: scope.reason,
    });

    await recordAuditEvent(c, {
      action,
      auth,
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        resourceScopeDecision: scope.reason,
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
  scopeReason?: string;
}) {
  if (!input.authenticated) {
    return "unauthenticated";
  }

  if (!input.hasPermission) {
    return "missing_permission";
  }

  if (!input.hasScope) {
    return input.scopeReason ?? "missing_resource_scope";
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

async function hasResourceScope(user: AuthResult["user"], target: AuditTarget) {
  return (await resourceScopeDecision(user, target)).allowed;
}

async function resourceScopeDecision(user: AuthResult["user"], target: AuditTarget) {
  if (!user || !target.id) {
    return {
      allowed: Boolean(user),
      reason: user ? undefined : "unauthenticated",
    };
  }

  const targets = await resourceScopeTargets(target);
  const policyDecision = await authService.accessPolicyDecision(user, targets);

  if (policyDecision?.effect === "deny") {
    return {
      allowed: false,
      reason: "access_policy_denied",
    };
  }

  if (user.roles.includes("owner") || user.roles.includes("admin")) {
    return {
      allowed: true,
      reason: undefined,
    };
  }

  if (policyDecision?.effect === "allow") {
    return {
      allowed: true,
      reason: undefined,
    };
  }

  const allowedByGrant = targets.some((candidate) =>
    user.resourceGrants.some(
      (grant) =>
        (grant.resourceType === candidate.type || grant.resourceType === "*") &&
        (grant.resourceId === candidate.id || grant.resourceId === "*"),
    ),
  );

  return {
    allowed: allowedByGrant,
    reason: allowedByGrant ? undefined : "missing_resource_scope",
  };
}

async function resourceScopeTargets(target: AuditTarget): Promise<AuditTarget[]> {
  const targets = [target];
  const knownNodes = await nodeStore.list();

  if (target.type === "recording" && target.id) {
    const recording = await recordingStore.find(target.id);

    if (recording?.scheduleId) {
      await addScheduleScopeTargets(targets, recording.scheduleId, knownNodes);
    }

    if (recording?.nodeId) {
      addNodeScopeTargets(targets, recording.nodeId, knownNodes);
    }
  }

  if (target.type === "schedule" && target.id) {
    await addScheduleScopeTargets(targets, target.id, knownNodes);
  }

  if (target.type === "node" && target.id) {
    addNodeScopeTargets(targets, target.id, knownNodes);
  }

  if (target.type === "interface" && target.id) {
    addInterfaceScopeTargets(targets, target.id, knownNodes);
  }

  if (target.type === "channel" && target.id) {
    addChannelScopeTargets(targets, target.id, knownNodes);
  }

  return targets.filter(
    (candidate, index, allTargets) =>
      candidate.id &&
      allTargets.findIndex(
        (other) => other.type === candidate.type && other.id === candidate.id,
      ) === index,
  );
}

async function addScheduleScopeTargets(
  targets: AuditTarget[],
  scheduleId: string,
  knownNodes: NodeRecord[],
) {
  const schedule = await scheduleStore.find(scheduleId);

  if (!schedule) {
    return;
  }

  targets.push({ id: schedule.id, type: "schedule" }, { id: schedule.room, type: "room" });
  addNodeScopeTargets(targets, schedule.nodeId, knownNodes);
}

function addNodeScopeTargets(targets: AuditTarget[], nodeId: string, knownNodes: NodeRecord[]) {
  const node = knownNodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return;
  }

  targets.push({ id: node.id, type: "node" });
  addRoomScopeTargets(targets, node);
}

function addInterfaceScopeTargets(
  targets: AuditTarget[],
  interfaceId: string,
  knownNodes: NodeRecord[],
) {
  const match = interfaceNode(interfaceId, knownNodes);

  if (!match) {
    return;
  }

  targets.push({ id: match.audioInterface.id, type: "interface" });
  addNodeScopeTargets(targets, match.node.id, knownNodes);
}

function addChannelScopeTargets(
  targets: AuditTarget[],
  channelId: string,
  knownNodes: NodeRecord[],
) {
  const match = channelNode(channelId, knownNodes);

  if (!match) {
    return;
  }

  targets.push({ id: match.channelId, type: "channel" });
  addInterfaceScopeTargets(targets, match.audioInterface.id, knownNodes);
}

function addRoomScopeTargets(targets: AuditTarget[], node: NodeRecord) {
  targets.push({ id: node.location.site, type: "site" }, { id: node.location.room, type: "room" });

  if (node.location.site && node.location.room) {
    targets.push({ id: `${node.location.site}/${node.location.room}`, type: "room" });
  }
}

function interfaceNode(interfaceId: string, knownNodes: NodeRecord[]) {
  for (const node of knownNodes) {
    const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);

    if (audioInterface) {
      return { audioInterface, node };
    }
  }

  return undefined;
}

function channelNode(channelId: string, knownNodes: NodeRecord[]) {
  for (const node of knownNodes) {
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

async function recordUserAccessUpdateFailure(
  c: Context<AppBindings>,
  userId: string,
  reason: string,
) {
  await recordAuditEvent(c, {
    action: "auth.users.access.update.failed",
    auth: currentAuth(c),
    outcome: "failed",
    permission: "auth:manage",
    reason,
    target: {
      id: userId,
      type: "user",
    },
  });
}

async function scopedNodes(user: NonNullable<AuthResult["user"]>) {
  const result: NodeRecord[] = [];

  for (const node of await nodeStore.list()) {
    if (await hasResourceScope(user, { id: node.id, type: "node" })) {
      result.push(node);
    }
  }

  return result;
}

async function scopedSchedules(user: NonNullable<AuthResult["user"]>) {
  const result: ScheduleSummary[] = [];

  for (const schedule of await scheduleStore.list()) {
    if (await hasResourceScope(user, { id: schedule.id, type: "schedule" })) {
      result.push(schedule);
    }
  }

  return result;
}

async function scopedRecordings(user: NonNullable<AuthResult["user"]>) {
  const result = [];

  for (const recording of await recordingStore.list()) {
    if (await hasResourceScope(user, { id: recording.id, type: "recording" })) {
      result.push(recording);
    }
  }

  return result;
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

app.get("/api/v1/status", requirePermission("node:read", "status.read"), async (c) => {
  const visibleNodes = await scopedNodes(currentUser(c));
  const visibleRecordings = await scopedRecordings(currentUser(c));

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
  "/api/v1/auth/groups",
  requirePermission("auth:manage", "auth.groups.read", () => ({ type: "auth" })),
  async (c) => {
    const groups = await authService.localGroups();

    await recordAuditEvent(c, {
      action: "auth.groups.read.succeeded",
      auth: currentAuth(c),
      details: {
        count: groups.length,
      },
      outcome: "succeeded",
      permission: "auth:manage",
      target: {
        type: "auth",
      },
    });

    return c.json({ data: groups });
  },
);

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

app.post(
  "/api/v1/auth/users",
  requirePermission("auth:manage", "auth.users.create", () => ({ type: "auth" })),
  async (c) => {
    const body = localUserCreateRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordAuditEvent(c, {
        action: "auth.users.create.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "auth:manage",
        reason: "invalid_request",
        target: {
          type: "user",
        },
      });

      return c.json({ error: "Invalid local user", issues: body.error.issues }, 400);
    }

    try {
      const created = await authService.createLocalUser(body.data);

      await recordAuditEvent(c, {
        action: "auth.users.create.succeeded",
        after: accessSnapshot(created),
        auth: currentAuth(c),
        details: {
          email: created.email,
          provider: created.provider,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          id: created.id,
          name: created.email,
          type: "user",
        },
      });

      return c.json({ data: created }, 201);
    } catch (error) {
      const reason = error instanceof AuthError ? error.code : "unknown_user_create_error";

      await recordAuditEvent(c, {
        action: "auth.users.create.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "auth:manage",
        reason,
        target: {
          name: body.data.email,
          type: "user",
        },
      });

      return c.json(
        {
          error: reason === "user_exists" ? "Local user already exists" : "Local user unavailable",
        },
        reason === "user_exists" ? 409 : 503,
      );
    }
  },
);

app.get(
  "/api/v1/auth/access-policies",
  requirePermission("auth:manage", "auth.access_policies.read", () => ({ type: "auth" })),
  async (c) => {
    const policies = await authService.accessPolicies();

    await recordAuditEvent(c, {
      action: "auth.access_policies.read.succeeded",
      auth: currentAuth(c),
      details: {
        count: policies.length,
      },
      outcome: "succeeded",
      permission: "auth:manage",
      target: {
        type: "auth",
      },
    });

    return c.json({ data: policies });
  },
);

app.patch(
  "/api/v1/auth/access-policies",
  requirePermission("auth:manage", "auth.access_policies.update", () => ({ type: "auth" })),
  async (c) => {
    const body = accessPolicyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordAuditEvent(c, {
        action: "auth.access_policies.update.failed",
        auth: currentAuth(c),
        outcome: "failed",
        permission: "auth:manage",
        reason: "invalid_request",
        target: {
          type: "auth",
        },
      });

      return c.json({ error: "Invalid access policies", issues: body.error.issues }, 400);
    }

    const before = await authService.accessPolicies();
    const updated = await authService.updateLocalAccessPolicies(
      body.data.policies,
      currentUser(c).id,
    );

    await recordAuditEvent(c, {
      action: "auth.access_policies.update.succeeded",
      after: {
        policies: updated,
      },
      auth: currentAuth(c),
      before: {
        policies: before,
      },
      outcome: "succeeded",
      permission: "auth:manage",
      target: {
        type: "auth",
      },
    });

    return c.json({ data: updated });
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
      await recordUserAccessUpdateFailure(c, userId, "invalid_request");
      return c.json({ error: "Invalid access update", issues: body.error.issues }, 400);
    }

    if (userId === currentUser(c).id && !accessKeepsAuthManage(body.data.roles)) {
      await recordUserAccessUpdateFailure(c, userId, "self_auth_manage_required");
      return c.json({ error: "Local access manager must keep auth:manage" }, 400);
    }

    const before = await authService.localUser(userId);
    let updated: CurrentUser | undefined;

    try {
      updated = await authService.updateLocalUserAccess(userId, body.data);
    } catch (error) {
      const reason = error instanceof AuthError ? error.code : "unknown_access_update_error";

      await recordUserAccessUpdateFailure(c, userId, reason);
      return c.json({ error: "Local user access unavailable" }, 503);
    }

    if (!updated) {
      await recordUserAccessUpdateFailure(c, userId, "user_not_found");
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

registerAuthLifecycleRoutes({
  app,
  authService,
  currentAuth,
  currentUser,
  recordAuditEvent,
  requirePermission,
});

app.get("/api/v1/audit-events", requirePermission("audit:read", "audit.events.read"), async (c) => {
  const query = auditEventsQuerySchema.safeParse(c.req.query());

  if (!query.success) {
    return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
  }

  return c.json({ data: await auditStore.list(auditFilters(query.data)) });
});

registerNodeRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
});

registerScheduleRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scheduleStore,
  scopedSchedules,
});

registerAgentRoutes({
  app,
  healthEventStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
});

registerHealthRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  healthEventStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
});

registerRecordingRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedRecordings,
});

if (process.env.RAKKR_API_NO_LISTEN !== "1") {
  if (process.env.RAKKR_SCHEDULE_RUNNER_ENABLED !== "0") {
    scheduleRunner.start();
  }

  if (process.env.RAKKR_WATCHDOG_RUNNER_ENABLED !== "0") {
    watchdogRunner.start();
  }

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

async function watchdogMeterFrame(nodeId: string) {
  const frame = await meterFrameStore.latest(nodeId);

  if (frame) {
    return frame;
  }

  const demoFrame = buildMeterFrame();

  return demoFrame.nodeId === nodeId ? demoFrame : undefined;
}
