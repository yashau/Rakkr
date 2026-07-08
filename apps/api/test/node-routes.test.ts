import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, MeterFrame, Permission, RecorderNode } from "@rakkr/shared";
import type { AgentReleaseService } from "../src/agent-release-service.js";
import type { AuthResult } from "../src/auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import { memoryMeterFrameStore, memoryNodeStore, wavChunk } from "./node-routes-helpers.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createListenSessionStore } = await import("../src/listen-session-store.js");
const { registerNodeRoutes } = await import("../src/node-routes.js");

test("node routes deny users without required permissions", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = nodeApp({
    auditStore,
    currentUser: deniedUser,
    frames: [meterFrame()],
    nodes: [nodeWithInterface()],
    permissionCalls: [],
    permissionMiddleware: denyMissingPermission(auditStore, deniedUser),
  });

  const responses = await Promise.all([
    app.request("/api/v1/nodes"),
    app.request("/api/v1/nodes/export"),
    app.request("/api/v1/nodes/export", {
      body: JSON.stringify({ nodeIds: [node().id] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    app.request(`/api/v1/nodes/${node().id}`),
    app.request(`/api/v1/nodes/${node().id}/actions`),
    app.request(`/api/v1/nodes/${node().id}/lifecycle-jobs`),
    app.request(`/api/v1/nodes/${node().id}/lifecycle/update_binary`, { method: "POST" }),
    app.request(`/api/v1/nodes/${node().id}/meters`),
    app.request("/api/v1/meter-events"),
    app.request(`/api/v1/nodes/${node().id}/listen`, { method: "POST" }),
    app.request(`/api/v1/nodes/${node().id}/listen/stream`),
    app.request(`/api/v1/nodes/${node().id}/listen/listen_denied`, { method: "DELETE" }),
    app.request("/api/v1/nodes/enroll", {
      body: JSON.stringify({
        alias: "Blocked Node",
        hostname: "blocked-node",
        location: {
          room: "Blocked Room",
          site: "Main Site",
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    app.request(`/api/v1/nodes/${node().id}`, {
      body: JSON.stringify({ alias: "Blocked Rename" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }),
    app.request(`/api/v1/nodes/${node().id}/interfaces/iface_monitor`, {
      body: JSON.stringify({ alias: "Blocked Interface" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }),
    app.request(`/api/v1/nodes/${node().id}/credentials/rotate`, { method: "POST" }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "listen.monitor.start",
    "listen.monitor.stop",
    "listen.monitor.stream",
    "meters.read",
    "meters.stream",
    "nodes.actions.read",
    "nodes.credentials.rotate",
    "nodes.detail.read",
    "nodes.enroll",
    "nodes.export",
    "nodes.export_selected",
    "nodes.interfaces.update",
    "nodes.lifecycle.run",
    "nodes.lifecycle_jobs.read",
    "nodes.read",
    "nodes.update",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === deniedUser.id));
});

test("GET /api/v1/nodes/agent-release resolves to the release route, not the :nodeId detail handler", async () => {
  const auditStore = createAuditStore("");
  const snapshot = {
    checkedAt: "2026-07-01T00:00:00.000Z",
    data: {
      publishedAt: "2026-06-28T00:00:00.000Z",
      tag: "agent-v2026.06.28-1",
      url: "https://github.com/yashau/Rakkr/releases/tag/agent-v2026.06.28-1",
      version: "2026.06.28-1",
    },
  };
  const app = nodeApp({
    agentReleaseService: { snapshot: () => snapshot, warm: async () => {} },
    auditStore,
    frames: [],
    nodes: [node()],
    permissionCalls: [],
  });

  const response = await app.request("/api/v1/nodes/agent-release");
  const body = (await response.json()) as {
    checkedAt?: string;
    data?: { version?: string };
    error?: string;
  };

  // Before the fix, the static /agent-release path is shadowed by GET
  // /api/v1/nodes/:nodeId (registered earlier), so it resolves to the detail
  // handler with nodeId="agent-release" and returns 404 "Node not found" — the
  // whole update-available feature is silently dead in production.
  assert.equal(response.status, 200);
  assert.equal(body.error, undefined);
  assert.equal(body.data?.version, "2026.06.28-1");
});

test("listen start returns a monitor stream URL and audits access", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    nodes: [node()],
    permissionCalls,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/listen`, { method: "POST" });
  const body = (await response.json()) as {
    data: {
      mode: string;
      sessionId: string;
      stopUrl: string;
      streamUrl: string;
      targetLatencyMs: number;
    };
  };
  const [event] = await auditStore.list({ action: "listen.monitor.start.succeeded" });

  assert.equal(response.status, 202);
  assert.equal(body.data.mode, "controller_meter_preview");
  assert.equal(body.data.targetLatencyMs, 1500);
  assert.match(body.data.streamUrl, new RegExp(`/api/v1/nodes/${node().id}/listen/stream`));
  assert.match(body.data.streamUrl, /sessionId=listen_/);
  assert.match(body.data.stopUrl, new RegExp(`/api/v1/nodes/${node().id}/listen/listen_`));
  assert.deepEqual(permissionCalls.at(-1), {
    action: "listen.monitor.start",
    permission: "listen:monitor",
    target: { id: node().id, type: "node" },
  });
  assert.equal(event?.details.streamUrl, body.data.streamUrl);
  assert.equal(event?.details.stopUrl, body.data.stopUrl);
  assert.equal(event?.correlationIds?.listenSessionId, body.data.sessionId);
});

test("node meter read route audits successes and unavailable data", async () => {
  const auditStore = createAuditStore("");
  const visible = node({ id: "node_meter_visible" });
  const hidden = node({ id: "node_meter_hidden" });
  const app = nodeApp({
    auditStore,
    frames: [
      meterFrame(visible.id),
      {
        ...meterFrame("node_meter_other"),
        interfaceId: "iface_other",
      },
    ],
    nodes: [visible, hidden],
    permissionCalls: [],
    scopedNodeIds: [visible.id],
  });

  const successResponse = await app.request(`/api/v1/nodes/${visible.id}/meters`);
  const successBody = (await successResponse.json()) as { data: MeterFrame };
  const hiddenResponse = await app.request(`/api/v1/nodes/${hidden.id}/meters`);
  const mismatchResponse = await app.request(`/api/v1/nodes/node_meter_other/meters`);
  const successAudits = await auditStore.list({
    action: "meters.read.succeeded",
    outcome: "succeeded",
    permission: "node:read",
  });
  const failedAudits = await auditStore.list({
    action: "meters.read.failed",
    outcome: "failed",
    permission: "node:read",
  });

  assert.equal(successResponse.status, 200);
  assert.equal(successBody.data.nodeId, visible.id);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(mismatchResponse.status, 404);
  assert.equal(successAudits.length, 1);
  assert.equal(successAudits[0]?.target.id, visible.id);
  assert.deepEqual(successAudits[0]?.details, {
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_monitor",
    levelCount: 1,
  });
  assert.deepEqual(failedAudits.map((event) => [event.reason, event.target.id]).sort(), [
    ["node_not_found", hidden.id],
    ["node_not_found", "node_meter_other"],
  ]);
});

test("node meter read route returns an empty frame instead of fabricating data", async () => {
  const auditStore = createAuditStore("");
  const recorder = node({ id: "node_meter_quiet" });
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes: [recorder],
    permissionCalls: [],
  });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/meters`);
  const body = (await response.json()) as { data: MeterFrame };
  const [event] = await auditStore.list({ action: "meters.read.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.data.nodeId, recorder.id);
  assert.deepEqual(body.data.levels, []);
  assert.equal(event?.details.levelCount, 0);
});

test("node meter read route serves synthetic frames only when demo meters are enabled", async () => {
  const auditStore = createAuditStore("");
  const recorder = node({ id: "node_x32_test" });
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes: [recorder],
    permissionCalls: [],
  });

  process.env.RAKKR_DEMO_METERS = "1";

  try {
    const response = await app.request(`/api/v1/nodes/${recorder.id}/meters`);
    const body = (await response.json()) as { data: MeterFrame };

    assert.equal(response.status, 200);
    assert.equal(body.data.nodeId, "node_x32_test");
    assert.ok(body.data.levels.length > 0, "demo mode should emit synthetic levels");
  } finally {
    delete process.env.RAKKR_DEMO_METERS;
  }
});

test("listen stream returns a short wav preview derived from meter levels", async () => {
  const auditStore = createAuditStore("");
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    nodes: [node()],
    permissionCalls: [],
  });

  const session = await startListenSession(app, node().id);
  const response = await app.request(session.streamUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [event] = await auditStore.list({ action: "listen.monitor.stream.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16_000);
  assert.equal(bytes.readUInt32LE(40), 48_000);
  assert.equal(event?.correlationIds?.listenSessionId, session.sessionId);
  assert.equal(event?.details.mode, "controller_meter_preview");
});

test("listen refuses a shared-node partial owner (cross-room audio isolation)", async () => {
  const auditStore = createAuditStore("");
  const listenMonitorStore = createListenMonitorStore();
  const app = nodeApp({
    auditStore,
    // Simulate a room-scoped caller who does not own every channel's room on a
    // shared node: the whole-node monitor mix would leak another room's audio.
    canServeWholeNodeMonitor: async () => false,
    frames: [meterFrame()],
    listenMonitorStore,
    nodes: [node()],
    permissionCalls: [],
  });

  await listenMonitorStore.save({
    audio: wavChunk(),
    capturedAt: new Date().toISOString(),
    contentType: "audio/wav",
    durationMs: 900,
    nodeId: node().id,
  });

  const startResponse = await app.request(`/api/v1/nodes/${node().id}/listen`, { method: "POST" });
  const streamResponse = await app.request(
    `/api/v1/nodes/${node().id}/listen/stream?sessionId=listen_probe`,
  );
  const [startFailure] = await auditStore.list({ action: "listen.monitor.start.failed" });
  const [streamFailure] = await auditStore.list({ action: "listen.monitor.stream.failed" });

  // No whole-node audio is served on either path; the isolation guard refuses.
  assert.equal(startResponse.status, 403);
  assert.equal(streamResponse.status, 403);
  assert.equal(startFailure?.reason, "missing_resource_scope");
  assert.equal(streamFailure?.reason, "missing_resource_scope");
});

test("listen stream prefers agent audio chunks when available", async () => {
  const auditStore = createAuditStore("");
  const listenMonitorStore = createListenMonitorStore();
  const audio = wavChunk();
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    listenMonitorStore,
    nodes: [node()],
    permissionCalls: [],
  });

  const capturedAt = new Date().toISOString();

  await listenMonitorStore.save({
    audio,
    capturedAt,
    contentType: "audio/wav",
    durationMs: 900,
    nodeId: node().id,
  });

  const startResponse = await app.request(`/api/v1/nodes/${node().id}/listen`, {
    method: "POST",
  });
  const startBody = (await startResponse.json()) as {
    data: { mode: string; streamUrl: string; targetLatencyMs: number };
  };
  const streamResponse = await app.request(startBody.data.streamUrl);
  const bytes = Buffer.from(await streamResponse.arrayBuffer());
  const [event] = await auditStore.list({ action: "listen.monitor.stream.succeeded" });

  assert.equal(startResponse.status, 202);
  assert.equal(startBody.data.mode, "agent_audio_chunk");
  assert.equal(startBody.data.targetLatencyMs, 900);
  assert.equal(streamResponse.status, 200);
  assert.deepEqual(bytes, Buffer.from(audio));
  assert.equal(event?.details.mode, "agent_audio_chunk");
  assert.equal(event?.details.durationMs, 900);
  assert.equal(event?.details.sourceCapturedAt, capturedAt);
});

test("listen stream ignores stale agent audio chunks", async () => {
  const auditStore = createAuditStore("");
  const listenMonitorStore = createListenMonitorStore();
  const staleAudio = wavChunk();
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    listenMonitorStore,
    nodes: [node()],
    permissionCalls: [],
  });

  await listenMonitorStore.save({
    audio: staleAudio,
    capturedAt: "2026-06-20T08:00:00.000Z",
    contentType: "audio/wav",
    durationMs: 900,
    nodeId: node().id,
  });

  const startResponse = await app.request(`/api/v1/nodes/${node().id}/listen`, {
    method: "POST",
  });
  const startBody = (await startResponse.json()) as {
    data: { mode: string; streamUrl: string; targetLatencyMs: number };
  };
  const streamResponse = await app.request(startBody.data.streamUrl);
  const bytes = Buffer.from(await streamResponse.arrayBuffer());
  const [event] = await auditStore.list({ action: "listen.monitor.stream.succeeded" });

  assert.equal(startResponse.status, 202);
  assert.equal(startBody.data.mode, "controller_meter_preview");
  assert.equal(startBody.data.targetLatencyMs, 1500);
  assert.equal(streamResponse.status, 200);
  assert.notDeepEqual(bytes, Buffer.from(staleAudio));
  assert.equal(event?.details.mode, "controller_meter_preview");
});

test("listen stream reports unavailable monitor data", async () => {
  const auditStore = createAuditStore("");
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes: [node()],
    permissionCalls: [],
  });

  const session = await startListenSession(app, node().id);
  const response = await app.request(session.streamUrl);
  const [event] = await auditStore.list({ action: "listen.monitor.stream.failed" });

  assert.equal(response.status, 409);
  assert.equal(event?.reason, "meter_frame_not_found");
  assert.equal(event?.target.id, node().id);
});

test("listen stream requires an active listen session", async () => {
  const auditStore = createAuditStore("");
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    nodes: [node()],
    permissionCalls: [],
  });

  const missingSessionResponse = await app.request(`/api/v1/nodes/${node().id}/listen/stream`);
  const unknownSessionResponse = await app.request(
    `/api/v1/nodes/${node().id}/listen/stream?sessionId=listen_unknown`,
  );
  const events = await auditStore.list({ action: "listen.monitor.stream.failed" });

  assert.equal(missingSessionResponse.status, 400);
  assert.equal(unknownSessionResponse.status, 404);
  assert.deepEqual(events.map((event) => event.reason).sort(), [
    "session_not_found",
    "session_required",
  ]);
});

test("listen stop ends the active monitor session and audits access", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    nodes: [node()],
    permissionCalls,
  });
  const session = await startListenSession(app, node().id);

  const stopResponse = await app.request(session.stopUrl, { method: "DELETE" });
  const streamResponse = await app.request(session.streamUrl);
  const [stopEvent] = await auditStore.list({ action: "listen.monitor.stop.succeeded" });
  const [streamEvent] = await auditStore.list({ action: "listen.monitor.stream.failed" });

  assert.equal(stopResponse.status, 200);
  assert.equal(streamResponse.status, 404);
  assert.equal(stopEvent?.correlationIds?.listenSessionId, session.sessionId);
  assert.equal(stopEvent?.details.mode, "controller_meter_preview");
  assert.equal(streamEvent?.reason, "session_not_found");
  assert.deepEqual(permissionCalls.at(-1), {
    action: "listen.monitor.stream",
    permission: "listen:monitor",
    target: { id: node().id, type: "node" },
  });
});

test("node update changes identity fields and audits before and after", async () => {
  const auditStore = createAuditStore("");
  const nodes = [node()];
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes,
    permissionCalls,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}`, {
    body: JSON.stringify({
      alias: "Council Chamber Recorder",
      ipAddresses: ["10.0.0.51"],
      location: {
        building: "City Hall",
        floor: "2",
        room: "Council Chamber",
        site: "Main Site",
      },
      notes: "Rack shelf A",
      audioDefaults: {
        captureArgsTemplate: "--input {device} --rate {sample_rate} --output {output}",
        captureBackend: "jack",
        captureChannels: 4,
        captureCommand: "custom-capture",
        captureDevice: "system:capture_1",
        captureFormat: "S24_LE",
        captureSampleRate: 96_000,
        meterArgsTemplate: "--meter-device {device} --stdout",
      },
      recordingCapacity: { maxConcurrentRecordings: 6 },
      tags: ["voice", "council"],
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.update.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.data.alias, "Council Chamber Recorder");
  assert.equal(body.data.location.building, "City Hall");
  assert.equal(body.data.location.floor, "2");
  assert.equal(body.data.location.room, "Council Chamber");
  assert.deepEqual(body.data.ipAddresses, ["10.0.0.51"]);
  assert.deepEqual(body.data.tags, ["voice", "council"]);
  assert.equal(body.data.notes, "Rack shelf A");
  assert.equal(body.data.audioDefaults?.captureBackend, "jack");
  assert.equal(body.data.audioDefaults?.captureCommand, "custom-capture");
  assert.equal(body.data.audioDefaults?.captureDevice, "system:capture_1");
  assert.equal(body.data.audioDefaults?.captureSampleRate, 96_000);
  assert.equal(body.data.recordingCapacity?.maxConcurrentRecordings, 6);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.update",
    permission: "node:manage",
    target: { id: node().id, type: "node" },
  });
  assert.equal(event?.before?.alias, "Monitor Room");
  assert.equal(event?.after?.alias, "Council Chamber Recorder");
  assert.equal(event?.after?.audioDefaults.captureBackend, "jack");
  assert.equal(event?.after?.audioDefaults.captureCommand, "custom-capture");
  assert.equal(event?.after?.recordingCapacity.maxConcurrentRecordings, 6);
  assert.equal(event?.permission, "node:manage");
});

test("node interface update changes device and channel aliases and audits before and after", async () => {
  const auditStore = createAuditStore("");
  const nodes = [nodeWithInterface()];
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes,
    permissionCalls,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/interfaces/iface_monitor`, {
    body: JSON.stringify({
      alias: "Lectern USB",
      channels: [{ alias: "Lectern Mic", index: 1 }],
      hardwarePath: "/proc/asound/card2/pcm0c",
      sampleRates: [48000, 44100],
      serialNumber: "X32-USB-1234",
      systemName: "hw:2,0",
      systemRef: "usb-2-1",
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.interfaces.update.succeeded" });
  const [audioInterface] = body.data.interfaces;

  assert.equal(response.status, 200);
  assert.equal(audioInterface.alias, "Lectern USB");
  assert.equal(audioInterface.hardwarePath, "/proc/asound/card2/pcm0c");
  assert.equal(audioInterface.serialNumber, "X32-USB-1234");
  assert.equal(audioInterface.systemName, "hw:2,0");
  assert.equal(audioInterface.systemRef, "usb-2-1");
  assert.deepEqual(audioInterface.sampleRates, [48000, 44100]);
  assert.deepEqual(audioInterface.channels, [
    { alias: "Lectern Mic", index: 1 },
    { alias: "Channel 2", index: 2 },
  ]);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.interfaces.update",
    permission: "node:manage",
    target: { id: "iface_monitor", type: "interface" },
  });
  assert.equal(event?.before?.alias, "Monitor USB");
  assert.equal(event?.after?.alias, "Lectern USB");
  assert.equal(event?.target.type, "interface");
  assert.equal(event?.details.nodeId, node().id);
});

test("node action routes only operate on scoped visible nodes", async () => {
  const auditStore = createAuditStore("");
  const hidden = nodeWithInterface({
    alias: "Hidden Recorder",
    id: "node_hidden_action",
    notes: "do not touch",
  });
  const visible = node({ id: "node_visible_action" });
  const nodes = [visible, hidden];
  const listenSessionStore = createListenSessionStore();
  const hiddenSession = await listenSessionStore.start({
    mode: "controller_meter_preview",
    nodeId: hidden.id,
    sessionId: "listen_hidden",
    startedAt: "2026-06-18T12:00:00.000Z",
    stopUrl: `/api/v1/nodes/${hidden.id}/listen/listen_hidden`,
    streamUrl: `/api/v1/nodes/${hidden.id}/listen/stream?sessionId=listen_hidden`,
    targetLatencyMs: 1500,
  });
  const app = nodeApp({
    auditStore,
    frames: [meterFrame(hidden.id)],
    listenSessionStore,
    nodes,
    permissionCalls: [],
    scopedNodeIds: [visible.id],
  });

  const update = await app.request(`/api/v1/nodes/${hidden.id}`, {
    body: JSON.stringify({ alias: "Mutated" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const interfaceUpdate = await app.request(`/api/v1/nodes/${hidden.id}/interfaces/iface_monitor`, {
    body: JSON.stringify({ alias: "Mutated Interface" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const rotate = await app.request(`/api/v1/nodes/${hidden.id}/credentials/rotate`, {
    method: "POST",
  });
  const meters = await app.request(`/api/v1/nodes/${hidden.id}/meters`);
  const listenStart = await app.request(`/api/v1/nodes/${hidden.id}/listen`, { method: "POST" });
  const listenStream = await app.request(
    `/api/v1/nodes/${hidden.id}/listen/stream?sessionId=${hiddenSession.sessionId}`,
  );
  const listenStop = await app.request(
    `/api/v1/nodes/${hidden.id}/listen/${hiddenSession.sessionId}`,
    { method: "DELETE" },
  );
  const storedHidden = nodes.find((candidate) => candidate.id === hidden.id);
  const storedSession = await listenSessionStore.find(hidden.id, hiddenSession.sessionId);
  const failedEvents = await auditStore.list({ outcome: "failed" });

  assert.deepEqual(
    [
      update.status,
      interfaceUpdate.status,
      rotate.status,
      meters.status,
      listenStart.status,
      listenStream.status,
      listenStop.status,
    ],
    [404, 404, 404, 404, 404, 404, 404],
  );
  assert.equal(storedHidden?.alias, "Hidden Recorder");
  assert.equal(storedHidden?.notes, "do not touch");
  assert.equal(storedHidden?.interfaces[0]?.alias, "Monitor USB");
  assert.equal(storedSession?.endedAt, undefined);
  assert.deepEqual(failedEvents.map((event) => `${event.action}:${event.reason}`).sort(), [
    "listen.monitor.start.failed:node_not_found",
    "listen.monitor.stop.failed:node_not_found",
    "listen.monitor.stream.failed:node_not_found",
    "meters.read.failed:node_not_found",
    "nodes.credentials.rotate.failed:node_not_found",
    "nodes.interfaces.update.failed:node_not_found",
    "nodes.update.failed:node_not_found",
  ]);
});

async function startListenSession(app: Hono<AppBindings>, nodeId: string) {
  const response = await app.request(`/api/v1/nodes/${nodeId}/listen`, { method: "POST" });
  const body = (await response.json()) as {
    data: {
      sessionId: string;
      stopUrl: string;
      streamUrl: string;
    };
  };

  assert.equal(response.status, 202);

  return body.data;
}

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function nodeApp({
  agentReleaseService,
  auditStore,
  canServeWholeNodeMonitor,
  currentUser = user(),
  frames,
  listenMonitorStore,
  listenSessionStore,
  nodes,
  permissionCalls,
  permissionMiddleware,
  scopedNodeIds,
}: {
  agentReleaseService?: AgentReleaseService;
  auditStore: ReturnType<typeof createAuditStore>;
  canServeWholeNodeMonitor?: (user: CurrentUser, node: RecorderNode) => Promise<boolean>;
  currentUser?: CurrentUser;
  frames: MeterFrame[];
  listenMonitorStore?: ReturnType<typeof createListenMonitorStore>;
  listenSessionStore?: ReturnType<typeof createListenSessionStore>;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  permissionMiddleware?: RequirePermission;
  scopedNodeIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerNodeRoutes({
    agentReleaseService,
    app,
    canServeWholeNodeMonitor,
    currentAuth: () => auth(currentUser),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    listenMonitorStore: listenMonitorStore ?? createListenMonitorStore(),
    listenSessionStore: listenSessionStore ?? createListenSessionStore(),
    meterFrameStore: memoryMeterFrameStore(frames),
    nodeStore: memoryNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: permissionMiddleware ?? requirePermission(permissionCalls),
    scopedNodes: async () =>
      nodes.filter(
        (candidate) => scopedNodeIds === undefined || scopedNodeIds.includes(candidate.id),
      ),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => {
    return async (c, next) => {
      calls.push({
        action,
        permission,
        target: target ? await target(c) : undefined,
      });
      await next();
    };
  };
}

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_node_route",
        name: "Node Route User",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function auth(currentUser = user()): AuthResult {
  return { user: currentUser };
}

function user(permissions: Permission[] = ["listen:monitor", "node:read"]): CurrentUser {
  return {
    email: "node-route@example.com",
    groups: [],
    id: "user_node_route",
    name: "Node Route User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Monitor Room",
    hostname: "monitor-room-node",
    id: "node_monitor_room",
    interfaces: [],
    ipAddresses: ["10.0.0.50"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Monitor Room",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
    ...input,
  };
}

function nodeWithInterface(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    ...node(),
    interfaces: [
      {
        alias: "Monitor USB",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "Channel 1", index: 1 },
          { alias: "Channel 2", index: 2 },
        ],
        hardwarePath: "/proc/asound/card1/pcm0c",
        id: "iface_monitor",
        sampleRates: [48_000],
        serialNumber: "MONITOR-USB-1",
        systemName: "Monitor USB Interface",
        systemRef: "usb-1-1",
      },
    ],
    ...input,
  };
}

function meterFrame(nodeId = node().id): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_monitor",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Mic 1",
        peakDbfs: -12,
        rmsDbfs: -24,
      },
    ],
    nodeId,
  };
}
