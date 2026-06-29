import { z } from "zod";
import type { Context, Hono } from "hono";
import {
  auditOutcomeSchema,
  permissionSchema,
  type AuditEvent,
  type Permission,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { canReadAuditEvent } from "./audit-scope.js";
import type { AuditEventFilters, AuditStore } from "./audit-store.js";
import { buildPaginationMeta, PAGE_POLICY, paginate, parsePagination } from "./pagination.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";

interface AuditRouteDependencies {
  app: Hono<AppBindings>;
  auditStore: AuditStore;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

interface AuditActionState {
  enabled: boolean;
  href?: string;
  method: "GET";
  permission: Permission;
  reason?: string;
}

interface AuditFacetCount {
  count: number;
  value: string;
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
  offset: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(0).optional(),
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
const selectedAuditExportSchema = z
  .object({
    eventIds: z.array(z.string().trim().min(1).max(160)).min(1).max(500),
  })
  .strict();

export function registerAuditRoutes({
  app,
  auditStore,
  currentAuth,
  hasResourceScope,
  recordAuditEvent,
  requirePermission,
}: AuditRouteDependencies) {
  app.get(
    "/api/v1/audit-events/export",
    requirePermission("audit:read", "audit.events.export"),
    async (c) => {
      const query = auditEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        await recordAuditRead(c, {
          action: "audit.events.export.failed",
          reason: "invalid_filters",
        });
        return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
      }

      // Exports cover every matching row regardless of any limit/offset query.
      const events = await scopedAuditEvents(
        currentUser(c, currentAuth),
        await auditStore.listAll(auditFilters(query.data)),
      );

      await recordAuditRead(c, {
        action: "audit.events.export.succeeded",
        details: {
          exportedCount: events.length,
        },
      });

      return c.text(auditEventsCsv(events), 200, {
        "Content-Disposition": `attachment; filename="${auditExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.post(
    "/api/v1/audit-events/export",
    requirePermission("audit:read", "audit.events.export_selected", () => ({
      type: "controller",
    })),
    async (c) => {
      const body = selectedAuditExportSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSelectedAuditExportFailure(c, "invalid_request");
        return c.json({ error: "Invalid audit export request", issues: body.error.issues }, 400);
      }

      const eventIds = uniqueAuditEventIds(body.data.eventIds);
      const events: AuditEvent[] = [];

      for (const eventId of eventIds) {
        const event = await auditStore.find(eventId);

        if (!event) {
          await recordSelectedAuditExportFailure(c, "audit_event_not_found", {
            eventIds,
            missingId: eventId,
          });
          return c.json({ error: "Audit event not found", eventId }, 404);
        }

        if (
          !(await canReadAuditEvent(currentUser(c, currentAuth), event, {
            allowActorSelf: true,
            hasResourceScope,
          }))
        ) {
          await recordSelectedAuditExportFailure(c, "audit_event_not_found", {
            eventIds,
            missingId: eventId,
          });
          return c.json({ error: "Audit event not found", eventId }, 404);
        }

        events.push(event);
      }

      await recordAuditEvent(c, {
        action: "audit.events.export_selected.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          eventIds.map((eventId, index) => [`auditEventId${index + 1}`, eventId]),
        ),
        details: {
          exportedCount: events.length,
          requestedCount: body.data.eventIds.length,
        },
        outcome: "succeeded",
        permission: "audit:read",
        target: {
          type: "controller",
        },
      });

      return c.text(auditEventsCsv(events), 200, {
        "Content-Disposition": `attachment; filename="${auditExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.get(
    "/api/v1/audit-events/facets",
    requirePermission("audit:read", "audit.events.facets.read", () => ({
      type: "controller",
    })),
    async (c) => {
      const query = auditEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        await recordAuditRead(c, {
          action: "audit.events.facets.read.failed",
          reason: "invalid_filters",
        });
        return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
      }

      const events = await scopedAuditEvents(
        currentUser(c, currentAuth),
        await auditStore.list({
          ...auditFilters(query.data),
          limit: query.data.limit ?? 500,
          offset: 0,
        }),
      );

      await recordAuditRead(c, {
        action: "audit.events.facets.read.succeeded",
        details: {
          returnedCount: events.length,
        },
      });

      return c.json({ data: auditEventFacets(events) });
    },
  );

  app.get(
    "/api/v1/audit-events/:eventId/actions",
    requirePermission("audit:read", "audit.events.actions.read", () => ({ type: "controller" })),
    async (c) => {
      const eventId = c.req.param("eventId");
      const event = await auditStore.find(eventId);
      const canRead =
        event &&
        (await canReadAuditEvent(currentUser(c, currentAuth), event, {
          allowActorSelf: true,
          hasResourceScope,
        }));

      if (!canRead) {
        await recordAuditRead(c, {
          action: "audit.events.actions.read.failed",
          details: { eventId },
          reason: "audit_event_not_found",
        });

        return c.json({ error: "Audit event not found" }, 404);
      }

      await recordAuditRead(c, {
        action: "audit.events.actions.read.succeeded",
        details: { eventId: event.id },
      });

      return c.json({
        data: {
          actions: auditEventActions(event),
          event,
          links: auditEventLinks(event),
        },
      });
    },
  );

  app.get(
    "/api/v1/audit-events/:eventId",
    requirePermission("audit:read", "audit.events.detail.read", () => ({ type: "controller" })),
    async (c) => {
      const eventId = c.req.param("eventId");
      const event = await auditStore.find(eventId);
      const canRead =
        event &&
        (await canReadAuditEvent(currentUser(c, currentAuth), event, {
          allowActorSelf: true,
          hasResourceScope,
        }));

      if (!canRead) {
        await recordAuditRead(c, {
          action: "audit.events.detail.read.failed",
          details: { eventId },
          reason: "audit_event_not_found",
        });

        return c.json({ error: "Audit event not found" }, 404);
      }

      await recordAuditRead(c, {
        action: "audit.events.detail.read.succeeded",
        details: { eventId: event.id },
      });

      return c.json({
        data: {
          actions: auditEventActions(event),
          event,
          links: auditEventLinks(event),
        },
      });
    },
  );

  app.get(
    "/api/v1/audit-events",
    requirePermission("audit:read", "audit.events.read"),
    async (c) => {
      const query = auditEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        await recordAuditRead(c, {
          action: "audit.events.read.failed",
          reason: "invalid_filters",
        });
        return c.json({ error: "Invalid audit filters", issues: query.error.issues }, 400);
      }

      const user = currentUser(c, currentAuth);
      const filters = auditFilters(query.data);
      const page = parsePagination(
        { limit: query.data.limit, offset: query.data.offset },
        PAGE_POLICY.audit,
      );

      // Hybrid pagination: owner/admin readers are never scope-restricted, so we
      // page + COUNT directly in SQL. Scope-restricted readers cannot be filtered
      // in SQL (visibility is a runtime policy decision), so we scope the full
      // matching set in memory and paginate that to keep the total accurate.
      let data: AuditEvent[];
      let meta;

      if (auditReaderUnrestricted(user)) {
        data = await scopedAuditEvents(
          user,
          await auditStore.list({ ...filters, limit: page.limit, offset: page.offset }),
        );
        meta = buildPaginationMeta({
          limit: page.limit,
          offset: page.offset,
          returned: data.length,
          total: await auditStore.count(filters),
        });
      } else {
        const visible = await scopedAuditEvents(user, await auditStore.listAll(filters));
        const sliced = paginate(visible, { limit: page.limit, offset: page.offset });
        data = sliced.data;
        meta = sliced.meta;
      }

      await recordAuditRead(c, {
        action: "audit.events.read.succeeded",
        details: {
          returnedCount: data.length,
          total: meta.total,
        },
      });

      return c.json({ data, meta });
    },
  );

  async function scopedAuditEvents(user: NonNullable<AuthResult["user"]>, events: AuditEvent[]) {
    const scopedEvents: AuditEvent[] = [];

    for (const event of events) {
      if (await canReadAuditEvent(user, event, { allowActorSelf: true, hasResourceScope })) {
        scopedEvents.push(event);
      }
    }

    return scopedEvents;
  }

  async function recordSelectedAuditExportFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "audit.events.export_selected.failed",
      auth: currentAuth(c),
      details,
      outcome: "failed",
      permission: "audit:read",
      reason,
      target: {
        type: "controller",
      },
    });
  }

  async function recordAuditRead(
    c: Context<AppBindings>,
    {
      action,
      details,
      reason,
    }: {
      action: string;
      details?: Record<string, unknown>;
      reason?: string;
    },
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      details,
      outcome: reason ? "failed" : "succeeded",
      permission: "audit:read",
      reason,
      target: {
        type: "controller",
      },
    });
  }
}

function auditFilters(input: z.infer<typeof auditEventsQuerySchema>): AuditEventFilters {
  return {
    action: input.action,
    actor: input.actor,
    from: input.from ? new Date(input.from) : undefined,
    id: input.id,
    limit: input.limit,
    offset: input.offset,
    outcome: input.outcome,
    permission: input.permission,
    reason: input.reason,
    target: input.target,
    to: input.to ? new Date(input.to) : undefined,
  };
}

// Owner/admin readers bypass resource scoping (see resourceScopeDecision), so
// their visible set equals the full filtered set and can be paged + counted in
// SQL. Everyone else may be scope-restricted and uses the in-memory path.
function auditReaderUnrestricted(user: NonNullable<AuthResult["user"]>) {
  return user.roles.includes("owner") || user.roles.includes("admin");
}

function currentUser(
  c: Context<AppBindings>,
  currentAuth: (c: Context<AppBindings>) => AuthResult,
) {
  const user = currentAuth(c).user;

  if (!user) {
    throw new Error("Authenticated route reached without a user");
  }

  return user;
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

function uniqueAuditEventIds(eventIds: string[]) {
  return [...new Set(eventIds.map((eventId) => eventId.trim()))];
}

function auditEventFacets(events: AuditEvent[]) {
  return {
    actions: facetCounts(events.map((event) => event.action)),
    actorTypes: facetCounts(events.map((event) => event.actor.type)),
    outcomes: facetCounts(events.map((event) => event.outcome)),
    permissions: facetCounts(events.map((event) => event.permission)),
    reasons: facetCounts(events.map((event) => event.reason)),
    targetTypes: facetCounts(events.map((event) => event.target.type)),
    total: events.length,
  };
}

function facetCounts(values: Array<string | undefined>): AuditFacetCount[] {
  const counts = new Map<string, number>();

  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ count, value }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
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
