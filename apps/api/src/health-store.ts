import {
  and,
  createDatabase,
  desc,
  eq,
  healthEvents as healthEventsTable,
  type SQL,
} from "@rakkr/db";
import type { HealthEvent, HealthSeverity } from "@rakkr/shared";

type HealthEventRow = typeof healthEventsTable.$inferSelect;

export interface HealthEventFilters {
  limit?: number;
  nodeId?: string;
  recordingId?: string;
  scheduleId?: string;
  severity?: HealthSeverity;
}

export interface HealthEventStore {
  list(filters?: HealthEventFilters): Promise<HealthEvent[]>;
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

  async list(filters: HealthEventFilters = {}) {
    return this.events
      .filter((event) => matchesHealthFilters(event, filters))
      .sort((left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt))
      .slice(0, limit(filters));
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

  return conditions;
}

function matchesHealthFilters(event: HealthEvent, filters: HealthEventFilters) {
  return (
    (!filters.nodeId || event.nodeId === filters.nodeId) &&
    (!filters.recordingId || event.recordingId === filters.recordingId) &&
    (!filters.scheduleId || event.scheduleId === filters.scheduleId) &&
    (!filters.severity || event.severity === filters.severity)
  );
}

function healthEventFromRow(row: HealthEventRow): HealthEvent {
  return {
    details: record(row.details) ?? {},
    id: row.id,
    nodeId: row.nodeId ?? undefined,
    openedAt: row.openedAt.toISOString(),
    recordingId: row.recordingId ?? undefined,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    scheduleId: row.scheduleId ?? undefined,
    severity: row.severity,
    type: row.type,
  };
}

function limit(filters: HealthEventFilters) {
  return Math.min(Math.max(filters.limit ?? 100, 1), 500);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
