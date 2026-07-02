import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context, MiddlewareHandler } from "hono";
import { registerAgentMonitorRoutes } from "./agent-monitor-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { createApiRunners, startApiRunners } from "./api-runners.js";
import {
  type AuditEvent,
  defaultCalendarGrantCapabilities,
  type Permission,
  permissionRequiresCapability,
  type RecorderNode,
  type RoomCapability,
  type ScheduleSummary,
} from "@rakkr/shared";
import { registerAuditRoutes } from "./audit-routes.js";
import { createAuditStore } from "./audit-store.js";
import { registerAuthLifecycleRoutes } from "./auth-lifecycle-routes.js";
import { registerAuthManagementRoutes } from "./auth-management-routes.js";
import { clearOidcLoginStateCookie, registerAuthOidcRoutes } from "./auth-oidc-routes.js";
import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import { registerHealthRoutes } from "./health-routes.js";
import { createHealthEventStore } from "./health-store.js";
import type { RecordAuditEvent } from "./http-types.js";
import { nodes as seedNodes, recordings, schedules as seedSchedules } from "./demo-data.js";
import type { AppBindings, AuditTarget } from "./http-types.js";
import { createListenMonitorStore } from "./listen-monitor-store.js";
import { createListenSessionStore } from "./listen-session-store.js";
import { createMeterFrameStore } from "./meter-store.js";
import { registerMetricsRoutes } from "./metrics-routes.js";
import { createNodeBootstrapStore } from "./node-bootstrap-store.js";
import { registerNodeRoutes } from "./node-routes.js";
import { createNodeStore } from "./node-store.js";
import { createNodeSshCredentialStore } from "./node-ssh-credential-store.js";
import { markAgentJobTerminalRecording } from "./agent-job-terminal-recording.js";
import { isDatabaseUnavailableError } from "./database-unavailable.js";
import { onRecordingJobLeaseExpired, recordingJob } from "./recording-jobs.js";
import { registerRecordingRoutes } from "./recording-routes.js";
import { createRecordingStore } from "./recording-store.js";
import { registerRetentionPolicyRoutes } from "./retention-policy-routes.js";
import { createRoomRosterStore } from "./room-roster-store.js";
import { registerRoomRoutes } from "./room-routes.js";
import { createRoomStore } from "./room-store.js";
import {
  addChannelScopeTargets,
  addInterfaceScopeTargets,
  addNodeScopeTargets,
} from "./scope-targets.js";
import { registerScheduleRoutes } from "./schedule-routes.js";
import { createScheduleStore } from "./schedule-store.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { createSettingsStore } from "./settings-store.js";
import { registerStatusRoutes } from "./status-routes.js";
import { registerSwitcherMappingRoutes } from "./switcher-mapping-routes.js";
import { createSwitcherMappingStore } from "./switcher-mapping-store.js";
import { registerSwitcherRoutes } from "./switcher-routes.js";
import { createSwitcherStore } from "./switcher-store.js";
import { apiListenConfig } from "./transport-security.js";
import { createUploadDestinationStore } from "./upload-destinations.js";
import { registerUploadRunnerRoutes } from "./upload-runner-routes.js";
import { registerWatchdogCalibrationRoutes } from "./watchdog-calibration-routes.js";

const startedAt = new Date();
const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.RAKKR_WEB_ORIGIN ?? "http://localhost:5173";

const auditStore = createAuditStore();
const authService = new LocalAuthService();
const healthEventStore = createHealthEventStore();
const listenMonitorStore = createListenMonitorStore();
const listenSessionStore = createListenSessionStore();
const meterFrameStore = createMeterFrameStore();
const nodeStore = createNodeStore(seedNodes);
const sshCredentialStore = createNodeSshCredentialStore();
const bootstrapStore = createNodeBootstrapStore();
const recordingStore = createRecordingStore(recordings);
const roomStore = createRoomStore();
const roomRosterStore = createRoomRosterStore();
const scheduleStore = createScheduleStore(seedSchedules);
const settingsStore = createSettingsStore();
const switcherStore = createSwitcherStore();
const switcherMappingStore = createSwitcherMappingStore();
const uploadDestinationStore = createUploadDestinationStore();
onRecordingJobLeaseExpired(async ({ job, terminalState }) => {
  const recording = await recordingStore.find(job.recordingId);

  if (!recording) {
    return;
  }

  await markAgentJobTerminalRecording(
    recording,
    {
      jobId: job.id,
      reason:
        job.failureReason ?? (terminalState === "cancelled" ? "lease_cancelled" : "lease_expired"),
      terminalState,
    },
    { healthEventStore, recordingStore },
  );
});
export const {
  recordingJobLeaseRunner,
  retentionRunner,
  scheduleRunner,
  switcherRoutingRunner,
  uploadRunner,
  watchdogRunner,
} = createApiRunners({
  auditStore,
  healthEventStore,
  listSwitcherUsers: async () =>
    (await authService.localUsers()).map((account) => ({
      groupIds: account.groups.map((group) => group.id),
      id: account.id,
    })),
  meterFrameStore,
  nodeStore,
  recordingStore,
  scheduleStore,
  settingsStore,
  switcherMappingStore,
  switcherStore,
  uploadDestinationStore,
});
type NodeRecord = RecorderNode;
const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
    let allowed = hasPermission && scope.allowed;

    // A room roster (a manual grant or a calendar meeting-assignment) grants a
    // per-action capability over its room even without the role permission — but
    // never past an explicit deny policy.
    let grantedViaRoomCapability = false;
    const requiredCapability = permissionRequiresCapability(permission);
    if (!allowed && auth.user && scope.reason !== "access_policy_denied" && requiredCapability) {
      grantedViaRoomCapability = await roomCapabilityAuthorizes(
        auth.user,
        requiredCapability,
        auditTarget,
      );
      allowed = grantedViaRoomCapability;
    }

    const reason = allowed
      ? undefined
      : authorizationReason({
          authenticated: Boolean(auth.user),
          hasPermission,
          hasScope: scope.allowed,
          scopeReason: scope.reason,
        });

    await recordAuditEvent(c, {
      action,
      auth,
      details: {
        grantedViaRoomCapability,
        requiredPermission: permission,
        resourceScope: auditTarget,
        resourceScopeDecision: scope.reason,
        roomCapability: requiredCapability,
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
    await addRecordingScopeTargets(targets, target.id, knownNodes);
  }

  if (target.type === "recording_job" && target.id) {
    const job = await recordingJob(target.id);

    if (job) {
      await addRecordingScopeTargets(targets, job.recordingId, knownNodes);
      addNodeScopeTargets(targets, job.nodeId, knownNodes);
    }
  }

  if (target.type === "schedule" && target.id) {
    await addScheduleScopeTargets(targets, target.id, knownNodes);
  }

  if (target.type === "node" && target.id) {
    addNodeScopeTargets(targets, target.id, knownNodes);
  }

  if (target.type === "health_event" && target.id) {
    const event = await healthEventStore.find(target.id);
    if (event?.recordingId) targets.push({ id: event.recordingId, type: "recording" });
    const recording = event?.recordingId ? await recordingStore.find(event.recordingId) : undefined;
    for (const scheduleId of [recording?.scheduleId, event?.scheduleId]) {
      if (!scheduleId) continue;
      await addScheduleScopeTargets(targets, scheduleId, knownNodes);
    }
    for (const nodeId of [recording?.nodeId, event?.nodeId]) {
      if (!nodeId) continue;
      addNodeScopeTargets(targets, nodeId, knownNodes);
    }
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

async function addRecordingScopeTargets(
  targets: AuditTarget[],
  recordingId: string,
  knownNodes: NodeRecord[],
) {
  const recording = await recordingStore.find(recordingId);

  if (!recording) {
    return;
  }

  targets.push({ id: recording.id, type: "recording" });

  if (recording.scheduleId) {
    await addScheduleScopeTargets(targets, recording.scheduleId, knownNodes);
  }

  if (recording.nodeId) {
    addNodeScopeTargets(targets, recording.nodeId, knownNodes);
  }
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

  targets.push({ id: schedule.id, type: "schedule" });

  if (schedule.roomId) {
    targets.push({ id: schedule.roomId, type: "room" });
  }

  addNodeScopeTargets(targets, schedule.nodeId, knownNodes);
}

function rosterSubject(user: NonNullable<AuthResult["user"]>) {
  return { groupIds: user.groups.map((group) => group.id), userId: user.id };
}

// Room ids a target resolves into (via the shared hierarchy expansion).
function roomIdsFromTargets(targets: AuditTarget[]) {
  const roomIds: string[] = [];

  for (const target of targets) {
    if (target.type === "room" && target.id) {
      roomIds.push(target.id);
    }
  }

  return roomIds;
}

// The set of room ids the user holds any capability in (direct or via a group).
async function rosterRoomIds(user: NonNullable<AuthResult["user"]>) {
  return new Set((await roomRosterStore.roomsForSubject(rosterSubject(user))).keys());
}

// True when the user holds `capability` in a room that `target` resolves into,
// via the room roster (a manual grant or a calendar meeting-assignment). Reuses
// the same hierarchy expansion as role scoping, so a room grant covers that
// room's nodes, interfaces, channels, schedules, and recordings.
async function roomCapabilityAuthorizes(
  user: NonNullable<AuthResult["user"]>,
  capability: RoomCapability,
  target: AuditTarget,
) {
  if (!target.id) {
    return false;
  }

  const roomIds = roomIdsFromTargets(await resourceScopeTargets(target));

  if (roomIds.length === 0) {
    return false;
  }

  const subject = rosterSubject(user);

  for (const roomId of roomIds) {
    const capabilities = await roomRosterStore.effectiveCapabilities(subject, roomId);

    if (capabilities.has(capability)) {
      return true;
    }
  }

  return false;
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

async function scopedNodes(user: NonNullable<AuthResult["user"]>) {
  const userRoomIds = await rosterRoomIds(user);
  const result: NodeRecord[] = [];

  for (const node of await nodeStore.list()) {
    if (
      (node.roomId !== undefined && userRoomIds.has(node.roomId)) ||
      (await hasResourceScope(user, { id: node.id, type: "node" }))
    ) {
      result.push(node);
    }
  }

  return result;
}

async function scopedSchedules(user: NonNullable<AuthResult["user"]>) {
  const userRoomIds = await rosterRoomIds(user);
  const knownNodes = userRoomIds.size > 0 ? await nodeStore.list() : [];
  const result: ScheduleSummary[] = [];

  for (const schedule of await scheduleStore.list()) {
    const node = knownNodes.find((candidate) => candidate.id === schedule.nodeId);
    const roomId = schedule.roomId ?? node?.roomId;
    const inRosterRoom = roomId !== undefined && userRoomIds.has(roomId);

    if (inRosterRoom || (await hasResourceScope(user, { id: schedule.id, type: "schedule" }))) {
      result.push(schedule);
    }
  }

  return result;
}

// Rooms visible to a user: everything for owner/admin, else rooms they hold a
// roster capability in plus the rooms of any nodes they are otherwise scoped to.
async function scopedRooms(user: NonNullable<AuthResult["user"]>) {
  const allRooms = await roomStore.list();

  if (user.roles.includes("owner") || user.roles.includes("admin")) {
    return allRooms;
  }

  const roomIds = await rosterRoomIds(user);

  for (const node of await scopedNodes(user)) {
    if (node.roomId) {
      roomIds.add(node.roomId);
    }
  }

  return allRooms.filter((room) => roomIds.has(room.id));
}

// Resolves who created a schedule from its create audit event (schedules do not
// store a creator); used for the room overview's "scheduled by" attribution.
async function scheduledByName(scheduleId: string) {
  const [event] = await auditStore.list({
    action: "schedules.create.succeeded",
    limit: 1,
    target: scheduleId,
  });

  return event?.actor.name;
}

async function scopedRecordings(user: NonNullable<AuthResult["user"]>) {
  const userRoomIds = await rosterRoomIds(user);
  const knownNodes = userRoomIds.size > 0 ? await nodeStore.list() : [];
  const result = [];

  for (const recording of await recordingStore.list()) {
    const node = recording.nodeId
      ? knownNodes.find((candidate) => candidate.id === recording.nodeId)
      : undefined;
    const roomId = node?.roomId;
    const inRosterRoom = roomId !== undefined && userRoomIds.has(roomId);

    if (inRosterRoom || (await hasResourceScope(user, { id: recording.id, type: "recording" }))) {
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

// When a DB-authoritative store cannot reach Postgres it throws
// DatabaseUnavailableError rather than silently persisting to a throwaway
// fallback. Surface that as 503 so the caller retries against the real
// database; everything else keeps the default 500.
app.onError((error, c) => {
  if (isDatabaseUnavailableError(error)) {
    return c.json(
      { error: "Service temporarily unavailable", reason: "database_unavailable" },
      503,
    );
  }

  console.error("unhandled API error", error);

  return c.json({ error: "Internal server error" }, 500);
});

registerMetricsRoutes({
  app,
  auditStore,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  healthEventStore,
  listenMonitorStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  startedAt,
});

registerStatusRoutes({
  app,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  healthEventStore,
  recordAuditEvent,
  requirePermission,
  settingsStore,
  scopedNodes,
  scopedRecordings,
  startedAt,
});

registerSettingsRoutes({
  app,
  currentAuth,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  recordAuditEvent,
  requirePermission,
  settingsStore,
  uploadDestinationStore,
});
registerWatchdogCalibrationRoutes({
  app,
  currentAuth,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  meterFrameStore,
  recordAuditEvent,
  requirePermission,
  settingsStore,
});

registerSwitcherRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
  switcherStore,
});

registerSwitcherMappingRoutes({
  app,
  currentAuth,
  listUsers: async () =>
    (await authService.localUsers()).map((account) => ({
      email: account.email,
      id: account.id,
      name: account.name,
    })),
  recordAuditEvent,
  requirePermission,
  roomStore,
  switcherMappingStore,
  switcherStore,
});

registerRetentionPolicyRoutes({
  app,
  currentAuth,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  recordAuditEvent,
  requirePermission,
});

registerAuthOidcRoutes({
  app,
  authService,
  recordAuditEvent,
  requirePermission,
  sessionContext: requestContext,
  webOrigin,
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
  clearOidcLoginStateCookie(c);

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
    await recordAuditEvent(c, {
      action: "auth.me.read.failed",
      auth,
      outcome: "denied",
      reason: "unauthorized",
      target: { type: "user" },
    });

    return c.json({ error: "Unauthorized" }, 401);
  }

  await recordAuditEvent(c, {
    action: "auth.me.read.succeeded",
    auth,
    outcome: "succeeded",
    target: { id: auth.user.id, name: auth.user.email, type: "user" },
  });

  return c.json({
    data: auth.user,
  });
});

registerAuthManagementRoutes({
  app,
  authService,
  currentAuth,
  currentUser,
  recordAuditEvent,
  requirePermission,
});

registerAuthLifecycleRoutes({
  app,
  authService,
  currentAuth,
  currentUser,
  recordAuditEvent,
  requirePermission,
});

registerAuditRoutes({
  app,
  auditStore,
  currentAuth,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  recordAuditEvent,
  requirePermission,
});

registerNodeRoutes({
  app,
  bootstrapStore,
  currentAuth,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  listenMonitorStore,
  listenSessionStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
  sshCredentialStore,
});

registerScheduleRoutes({
  app,
  assignmentIdReferences: async ({ groupIds, userIds }) => {
    const [users, groups] = await Promise.all([
      authService.localUsers(),
      authService.localGroups(),
    ]);
    const knownUserIds = new Set(users.map((user) => user.id));
    const knownGroupIds = new Set(groups.map((group) => group.id));

    return {
      unknownGroupIds: [...new Set(groupIds)].filter((groupId) => !knownGroupIds.has(groupId)),
      unknownUserIds: [...new Set(userIds)].filter((userId) => !knownUserIds.has(userId)),
    };
  },
  currentAuth,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  nodeStore,
  recordAuditEvent,
  recordingStore,
  reconcileScheduleRoster: (schedule) =>
    roomRosterStore.reconcileCalendar({
      capabilities: [...defaultCalendarGrantCapabilities],
      roomId: schedule.roomId,
      scheduleId: schedule.id,
      subjects: [
        ...schedule.assignedUserIds.map((subjectId) => ({
          subjectId,
          subjectType: "user" as const,
        })),
        ...schedule.assignedGroupIds.map((subjectId) => ({
          subjectId,
          subjectType: "group" as const,
        })),
      ],
    }),
  removeScheduleRoster: (scheduleId) => roomRosterStore.removeForSchedule(scheduleId),
  requirePermission,
  scheduleStore,
  scopedNodes,
  scopedSchedules,
  settingsStore,
});

registerRoomRoutes({
  app,
  currentAuth,
  currentUser,
  listGroups: async () =>
    (await authService.localGroups()).map((group) => ({ id: group.id, name: group.name })),
  listUsers: async () =>
    (await authService.localUsers()).map((user) => ({ id: user.id, name: user.name })),
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  roomRosterStore,
  roomStore,
  scheduledByName,
  scheduleStore,
  scopedRooms,
});

registerAgentMonitorRoutes({
  app,
  listenMonitorStore,
  nodeStore,
  recordAuditEvent,
});

registerAgentRoutes({
  app,
  healthEventStore,
  listenSessionStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  scheduleStore,
  settingsStore,
  uploadDestinationStore,
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
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  healthEventStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedNodes,
  scopedRecordings,
  settingsStore,
  uploadDestinationStore,
});

registerUploadRunnerRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
  scopedRecordings,
  uploadRunner,
});

if (process.env.RAKKR_API_NO_LISTEN !== "1") {
  startApiRunners({
    recordingJobLeaseRunner,
    retentionRunner,
    scheduleRunner,
    switcherRoutingRunner,
    uploadRunner,
    watchdogRunner,
  });

  // Seed the demo node as a real enrolled (persisted) row so it is editable in
  // the console; idempotent and skipped when demo data is disabled.
  if (process.env.RAKKR_SEED_DEMO_DATA !== "0") {
    void nodeStore
      .seed(seedNodes)
      .catch((error) => console.warn("demo node seeding unavailable", error));
  }

  const listenConfig = apiListenConfig(app.fetch, port);

  serve(listenConfig.options, (info) => {
    console.log(`Rakkr API listening on ${listenConfig.protocol}://localhost:${info.port}`);
  });
}
