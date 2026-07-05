import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AgentReleaseResponse } from "@rakkr/shared";
import type { AppBindings, RequirePermission } from "../src/http-types.js";
import type { AgentReleaseService } from "../src/agent-release-service.js";

const { registerAgentReleaseRoutes } = await import("../src/agent-release-routes.js");

function releaseService(snapshot: AgentReleaseResponse): AgentReleaseService {
  return {
    snapshot: () => snapshot,
    warm: async () => {},
  };
}

test("agent-release route returns the cached snapshot and is gated by node:read", async () => {
  const captured: { action?: string; permission?: string } = {};
  const requirePermission: RequirePermission = (permission, action) => {
    captured.action = action;
    captured.permission = permission;

    return async (_c, next) => {
      await next();
    };
  };
  const app = new Hono<AppBindings>();
  const snapshot: AgentReleaseResponse = {
    checkedAt: "2026-07-05T00:00:00.000Z",
    data: {
      publishedAt: "2026-06-28T00:00:00.000Z",
      tag: "agent-v2026.06.28-1",
      url: "https://github.com/yashau/Rakkr/releases/tag/agent-v2026.06.28-1",
      version: "2026.06.28-1",
    },
  };

  registerAgentReleaseRoutes({
    agentReleaseService: releaseService(snapshot),
    app,
    requirePermission,
  });

  const response = await app.request("/api/v1/nodes/agent-release");
  const body = (await response.json()) as AgentReleaseResponse;

  assert.equal(response.status, 200);
  assert.equal(captured.permission, "node:read");
  assert.equal(captured.action, "nodes.agent_release.read");
  assert.deepEqual(body, snapshot);
});

test("agent-release route serves a null cold-cache snapshot without erroring", async () => {
  const app = new Hono<AppBindings>();
  const requirePermission: RequirePermission = () => async (_c, next) => {
    await next();
  };

  registerAgentReleaseRoutes({
    agentReleaseService: releaseService({ data: null }),
    app,
    requirePermission,
  });

  const response = await app.request("/api/v1/nodes/agent-release");
  const body = (await response.json()) as AgentReleaseResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data, null);
});

test("agent-release route denies when the permission middleware rejects", async () => {
  const app = new Hono<AppBindings>();
  const requirePermission: RequirePermission = () => async (c) =>
    c.json({ error: "forbidden" }, 403);

  registerAgentReleaseRoutes({
    agentReleaseService: releaseService({ data: null }),
    app,
    requirePermission,
  });

  const response = await app.request("/api/v1/nodes/agent-release");

  assert.equal(response.status, 403);
});
