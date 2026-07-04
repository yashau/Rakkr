import { randomUUID } from "node:crypto";
import {
  channelMapTemplates as channelMapTemplatesTable,
  templateAssignments as templateAssignmentsTable,
} from "@rakkr/db";
import {
  channelMapTemplateAssignmentSchema,
  channelMapTemplateSchema,
  type ChannelMapTemplate,
  type ChannelMapTemplateAssignment,
  type ChannelMapTemplateAssignmentInput,
  type ChannelMapTemplateInput,
  type ChannelMapTemplateUpdate,
} from "@rakkr/shared";

type ChannelMapTemplateInsert = typeof channelMapTemplatesTable.$inferInsert;
type ChannelMapTemplateRow = typeof channelMapTemplatesTable.$inferSelect;
type TemplateAssignmentInsert = typeof templateAssignmentsTable.$inferInsert;
type TemplateAssignmentRow = typeof templateAssignmentsTable.$inferSelect;

export function channelMapTemplateFromInput(input: ChannelMapTemplateInput): ChannelMapTemplate {
  const now = new Date().toISOString();

  return channelMapTemplateSchema.parse({
    channelMode: input.channelMode,
    entries: input.entries,
    id: input.id ?? `channel_map_${randomUUID()}`,
    name: input.name,
    promotedAt: now,
    revision: 1,
    tags: input.tags,
  });
}

export function channelMapTemplateToRow(template: ChannelMapTemplate): ChannelMapTemplateInsert {
  return {
    channelMode: template.channelMode,
    entries: template.entries,
    id: template.id,
    metadata: channelMapTemplateMetadata(template),
    name: template.name,
    tags: template.tags,
    updatedAt: new Date(),
  };
}

export function channelMapTemplateFromRow(row: ChannelMapTemplateRow): ChannelMapTemplate {
  const metadata = record(row.metadata) ?? {};

  return channelMapTemplateSchema.parse({
    channelMode: row.channelMode,
    entries: row.entries,
    id: row.id,
    name: row.name,
    promotedAt: stringOrUndefined(metadata.promotedAt),
    promotedFromTemplateId: stringOrUndefined(metadata.promotedFromTemplateId),
    revision: positiveIntegerOrDefault(metadata.revision, 1),
    tags: row.tags,
  });
}

export function nextChannelMapRevision(
  existing: ChannelMapTemplate,
  update: ChannelMapTemplateUpdate,
  templateId: string,
) {
  return channelMapTemplateSchema.parse({
    ...existing,
    ...update,
    id: templateId,
    promotedAt: new Date().toISOString(),
    promotedFromTemplateId: existing.id,
    revision: existing.revision + 1,
  });
}

function channelMapTemplateMetadata(template: ChannelMapTemplate) {
  const metadata: Record<string, unknown> = {
    revision: template.revision,
  };

  if (template.promotedAt) {
    metadata.promotedAt = template.promotedAt;
  }

  if (template.promotedFromTemplateId) {
    metadata.promotedFromTemplateId = template.promotedFromTemplateId;
  }

  return metadata;
}

export function channelMapAssignmentFromInput(
  input: ChannelMapTemplateAssignmentInput,
  existing?: ChannelMapTemplateAssignment,
  actorUserId?: string,
  reason: "assigned" | "rolled_back" = "assigned",
): ChannelMapTemplateAssignment {
  const changedAt = new Date().toISOString();
  const previousTemplateId = existing?.templateId;

  return channelMapTemplateAssignmentSchema.parse({
    assignedAt: changedAt,
    history: [
      ...(existing?.history ?? []),
      {
        actorUserId,
        changedAt,
        id: `assignment_event_${randomUUID()}`,
        nextTemplateId: input.templateId,
        previousTemplateId,
        reason,
      },
    ],
    id: existing?.id ?? `assignment_${randomUUID()}`,
    targetId: input.targetId,
    targetType: input.targetType,
    templateId: input.templateId,
  });
}

export function channelMapAssignmentToRow(
  assignment: ChannelMapTemplateAssignment,
  actorUserId?: string,
): TemplateAssignmentInsert {
  return {
    assignedAt: new Date(assignment.assignedAt),
    assignedByUserId: actorUserId ?? null,
    id: uuidFromDomainId(assignment.id),
    metadata: {
      history: assignment.history,
    },
    targetId: assignment.targetId,
    targetType: assignment.targetType,
    templateId: assignment.templateId,
    templateKind: "channel_map",
  };
}

export function channelMapAssignmentFromRow(
  row: TemplateAssignmentRow,
): ChannelMapTemplateAssignment {
  const metadata = record(row.metadata) ?? {};

  return channelMapTemplateAssignmentSchema.parse({
    assignedAt: row.assignedAt.toISOString(),
    history: Array.isArray(metadata.history) ? metadata.history : [],
    id: row.id,
    targetId: row.targetId,
    targetType: row.targetType,
    templateId: row.templateId,
  });
}

export function latestPreviousTemplateId(assignment: ChannelMapTemplateAssignment | undefined) {
  return [...(assignment?.history ?? [])].reverse().find((event) => event.previousTemplateId)
    ?.previousTemplateId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveIntegerOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uuidFromDomainId(value: string) {
  const prefix = "assignment_";

  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
