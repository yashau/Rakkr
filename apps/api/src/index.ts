import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import type { MiddlewareHandler } from "hono";

import {
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  hasPermission,
  rolePermissions,
  type CurrentUser,
  type MeterFrame,
  type Permission,
  type RecorderNode,
  type RecordingSummary,
  type Role,
  type ScheduleSummary,
} from "@rakkr/shared";

const startedAt = new Date();
const port = Number(process.env.PORT ?? 8787);
const webOrigin = process.env.RAKKR_WEB_ORIGIN ?? "http://localhost:5173";

const localRole: Role = "admin";
const localUser: CurrentUser = {
  email: "admin@rakkr.local",
  id: "local_admin",
  name: "Local Admin",
  permissions: [...rolePermissions[localRole]],
  provider: "local",
  roles: [localRole],
};

function requirePermission(permission: Permission): MiddlewareHandler {
  return async (c, next) => {
    if (!hasPermission(localRole, permission)) {
      return c.json(
        {
          error: "Forbidden",
          permission,
        },
        403,
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

app.get("/metrics", (c) =>
  c.text(prometheusMetrics(), 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  }),
);

app.get("/api/v1/status", requirePermission("node:read"), (c) =>
  c.json({
    activeRecordings: 0,
    cachedRecordings: recordings.filter((recording) => recording.cached).length,
    criticalAlerts: 0,
    nodeCount: nodes.length,
    onlineNodes: nodes.filter((node) => node.status === "online").length,
    recordingProfile: defaultVoiceRecordingProfile,
    startedAt: startedAt.toISOString(),
    watchdogPolicy: defaultScheduledVoiceWatchdogPolicy,
  }),
);

app.get("/api/v1/auth/me", (c) =>
  c.json({
    data: localUser,
  }),
);

app.get("/api/v1/nodes", requirePermission("node:read"), (c) => c.json({ data: nodes }));
app.get("/api/v1/nodes/:nodeId/meters", requirePermission("node:read"), (c) => {
  const nodeId = c.req.param("nodeId");
  const frame = buildMeterFrame();

  if (nodeId !== frame.nodeId) {
    return c.json({ error: "Node not found" }, 404);
  }

  return c.json({ data: frame });
});

app.get("/api/v1/meter-events", requirePermission("node:read"), (c) =>
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

app.get("/api/v1/schedules", requirePermission("schedule:read"), (c) =>
  c.json({ data: schedules }),
);
app.get("/api/v1/recordings", requirePermission("recording:read"), (c) =>
  c.json({ data: recordings }),
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
