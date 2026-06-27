import type { Context, Hono } from "hono";
import { z } from "zod";
import type { RecorderNode } from "@rakkr/shared";
import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import {
  nodeLifecycleActions,
  type NodeLifecycleAction,
  type NodeLifecycleService,
} from "./node-lifecycle.js";

interface NodeLifecycleRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeLifecycleService: NodeLifecycleService;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
}

const lifecycleActionSchema = z.enum(nodeLifecycleActions);
const lifecycleRequestSchema = z
  .object({
    agentVersion: z.string().trim().min(1).max(80).optional(),
    sshUser: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export function registerNodeLifecycleRoutes({
  app,
  currentAuth,
  currentUser,
  nodeLifecycleService,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
}: NodeLifecycleRouteDependencies) {
  app.get(
    "/api/v1/nodes/:nodeId/lifecycle-jobs",
    requirePermission("node:read", "nodes.lifecycle_jobs.read", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordLifecycleFailure(c, "nodes.lifecycle_jobs.read.failed", "node_not_found");
        return c.json({ error: "Node not found" }, 404);
      }

      const jobs = await nodeLifecycleService.list(node.id);

      await recordAuditEvent(c, {
        action: "nodes.lifecycle_jobs.read.succeeded",
        auth: currentAuth(c),
        details: { jobCount: jobs.length },
        outcome: "succeeded",
        permission: "node:read",
        target: { id: node.id, name: node.alias, type: "node" },
      });

      return c.json({ data: jobs });
    },
  );

  app.post(
    "/api/v1/nodes/:nodeId/lifecycle/:action",
    requirePermission("node:manage", "nodes.lifecycle.run", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const action = lifecycleActionSchema.safeParse(c.req.param("action"));
      const body = lifecycleRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!action.success || !body.success) {
        await recordLifecycleFailure(c, "nodes.lifecycle.run.failed", "invalid_request");
        return c.json({ error: "Invalid node lifecycle request" }, 400);
      }

      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordLifecycleFailure(c, "nodes.lifecycle.run.failed", "node_not_found");
        return c.json({ error: "Node not found" }, 404);
      }

      const job = await nodeLifecycleService.run({
        action: action.data,
        node,
        options: body.data,
        requestedBy: currentUser(c).id,
      });
      const succeeded = job.status === "succeeded";

      await recordAuditEvent(c, {
        action: `nodes.lifecycle.${action.data}.${succeeded ? "succeeded" : "failed"}`,
        auth: currentAuth(c),
        correlationIds: { nodeLifecycleJobId: job.id },
        details: {
          action: action.data,
          exitCode: job.exitCode,
          runnerRunId: job.runnerRunId,
          status: job.status,
          targetHost: job.targetHost,
        },
        outcome: succeeded ? "succeeded" : "failed",
        permission: "node:manage",
        reason: succeeded ? undefined : (job.error ?? "ansible_lifecycle_failed"),
        target: { id: node.id, name: node.alias, type: "node" },
      });

      return c.json({ data: job }, succeeded ? 202 : 502);
    },
  );

  async function findScopedNode(c: Context<AppBindings>, nodeId: string) {
    return (await scopedNodes(currentUser(c))).find((node) => node.id === nodeId);
  }

  async function recordLifecycleFailure(c: Context<AppBindings>, action: string, reason: string) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: lifecycleFailurePermission(action),
      reason,
      target: { id: c.req.param("nodeId"), type: "node" },
    });
  }
}

function lifecycleFailurePermission(action: string) {
  return action.includes("read") ? "node:read" : "node:manage";
}

export type { NodeLifecycleAction };
