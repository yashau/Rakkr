import { z } from "zod";
import type { Hono } from "hono";
import {
  auditOutcomeSchema,
  permissionSchema,
  type AuditEvent,
  type Permission,
} from "@rakkr/shared";

import type { AuditEventFilters, AuditStore } from "./audit-store.js";
import type { AppBindings, RequirePermission } from "./http-types.js";

interface AuditRouteDependencies {
  app: Hono<AppBindings>;
  auditStore: AuditStore;
  requirePermission: RequirePermission;
}

interface AuditActionState {
  enabled: boolean;
  href?: string;
  method: "GET";
  permission: Permission;
  reason?: string;
}

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
  id: optionalTextFilterSchema,
  limit: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).max(500).optional(),
  ),
  outcome: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    auditOutcomeSchema.optional(),
  ),
  permission: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    permissionSchema.optional(),
  ),
  reason: optionalTextFilterSchema,
  target: optionalTextFilterSchema,
  to: optionalDateFilterSchema,
});

export function registerAuditRoutes({
  app,
  auditStore,
  requirePermission,
}: AuditRouteDependencies) {
  app.get(
    "/api/v1/audit-events/export",
    requirePermission("audit:read", "audit.events.export"),
    async (c) => {
      const query = auditEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
      }

      const events = await auditStore.list(auditFilters(query.data));

      return c.text(auditEventsCsv(events), 200, {
        "Content-Disposition": `attachment; filename="${auditExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.get(
    "/api/v1/audit-events/:eventId/actions",
    requirePermission("audit:read", "audit.events.actions.read", () => ({ type: "controller" })),
    async (c) => {
      const event = await auditStore.find(c.req.param("eventId"));

      return event
        ? c.json({
            data: {
              actions: auditEventActions(event),
              event,
              links: auditEventLinks(event),
            },
          })
        : c.json({ error: "Audit event not found" }, 404);
    },
  );

  app.get(
    "/api/v1/audit-events/:eventId",
    requirePermission("audit:read", "audit.events.detail.read", () => ({ type: "controller" })),
    async (c) => {
      const event = await auditStore.find(c.req.param("eventId"));

      return event
        ? c.json({
            data: {
              actions: auditEventActions(event),
              event,
              links: auditEventLinks(event),
            },
          })
        : c.json({ error: "Audit event not found" }, 404);
    },
  );

  app.get(
    "/api/v1/audit-events",
    requirePermission("audit:read", "audit.events.read"),
    async (c) => {
      const query = auditEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
      }

      return c.json({ data: await auditStore.list(auditFilters(query.data)) });
    },
  );
}

function auditFilters(input: z.infer<typeof auditEventsQuerySchema>): AuditEventFilters {
  return {
    action: input.action,
    actor: input.actor,
    from: input.from ? new Date(input.from) : undefined,
    id: input.id,
    limit: input.limit,
    outcome: input.outcome,
    permission: input.permission,
    reason: input.reason,
    target: input.target,
    to: input.to ? new Date(input.to) : undefined,
  };
}

function auditEventActions(event: AuditEvent) {
  return {
    detail: actionState({
      href: `/api/v1/audit-events/${encodeURIComponent(event.id)}`,
      method: "GET",
      permission: "audit:read",
      ready: true,
    }),
    export: actionState({
      href: `/api/v1/audit-events/export?id=${encodeURIComponent(event.id)}`,
      method: "GET",
      permission: "audit:read",
      ready: true,
    }),
  };
}

function actionState({
  href,
  method,
  permission,
  ready,
}: {
  href: string;
  method: AuditActionState["method"];
  permission: Permission;
  ready: boolean;
}): AuditActionState {
  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason: "audit_event_unavailable" };
}

function auditEventLinks(event: AuditEvent) {
  return {
    actions: `/api/v1/audit-events/${encodeURIComponent(event.id)}/actions`,
    detail: `/api/v1/audit-events/${encodeURIComponent(event.id)}`,
    export: `/api/v1/audit-events/export?id=${encodeURIComponent(event.id)}`,
  };
}

function auditEventsCsv(events: AuditEvent[]) {
  return [
    csvRow([
      "createdAt",
      "actorType",
      "actorId",
      "actorName",
      "actorRoles",
      "action",
      "permission",
      "targetType",
      "targetId",
      "targetName",
      "outcome",
      "reason",
      "correlationIds",
      "details",
      "before",
      "after",
    ]),
    ...events.map((event) =>
      csvRow([
        event.createdAt,
        event.actor.type,
        event.actor.id,
        event.actor.name,
        event.actor.roles.join("|"),
        event.action,
        event.permission ?? "",
        event.target.type,
        event.target.id ?? "",
        event.target.name ?? "",
        event.outcome,
        event.reason ?? "",
        jsonCell(event.correlationIds),
        jsonCell(event.details),
        jsonCell(event.before),
        jsonCell(event.after),
      ]),
    ),
  ].join("\n");
}

function csvRow(values: string[]) {
  return values.map(csvCell).join(",");
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function jsonCell(value: unknown) {
  return value ? JSON.stringify(value) : "";
}

function auditExportFileName() {
  return `rakkr-audit-events-${new Date().toISOString().replaceAll(":", "-")}.csv`;
}
