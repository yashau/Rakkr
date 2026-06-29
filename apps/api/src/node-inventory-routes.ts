import type { Context, Hono } from "hono";
import { z } from "zod";
import { nodeStatusSchema, type RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import { nodeExportFileName, nodeInventoryCsv } from "./node-inventory-export.js";
import { PAGE_POLICY, paginate, paginationQueryFields, parsePagination } from "./pagination.js";

interface NodeInventoryRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
}

const nodeSearchSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(200).optional(),
);
const nodeLocationFilterSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(160).optional(),
);
const nodeDateFilterSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().datetime({ offset: true }).optional(),
);
const nodeBackendFilterSchema = z.enum(["alsa", "jack", "pipewire", "unknown"]);
const nodeListFilterSchema = z
  .object({
    ...paginationQueryFields,
    backend: nodeBackendFilterSchema.optional(),
    building: nodeLocationFilterSchema,
    floor: nodeLocationFilterSchema,
    lastSeenFrom: nodeDateFilterSchema,
    lastSeenTo: nodeDateFilterSchema,
    q: nodeSearchSchema,
    room: nodeLocationFilterSchema,
    site: nodeLocationFilterSchema,
    status: nodeStatusSchema.optional(),
  })
  .strict();
const nodeSelectedExportSchema = z
  .object({
    nodeIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();

export function registerNodeInventoryRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
}: NodeInventoryRouteDependencies) {
  app.get("/api/v1/nodes", requirePermission("node:read", "nodes.read"), async (c) => {
    const filters = nodeListFilterSchema.safeParse(c.req.query());

    if (!filters.success) {
      await recordNodeReadFailure(c, "nodes.read.failed", "invalid_filters", {
        issueCount: filters.error.issues.length,
      });
      return c.json({ error: "Invalid node filters", issues: filters.error.issues }, 400);
    }

    const filteredNodes = filterNodes(await scopedNodes(currentUser(c)), filters.data);
    const { data, meta } = paginate(
      filteredNodes,
      parsePagination(
        { limit: filters.data.limit, offset: filters.data.offset },
        PAGE_POLICY.default,
      ),
    );

    await recordAuditEvent(c, {
      action: "nodes.read.succeeded",
      auth: currentAuth(c),
      details: {
        filters: filters.data,
        returnedCount: data.length,
        total: meta.total,
      },
      outcome: "succeeded",
      permission: "node:read",
      target: {
        id: "node_collection",
        type: "node_collection",
      },
    });

    return c.json({ data, meta });
  });

  app.get("/api/v1/nodes/export", requirePermission("node:read", "nodes.export"), async (c) => {
    const filters = nodeListFilterSchema.safeParse(c.req.query());

    if (!filters.success) {
      return c.json({ error: "Invalid node filters", issues: filters.error.issues }, 400);
    }

    const filteredNodes = filterNodes(await scopedNodes(currentUser(c)), filters.data);

    await recordAuditEvent(c, {
      action: "nodes.export.succeeded",
      auth: currentAuth(c),
      details: {
        exportedCount: filteredNodes.length,
        filters: filters.data,
      },
      outcome: "succeeded",
      permission: "node:read",
      target: {
        id: "node_collection",
        type: "node_collection",
      },
    });

    return c.body(nodeInventoryCsv(filteredNodes), 200, {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${nodeExportFileName()}"`,
      "Content-Type": "text/csv; charset=utf-8",
    });
  });

  app.post(
    "/api/v1/nodes/export",
    requirePermission("node:read", "nodes.export_selected", () => ({
      id: "node_collection",
      type: "node_collection",
    })),
    async (c) => {
      const body = nodeSelectedExportSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSelectedNodeExportFailure(c, "invalid_request");
        return c.json({ error: "Invalid node export request", issues: body.error.issues }, 400);
      }

      const nodeIds = uniqueNodeIds(body.data.nodeIds);
      const visibleNodeMap = new Map(
        (await scopedNodes(currentUser(c))).map((node) => [node.id, node]),
      );
      const hiddenIds = nodeIds.filter((nodeId) => !visibleNodeMap.has(nodeId));

      if (hiddenIds.length > 0) {
        await recordSelectedNodeExportFailure(c, "node_not_visible", {
          hiddenIds,
          nodeIds,
        });
        return c.json({ error: "One or more nodes are not visible" }, 404);
      }

      const nodes = nodeIds.map((nodeId) => visibleNodeMap.get(nodeId)!);

      await recordAuditEvent(c, {
        action: "nodes.export_selected.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          nodeIds.map((nodeId, index) => [`nodeId${index + 1}`, nodeId]),
        ),
        details: {
          exportedCount: nodes.length,
          requestedCount: body.data.nodeIds.length,
        },
        outcome: "succeeded",
        permission: "node:read",
        target: {
          id: "node_collection",
          type: "node_collection",
        },
      });

      return c.body(nodeInventoryCsv(nodes), 200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${nodeExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.get(
    "/api/v1/nodes/:nodeId",
    requirePermission("node:read", "nodes.detail.read", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = (await scopedNodes(currentUser(c))).find((candidate) => candidate.id === nodeId);

      if (!node) {
        await recordNodeReadFailure(c, "nodes.detail.read.failed", "node_not_found", {
          nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "nodes.detail.read.succeeded",
        auth: currentAuth(c),
        details: {
          alias: node.alias,
          status: node.status,
        },
        outcome: "succeeded",
        permission: "node:read",
        target: {
          id: node.id,
          name: node.alias,
          type: "node",
        },
      });

      return c.json({ data: node });
    },
  );

  async function recordNodeReadFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      details,
      outcome: "failed",
      permission: "node:read",
      reason,
      target: {
        id: details.nodeId === undefined ? "node_collection" : String(details.nodeId),
        type: details.nodeId === undefined ? "node_collection" : "node",
      },
    });
  }

  async function recordSelectedNodeExportFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "nodes.export_selected.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "node_not_visible" ? "denied" : "failed",
      permission: "node:read",
      reason,
      target: {
        id: "node_collection",
        type: "node_collection",
      },
    });
  }
}

function normalizeSearchTerm(value: string | undefined) {
  return value?.trim().toLowerCase();
}

function filterNodes(nodes: RecorderNode[], filters: z.infer<typeof nodeListFilterSchema>) {
  const query = normalizeSearchTerm(filters.q);
  const lastSeenFrom = filters.lastSeenFrom ? Date.parse(filters.lastSeenFrom) : undefined;
  const lastSeenTo = filters.lastSeenTo ? Date.parse(filters.lastSeenTo) : undefined;

  return nodes.filter((node) => {
    const lastSeenAt = Date.parse(node.lastSeenAt);

    return (
      (lastSeenFrom === undefined || lastSeenAt >= lastSeenFrom) &&
      (lastSeenTo === undefined || lastSeenAt <= lastSeenTo) &&
      (!filters.status || node.status === filters.status) &&
      (!filters.backend || nodeMatchesBackend(node, filters.backend)) &&
      nodeMatchesLocationFilters(node, filters) &&
      (!query || nodeSearchText(node).includes(query))
    );
  });
}

function nodeMatchesLocationFilters(
  node: RecorderNode,
  filters: z.infer<typeof nodeListFilterSchema>,
) {
  return (
    locationMatches(node.location.site, filters.site) &&
    locationMatches(node.location.building, filters.building) &&
    locationMatches(node.location.floor, filters.floor) &&
    locationMatches(node.location.room, filters.room)
  );
}

function locationMatches(actual: string | undefined, expected: string | undefined) {
  return !expected || normalizeSearchTerm(actual) === normalizeSearchTerm(expected);
}

function nodeSearchText(node: RecorderNode) {
  return [
    node.id,
    node.alias,
    node.hostname,
    node.agentVersion,
    node.audioDefaults
      ? [
          node.audioDefaults.captureBackend,
          node.audioDefaults.captureCommand,
          node.audioDefaults.captureDevice,
          node.audioDefaults.captureFormat,
          node.audioDefaults.captureSampleRate === undefined
            ? undefined
            : String(node.audioDefaults.captureSampleRate),
        ]
      : undefined,
    node.status,
    node.notes,
    node.ipAddresses,
    node.tags,
    Object.values(node.location),
    node.runtime
      ? [
          node.runtime.architecture,
          node.runtime.audioBackends,
          node.runtime.kernelRelease,
          node.runtime.osName,
          node.runtime.uptimeSeconds === undefined ? undefined : String(node.runtime.uptimeSeconds),
        ]
      : undefined,
    node.interfaces.map((audioInterface) => [
      audioInterface.alias,
      audioInterface.backend,
      String(audioInterface.channelCount),
      audioInterface.hardwarePath,
      audioInterface.id,
      audioInterface.sampleRates.map(String),
      audioInterface.serialNumber,
      audioInterface.systemName,
      audioInterface.systemRef,
      audioInterface.channels.map((channel) => [channel.alias, String(channel.index)]),
    ]),
  ]
    .flat(4)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function nodeMatchesBackend(node: RecorderNode, backend: z.infer<typeof nodeBackendFilterSchema>) {
  if (node.runtime?.audioBackends.includes(backend)) {
    return true;
  }

  return node.interfaces.some((audioInterface) => audioInterface.backend === backend);
}

function uniqueNodeIds(nodeIds: string[]) {
  return Array.from(new Set(nodeIds));
}
