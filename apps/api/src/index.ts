import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { registerAgentMonitorRoutes } from "./agent-monitor-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { agentReleaseService } from "./agent-release-service.js";
import { createApiRunners, startApiRunners } from "./api-runners.js";
import { defaultCalendarGrantCapabilities, type ScheduleSummary } from "@rakkr/shared";
import { registerAuditRoutes } from "./audit-routes.js";
import { createAuditStore } from "./audit-store.js";
import { registerAuthLifecycleRoutes } from "./auth-lifecycle-routes.js";
import { registerAuthManagementRoutes } from "./auth-management-routes.js";
import { clearOidcLoginStateCookie, registerAuthOidcRoutes } from "./auth-oidc-routes.js";
import { AuthError, LocalAuthService } from "./auth-service.js";
import { registerHealthRoutes } from "./health-routes.js";
import { createHealthEventStore } from "./health-store.js";
import {
  createAuthorization,
  currentAuth,
  currentUser,
  requestContext,
} from "./index-authorization.js";
import { createReadinessProbe } from "./index-readiness.js";
import { nodes as seedNodes, recordings, schedules as seedSchedules } from "./demo-data.js";
import type { AppBindings } from "./http-types.js";
import { createListenMonitorStore } from "./listen-monitor-store.js";
import { createListenSessionStore } from "./listen-session-store.js";
import { createMeterFrameStore } from "./meter-store.js";
import { registerMetricsRoutes } from "./metrics-routes.js";
import { createNodeBootstrapStore } from "./node-bootstrap-store.js";
import { registerChannelRoomRoutes } from "./channel-room-routes.js";
import { registerNodeRoutes } from "./node-routes.js";
import { createNodeStore } from "./node-store.js";
import { createNodeSshCredentialStore } from "./node-ssh-credential-store.js";
import { markAgentJobTerminalRecording } from "./agent-job-terminal-recording.js";
import { isDatabaseUnavailableError } from "./database-unavailable.js";
import { onRecordingJobLeaseExpired } from "./recording-jobs.js";
import { registerRecordingRoutes } from "./recording-routes.js";
import { createRecordingStore } from "./recording-store.js";
import { registerRetentionPolicyRoutes } from "./retention-policy-routes.js";
import { createRoomRosterStore } from "./room-roster-store.js";
import { registerRoomRoutes } from "./room-routes.js";
import { createRoomStore } from "./room-store.js";
import { createResourceScopeTargets } from "./resource-scope-targets.js";
import { createScopedResources } from "./index-scoped-resources.js";
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

const { checkDatabaseReady } = createReadinessProbe(process.env.DATABASE_URL);

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
const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const resourceScopeTargets = createResourceScopeTargets({
  healthEventStore,
  nodeStore,
  recordingStore,
  scheduleStore,
});

const authorization = createAuthorization({
  auditStore,
  authService,
  resourceScopeTargets,
  roomRosterStore,
});
// Re-exported for test coverage of the access-policy-DENY-beats-roster-grant
// precedence; see createAuthorization in index-authorization.ts.
export const permissionDecision = authorization.permissionDecision;
const {
  authorizeTargetForUser,
  hasResourceScope,
  recordAuditEvent,
  requirePermission,
  rosterRoomIds,
} = authorization;

// Per-user resource visibility + meter/monitor access decisions. Extracted to a
// sibling factory to keep this composition root within the LOC budget; the
// factory only builds closures over the authorization + roster/scope helpers, so
// wiring it here preserves behavior and the startup order of side effects exactly.
const {
  canServeWholeNodeMonitor,
  filterMeterFrameForUser,
  scheduledByName,
  scopedNodes,
  scopedRecordings,
  scopedRooms,
  scopedSchedules,
} = createScopedResources({
  accessPolicyDecision: (user, targets) => authService.accessPolicyDecision(user, targets),
  auditStore,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  nodeStore,
  recordingStore,
  roomStore,
  rosterRoomIds: (user) => rosterRoomIds(user),
  scheduleStore,
});

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
  canServeWholeNodeMonitor: (user, node) => canServeWholeNodeMonitor(user, node),
  currentUser,
  filterMeterFrame: (user, node, frame) => filterMeterFrameForUser(user, node, frame),
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
  checkDatabaseReady,
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
  roomRosterStore,
  scheduleStore,
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
  canServeWholeNodeMonitor: (user, node) => canServeWholeNodeMonitor(user, node),
  currentAuth,
  currentUser,
  filterMeterFrame: (user, node, frame) => filterMeterFrameForUser(user, node, frame),
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

// Materializes a schedule's assignees into its room's calendar-source roster rows
// (and clears them when the resolved room is undefined). Shared by schedule
// create/update and by channel-room reassignment, which re-homes a schedule when
// its channels' room changes.
const reconcileScheduleRoster = (schedule: ScheduleSummary) =>
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
  });

registerChannelRoomRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  reconcileScheduleRoster,
  recordAuditEvent,
  requirePermission,
  roomStore,
  scheduleStore,
  scopedNodes,
});

registerScheduleRoutes({
  app,
  assignmentIdReferences: async ({ groupIds, userIds }) => {
    const [users, groups] = await Promise.all([
      authService.localUsers(),
      authService.groups.localGroups(),
    ]);
    const knownUserIds = new Set(users.map((user) => user.id));
    const knownGroupIds = new Set(groups.map((group) => group.id));

    return {
      unknownGroupIds: [...new Set(groupIds)].filter((groupId) => !knownGroupIds.has(groupId)),
      unknownUserIds: [...new Set(userIds)].filter((userId) => !knownUserIds.has(userId)),
    };
  },
  authorizeTarget: (user, permission, target) => authorizeTargetForUser(user, permission, target),
  currentAuth,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  nodeStore,
  recordAuditEvent,
  recordingStore,
  reconcileScheduleRoster,
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
    (await authService.groups.localGroups()).map((group) => ({ id: group.id, name: group.name })),
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
  authorizeTarget: (user, permission, target) => authorizeTargetForUser(user, permission, target),
  currentAuth,
  currentUser,
  hasResourceScope: (user, target) => hasResourceScope(user, target),
  healthEventStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  roomStore,
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

  // Warm the recorder-agent release cache so the "update available" badge can
  // hydrate on the first nodes-page load instead of after the first poll.
  void agentReleaseService().warm();

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
