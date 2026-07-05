import type { Hono } from "hono";

import { agentReleaseService, type AgentReleaseService } from "./agent-release-service.js";
import type { AppBindings, RequirePermission } from "./http-types.js";

interface AgentReleaseRouteDependencies {
  agentReleaseService?: AgentReleaseService;
  app: Hono<AppBindings>;
  requirePermission: RequirePermission;
}

// Exposes the latest recorder-agent release the controller resolved from GitHub.
// The console compares this against each node's reported `agentVersion` to flag
// "update available". The handler is non-blocking: `snapshot()` returns the
// cached value (possibly `null` on a cold cache) and schedules a background
// refresh, so this read never waits on GitHub. Gated by `node:read` — the same
// permission that lists nodes — and denied attempts are audited by the
// middleware.
export function registerAgentReleaseRoutes({
  agentReleaseService: releaseService = agentReleaseService(),
  app,
  requirePermission,
}: AgentReleaseRouteDependencies) {
  app.get(
    "/api/v1/nodes/agent-release",
    requirePermission("node:read", "nodes.agent_release.read"),
    (c) => c.json(releaseService.snapshot()),
  );
}
