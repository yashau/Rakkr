import {
  and,
  createDatabase,
  desc,
  eq,
  healthEvents as healthEventsTable,
  type SQL,
} from "@rakkr/db";
import { randomUUID } from "node:crypto";
import type { HealthEvent, HealthEventStatus, HealthSeverity } from "@rakkr/shared";

type HealthEventRow = typeof healthEventsTable.$inferSelect;

export interface HealthEventCreateInput {
  details?: Record<string, unknown>;
  nodeId?: string;
  openedAt?: Date;
  recordingId?: string;
  scheduleId?: string;
  severity: HealthSeverity;
  type: string;
}

export interface HealthEventFilters {
  limit?: number;
  nodeId?: string;
  recordingId?: string;
  scheduleId?: string;
  severity?: HealthSeverity;
  status?: HealthEventStatus;
  type?: string;
}

export interface HealthEventLifecycleUpdate {
  acknowledgedAt?: Date | null;
  acknowledgedBy?: string | null;
  details?: Record<string, unknown>;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  status: HealthEventStatus;
  suppressedAt?: Date | null;
  suppressedBy?: string | null;
  suppressedUntil?: Date | null;
}

export interface HealthEventUpdateInput {
  details?: Record<string, unknown>;
  severity?: HealthSeverity;
  status?: HealthEventStatus;
}

export interface HealthEventStore {
  create(input: HealthEventCreateInput): Promise<HealthEvent>;
  find(eventId: string): Promise<HealthEvent | undefined>;
  list(filters?: HealthEventFilters): Promise<HealthEvent[]>;
  update(eventId: string, update: HealthEventUpdateInput): Promise<HealthEvent | undefined>;
  updateLifecycle(
    eventId: string,
    update: HealthEventLifecycleUpdate,
  ): Promise<HealthEvent | undefined>;
}

export function createHealthEventStore(
  databaseUrl = process.env.DATABASE_URL,
  seedEvents: HealthEvent[] = [],
): HealthEventStore {
  const memory = new MemoryHealthEventStore(seedEvents);

  return databaseUrl ? new PostgresHealthEventStore(databaseUrl, memory) : memory;
}

class MemoryHealthEventStore implements HealthEventStore {
  constructor(private readonly events: HealthEvent[]) {}

  async create(input: HealthEventCreateInput) {
    const event: HealthEvent = {
      acknowledgedAt: null,
      details: input.details ?? {},
      id: `health_${randomUUID()}`,
      nodeId: input.nodeId,
      openedAt: (input.openedAt ?? new Date()).toISOString(),
      recordingId: input.recordingId,
      resolvedAt: null,
      scheduleId: input.scheduleId,
      severity: input.severity,
      status: "open",
      suppressedAt: null,
      suppressedUntil: null,
      type: input.type,
    };

    this.events.unshift(event);

    return event;
  }

  async find(eventId: string) {
    return this.events.find((event) => event.id === eventId);
  }

  async list(filters: HealthEventFilters = {}) {
    return this.events
      .filter((event) => matchesHealthFilters(event, filters))
      .sort((left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt))
      .slice(0, limit(filters));
  }

  async updateLifecycle(eventId: string, update: HealthEventLifecycleUpdate) {
    const index = this.events.findIndex((event) => event.id === eventId);

    if (index < 0) {
      return undefined;
    }

    this.events[index] = {
      ...this.events[index],
      ...lifecyclePatch(update),
    };

    return this.events[index];
  }

  async update(eventId: string, update: HealthEventUpdateInput) {
    const index = this.events.findIndex((event) => event.id === eventId);

    if (index < 0) {
      return undefined;
    }

    this.events[index] = {
      ...this.events[index],
      ...update,
    };

    return this.events[index];
  }
}

class PostgresHealthEventStore implements HealthEventStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: HealthEventStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async create(input: HealthEventCreateInput) {
    if (!this.dbAvailable) {
      return this.fallback.create(input);
    }

    try {
      const [row] = await this.db
        .insert(healthEventsTable)
        .values({
          details: input.details ?? {},
          nodeId: input.nodeId ?? null,
          openedAt: input.openedAt ?? new Date(),
          recordingId: input.recordingId ?? null,
          scheduleId: input.scheduleId ?? null,
          severity: input.severity,
          status: "open",
          type: input.type,
        })
        .returning();

      return healthEventFromRow(row);
    } catch (error) {
      this.dbAvailable = false;
      console.warn("health event persistence unavailable; using memory store", error);
      return this.fallback.create(input);
    }
  }

  async find(eventId: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(eventId);
    }

    try {
      const [row] = await this.db
        .select()
        .from(healthEventsTable)
        .where(eq(healthEventsTable.id, eventId))
        .limit(1);

      return row ? healthEventFromRow(row) : undefined;
    } catch (error) {
      this.dbAvailable = false;
      console.warn("health event lookup unavailable; using memory store", error);
      return this.fallback.find(eventId);
    }
  }

  async list(filters: HealthEventFilters = {}) {
    if (!this.dbAvailable) {
      return this.fallback.list(filters);
    }

    try {
      const conditions = healthConditions(filters);
      const rows =
        conditions.length > 0
          ? await this.db
              .select()
              .from(healthEventsTable)
              .where(and(...conditions))
              .orderBy(desc(healthEventsTable.openedAt))
              .limit(limit(filters))
          : await this.db
              .select()
              .from(healthEventsTable)
              .orderBy(desc(healthEventsTable.openedAt))
              .limit(limit(filters));

      return rows.map(healthEventFromRow);
    } catch (error) {
      this.dbAvailable = false;
      console.warn("health event query unavailable; using memory store", error);
      return this.fallback.list(filters);
    }
  }

  async update(eventId: string, update: HealthEventUpdateInput) {
    if (!this.dbAvailable) {
      return this.fallback.update(eventId, update);
    }

    try {
      const [row] = await this.db
        .update(healthEventsTable)
        .set(updateRow(update))
        .where(eq(healthEventsTable.id, eventId))
        .returning();

      return row ? healthEventFromRow(row) : undefined;
    } catch (error) {
      this.dbAvailable = false;
      console.warn("health event update unavailable; using memory store", error);
      return this.fallback.update(eventId, update);
    }
  }

  async updateLifecycle(eventId: string, update: HealthEventLifecycleUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.updateLifecycle(eventId, update);
    }

    try {
      const [row] = await this.db
        .update(healthEventsTable)
        .set(lifecycleRow(update))
        .where(eq(healthEventsTable.id, eventId))
        .returning();

      return row ? healthEventFromRow(row) : undefined;
    } catch (error) {
      this.dbAvailable = false;
      console.warn("health event lifecycle update unavailable; using memory store", error);
      return this.fallback.updateLifecycle(eventId, update);
    }
  }
}

function healthConditions(filters: HealthEventFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.nodeId) {
    conditions.push(eq(healthEventsTable.nodeId, filters.nodeId));
  }

  if (filters.recordingId) {
    conditions.push(eq(healthEventsTable.recordingId, filters.recordingId));
  }

  if (filters.scheduleId) {
    conditions.push(eq(healthEventsTable.scheduleId, filters.scheduleId));
  }

  if (filters.severity) {
    conditions.push(eq(healthEventsTable.severity, filters.severity));
  }

  if (filters.status) {
    conditions.push(eq(healthEventsTable.status, filters.status));
  }

  if (filters.type) {
    conditions.push(eq(healthEventsTable.type, filters.type));
  }

  return conditions;
}

function matchesHealthFilters(event: HealthEvent, filters: HealthEventFilters) {
  return (
    (!filters.nodeId || event.nodeId === filters.nodeId) &&
    (!filters.recordingId || event.recordingId === filters.recordingId) &&
    (!filters.scheduleId || event.scheduleId === filters.scheduleId) &&
    (!filters.severity || event.severity === filters.severity) &&
    (!filters.status || event.status === filters.status) &&
    (!filters.type || event.type === filters.type)
  );
}

function healthEventFromRow(row: HealthEventRow): HealthEvent {
  return {
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy ?? undefined,
    details: record(row.details) ?? {},
    id: row.id,
    nodeId: row.nodeId ?? undefined,
    openedAt: row.openedAt.toISOString(),
    recordingId: row.recordingId ?? undefined,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy ?? undefined,
    scheduleId: row.scheduleId ?? undefined,
    severity: row.severity,
    status: healthEventStatus(row.status),
    suppressedAt: row.suppressedAt?.toISOString() ?? null,
    suppressedBy: row.suppressedBy ?? undefined,
    suppressedUntil: row.suppressedUntil?.toISOString() ?? null,
    type: row.type,
  };
}

function lifecyclePatch(update: HealthEventLifecycleUpdate): Partial<HealthEvent> {
  return withoutUndefined({
    acknowledgedAt: dateToIso(update.acknowledgedAt),
    acknowledgedBy: stringOrUndefined(update.acknowledgedBy),
    ...(update.details ? { details: update.details } : {}),
    resolvedAt: dateToIso(update.resolvedAt),
    resolvedBy: stringOrUndefined(update.resolvedBy),
    status: update.status,
    suppressedAt: dateToIso(update.suppressedAt),
    suppressedBy: stringOrUndefined(update.suppressedBy),
    suppressedUntil: dateToIso(update.suppressedUntil),
  });
}

function updateRow(update: HealthEventUpdateInput): Partial<typeof healthEventsTable.$inferInsert> {
  return withoutUndefined({
    details: update.details,
    severity: update.severity,
    status: update.status,
  });
}

function lifecycleRow(
  update: HealthEventLifecycleUpdate,
): Partial<typeof healthEventsTable.$inferInsert> {
  return withoutUndefined({
    acknowledgedAt: update.acknowledgedAt,
    acknowledgedBy: update.acknowledgedBy,
    details: update.details,
    resolvedAt: update.resolvedAt,
    resolvedBy: update.resolvedBy,
    status: update.status,
    suppressedAt: update.suppressedAt,
    suppressedBy: update.suppressedBy,
    suppressedUntil: update.suppressedUntil,
  });
}

function dateToIso(value: Date | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return value?.toISOString() ?? null;
}

function healthEventStatus(value: string): HealthEventStatus {
  if (
    value === "open" ||
    value === "acknowledged" ||
    value === "suppressed" ||
    value === "resolved"
  ) {
    return value;
  }

  return "open";
}

function limit(filters: HealthEventFilters) {
  return Math.min(Math.max(filters.limit ?? 100, 1), 500);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrUndefined(value: string | null | undefined) {
  return value && value.trim() ? value : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Partial<T>;
}
