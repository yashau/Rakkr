import {
  and,
  auditEvents as auditEventsTable,
  count,
  createDatabase,
  desc,
  eq,
  gte,
  ilike,
  lte,
  or,
  sql,
  type SQL,
} from "@rakkr/db";
import {
  permissions,
  roles,
  type AuditActorType,
  type AuditEvent,
  type AuditOutcome,
  type Permission,
  type Role,
} from "@rakkr/shared";

type AuditEventRow = typeof auditEventsTable.$inferSelect;

export interface AuditEventFilters {
  action?: string;
  actor?: string;
  from?: Date;
  id?: string;
  limit?: number;
  offset?: number;
  outcome?: AuditOutcome;
  permission?: Permission;
  reason?: string;
  target?: string;
  to?: Date;
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  /** Total number of events matching the filters, ignoring limit/offset. */
  count(filters?: AuditEventFilters): Promise<number>;
  find(eventId: string): Promise<AuditEvent | undefined>;
  /** A single page of matching events (honors limit/offset). */
  list(filters?: AuditEventFilters): Promise<AuditEvent[]>;
  /** Every matching event (no limit), for in-memory RBAC scoping + exports. */
  listAll(filters?: AuditEventFilters): Promise<AuditEvent[]>;
}

export function createAuditStore(databaseUrl = process.env.DATABASE_URL): AuditStore {
  const memory = new MemoryAuditStore();

  if (!databaseUrl) {
    return memory;
  }

  return new PostgresAuditStore(databaseUrl, memory);
}

class MemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];
  private readonly maxEvents = 500;

  async append(event: AuditEvent) {
    this.events.unshift(event);

    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }
  }

  async find(eventId: string) {
    return this.events.find((event) => event.id === eventId);
  }

  async list(filters: AuditEventFilters = {}) {
    return this.matching(filters).slice(offset(filters), offset(filters) + limit(filters));
  }

  async listAll(filters: AuditEventFilters = {}) {
    return this.matching(filters);
  }

  async count(filters: AuditEventFilters = {}) {
    return this.matching(filters).length;
  }

  // Newest-first by insertion order (events are unshifted on append), which is a
  // stable order for offset pagination.
  private matching(filters: AuditEventFilters) {
    return this.events.filter((event) => matchesAuditFilters(event, filters));
  }
}

class PostgresAuditStore implements AuditStore {
  private dbAvailable = true;
  private readonly db;
  private readonly memory: AuditStore;

  constructor(databaseUrl: string, memory: AuditStore) {
    this.db = createDatabase(databaseUrl);
    this.memory = memory;
  }

  async append(event: AuditEvent) {
    await this.memory.append(event);

    if (!this.dbAvailable) {
      return;
    }

    try {
      await this.db.insert(auditEventsTable).values({
        action: event.action,
        actorContext: event.actorContext,
        actorDisplayName: event.actor.name,
        actorId: event.actor.id,
        actorRoles: event.actor.roles,
        actorType: event.actor.type,
        actorUserId: uuidOrNull(event.actor.id),
        after: event.after,
        before: event.before,
        correlationIds: event.correlationIds ?? {},
        details: event.details,
        outcome: event.outcome,
        permissionId: event.permission,
        reason: event.reason,
        targetId: event.target.id,
        targetName: event.target.name,
        targetType: event.target.type,
      });
    } catch (error) {
      this.dbAvailable = false;
      console.warn("audit event persistence unavailable; using memory store", error);
    }
  }

  async find(eventId: string) {
    if (!this.dbAvailable) {
      return this.memory.find(eventId);
    }

    if (!isUuid(eventId)) {
      return undefined;
    }

    try {
      const [row] = await this.db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, eventId))
        .limit(1);

      return row ? auditEventFromRow(row) : undefined;
    } catch (error) {
      this.dbAvailable = false;
      console.warn("audit event detail query unavailable; using memory store", error);
      return this.memory.find(eventId);
    }
  }

  async list(filters: AuditEventFilters = {}) {
    if (!this.dbAvailable) {
      return this.memory.list(filters);
    }

    try {
      const conditions = auditConditions(filters);
      // (createdAt desc, id desc) is a deterministic total order so OFFSET pages
      // never skip or duplicate rows when timestamps collide.
      const rows =
        conditions.length > 0
          ? await this.db
              .select()
              .from(auditEventsTable)
              .where(and(...conditions))
              .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
              .limit(limit(filters))
              .offset(offset(filters))
          : await this.db
              .select()
              .from(auditEventsTable)
              .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
              .limit(limit(filters))
              .offset(offset(filters));

      return rows.map(auditEventFromRow);
    } catch (error) {
      this.dbAvailable = false;
      console.warn("audit event query unavailable; using memory store", error);
      return this.memory.list(filters);
    }
  }

  async listAll(filters: AuditEventFilters = {}) {
    if (!this.dbAvailable) {
      return this.memory.listAll(filters);
    }

    try {
      const conditions = auditConditions(filters);
      const rows =
        conditions.length > 0
          ? await this.db
              .select()
              .from(auditEventsTable)
              .where(and(...conditions))
              .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
          : await this.db
              .select()
              .from(auditEventsTable)
              .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id));

      return rows.map(auditEventFromRow);
    } catch (error) {
      this.dbAvailable = false;
      console.warn("audit event query unavailable; using memory store", error);
      return this.memory.listAll(filters);
    }
  }

  async count(filters: AuditEventFilters = {}) {
    if (!this.dbAvailable) {
      return this.memory.count(filters);
    }

    try {
      const conditions = auditConditions(filters);
      const [row] =
        conditions.length > 0
          ? await this.db
              .select({ value: count() })
              .from(auditEventsTable)
              .where(and(...conditions))
          : await this.db.select({ value: count() }).from(auditEventsTable);

      return row?.value ?? 0;
    } catch (error) {
      this.dbAvailable = false;
      console.warn("audit event count unavailable; using memory store", error);
      return this.memory.count(filters);
    }
  }
}

function auditConditions(filters: AuditEventFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.id) {
    conditions.push(isUuid(filters.id) ? eq(auditEventsTable.id, filters.id) : sql`false`);
  }

  if (filters.action) {
    conditions.push(ilike(auditEventsTable.action, contains(filters.action)));
  }

  if (filters.actor) {
    conditions.push(
      or(
        ilike(auditEventsTable.actorId, contains(filters.actor)),
        ilike(auditEventsTable.actorDisplayName, contains(filters.actor)),
      )!,
    );
  }

  if (filters.target) {
    conditions.push(
      or(
        ilike(auditEventsTable.targetId, contains(filters.target)),
        ilike(auditEventsTable.targetName, contains(filters.target)),
        ilike(auditEventsTable.targetType, contains(filters.target)),
      )!,
    );
  }

  if (filters.outcome) {
    conditions.push(eq(auditEventsTable.outcome, filters.outcome));
  }

  if (filters.permission) {
    conditions.push(eq(auditEventsTable.permissionId, filters.permission));
  }

  if (filters.reason) {
    conditions.push(ilike(auditEventsTable.reason, contains(filters.reason)));
  }

  if (filters.from) {
    conditions.push(gte(auditEventsTable.createdAt, filters.from));
  }

  if (filters.to) {
    conditions.push(lte(auditEventsTable.createdAt, filters.to));
  }

  return conditions;
}

function matchesAuditFilters(event: AuditEvent, filters: AuditEventFilters) {
  return (
    (!filters.id || event.id === filters.id) &&
    includesFilter(event.action, filters.action) &&
    includesFilter(`${event.actor.id} ${event.actor.name}`, filters.actor) &&
    includesFilter(
      `${event.target.id ?? ""} ${event.target.name ?? ""} ${event.target.type}`,
      filters.target,
    ) &&
    (!filters.outcome || event.outcome === filters.outcome) &&
    (!filters.permission || event.permission === filters.permission) &&
    includesFilter(event.reason ?? "", filters.reason) &&
    (!filters.from || new Date(event.createdAt) >= filters.from) &&
    (!filters.to || new Date(event.createdAt) <= filters.to)
  );
}

function includesFilter(value: string, filter?: string) {
  return !filter || value.toLowerCase().includes(filter.toLowerCase());
}

function contains(value: string) {
  return `%${value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function limit(filters: AuditEventFilters) {
  return Math.min(Math.max(filters.limit ?? 100, 1), 500);
}

function offset(filters: AuditEventFilters) {
  return Math.max(filters.offset ?? 0, 0);
}

function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

function auditEventFromRow(row: AuditEventRow): AuditEvent {
  return {
    action: row.action,
    actor: {
      id: row.actorId ?? row.actorUserId ?? "unknown",
      name: row.actorDisplayName ?? row.actorId ?? "Unknown actor",
      roles: roleArray(row.actorRoles),
      type: actorType(row.actorType),
    },
    actorContext: record(row.actorContext) ?? {},
    after: record(row.after),
    before: record(row.before),
    correlationIds: stringRecord(row.correlationIds),
    createdAt: row.createdAt.toISOString(),
    details: record(row.details) ?? {},
    id: row.id,
    outcome: row.outcome,
    permission: permission(row.permissionId),
    reason: row.reason ?? undefined,
    target: {
      id: row.targetId ?? undefined,
      name: row.targetName ?? undefined,
      type: row.targetType ?? "unknown",
    },
  };
}

function actorType(value: string): AuditActorType {
  return value === "node" || value === "system" || value === "user" ? value : "user";
}

function permission(value: string | null): Permission | undefined {
  return permissions.includes(value as Permission) ? (value as Permission) : undefined;
}

function roleArray(value: unknown): Role[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((role): role is Role => roles.includes(role as Role));
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const source = record(value);

  if (!source) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function uuidOrNull(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) ? value : null;
}
