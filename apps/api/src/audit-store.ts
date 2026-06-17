import { auditEvents as auditEventsTable, createDatabase, desc } from "@rakkr/db";
import {
  permissions,
  roles,
  type AuditActorType,
  type AuditEvent,
  type Permission,
  type Role,
} from "@rakkr/shared";

type AuditEventRow = typeof auditEventsTable.$inferSelect;

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  list(limit?: number): Promise<AuditEvent[]>;
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

  async list(limit = 100) {
    return this.events.slice(0, limit);
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

  async list(limit = 100) {
    if (!this.dbAvailable) {
      return this.memory.list(limit);
    }

    try {
      const rows = await this.db
        .select()
        .from(auditEventsTable)
        .orderBy(desc(auditEventsTable.createdAt))
        .limit(limit);

      return rows.map(auditEventFromRow);
    } catch (error) {
      this.dbAvailable = false;
      console.warn("audit event query unavailable; using memory store", error);
      return this.memory.list(limit);
    }
  }
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
