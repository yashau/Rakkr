import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  channelMapTemplates as channelMapTemplatesTable,
  createDatabase,
  desc,
  eq,
  recordingProfiles as recordingProfilesTable,
  templateAssignments as templateAssignmentsTable,
  watchdogPolicies as watchdogPoliciesTable,
} from "@rakkr/db";
import {
  channelMapTemplateAssignmentSchema,
  channelMapTemplateSchema,
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  recordingProfileSchema,
  watchdogPolicySchema,
  type ChannelMapTemplate,
  type ChannelMapTemplateAssignment,
  type ChannelMapTemplateAssignmentInput,
  type ChannelMapTemplateInput,
  type ChannelMapTemplateUpdate,
  type RecordingProfile,
  type RecordingProfileUpdate,
  type WatchdogPolicy,
  type WatchdogPolicyUpdate,
} from "@rakkr/shared";

type RecordingProfileInsert = typeof recordingProfilesTable.$inferInsert;
type RecordingProfileRow = typeof recordingProfilesTable.$inferSelect;
type ChannelMapTemplateInsert = typeof channelMapTemplatesTable.$inferInsert;
type ChannelMapTemplateRow = typeof channelMapTemplatesTable.$inferSelect;
type TemplateAssignmentInsert = typeof templateAssignmentsTable.$inferInsert;
type TemplateAssignmentRow = typeof templateAssignmentsTable.$inferSelect;
type WatchdogPolicyInsert = typeof watchdogPoliciesTable.$inferInsert;
type WatchdogPolicyRow = typeof watchdogPoliciesTable.$inferSelect;

export interface SettingsStore {
  assignChannelMapTemplate(
    input: ChannelMapTemplateAssignmentInput,
    actorUserId?: string,
  ): Promise<ChannelMapTemplateAssignment>;
  createChannelMapTemplate(input: ChannelMapTemplateInput): Promise<ChannelMapTemplate>;
  findChannelMapTemplate(templateId: string): Promise<ChannelMapTemplate | undefined>;
  findRecordingProfile(profileId: string): Promise<RecordingProfile | undefined>;
  findWatchdogPolicy(policyId: string): Promise<WatchdogPolicy | undefined>;
  listChannelMapAssignments(): Promise<ChannelMapTemplateAssignment[]>;
  listChannelMapTemplates(): Promise<ChannelMapTemplate[]>;
  listRecordingProfiles(): Promise<RecordingProfile[]>;
  listWatchdogPolicies(): Promise<WatchdogPolicy[]>;
  updateChannelMapTemplate(
    templateId: string,
    update: ChannelMapTemplateUpdate,
  ): Promise<ChannelMapTemplate | undefined>;
  updateRecordingProfile(
    profileId: string,
    update: RecordingProfileUpdate,
  ): Promise<RecordingProfile | undefined>;
  updateWatchdogPolicy(
    policyId: string,
    update: WatchdogPolicyUpdate,
  ): Promise<WatchdogPolicy | undefined>;
}

const recordingProfileStorePath = path.resolve(
  process.env.RAKKR_RECORDING_PROFILE_STORE_PATH ?? "data/recording-profiles.json",
);
const watchdogPolicyStorePath = path.resolve(
  process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH ?? "data/watchdog-policies.json",
);
const channelMapStorePath = path.resolve(
  process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH ?? "data/channel-map-templates.json",
);
const channelMapAssignmentStorePath = path.resolve(
  process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH ?? "data/channel-map-assignments.json",
);

export function createSettingsStore(
  seedProfiles: RecordingProfile[] = [defaultVoiceRecordingProfile],
  seedWatchdogPolicies: WatchdogPolicy[] = [defaultScheduledVoiceWatchdogPolicy],
) {
  const fallback = new JsonSettingsStore(seedProfiles, seedWatchdogPolicies);
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl
    ? new PostgresSettingsStore(databaseUrl, fallback, seedProfiles, seedWatchdogPolicies)
    : fallback;
}

class JsonSettingsStore implements SettingsStore {
  private readonly channelMapAssignments: ChannelMapTemplateAssignment[];
  private readonly channelMapTemplates: ChannelMapTemplate[];
  private readonly profiles: RecordingProfile[];
  private readonly watchdogPolicies: WatchdogPolicy[];

  constructor(seedProfiles: RecordingProfile[], seedWatchdogPolicies: WatchdogPolicy[]) {
    this.channelMapAssignments = loadChannelMapAssignments();
    this.channelMapTemplates = loadChannelMapTemplates();
    this.profiles = loadRecordingProfiles(seedProfiles);
    this.watchdogPolicies = loadWatchdogPolicies(seedWatchdogPolicies);
  }

  async createChannelMapTemplate(input: ChannelMapTemplateInput) {
    const template = channelMapTemplateFromInput(input);
    const index = this.channelMapTemplates.findIndex((candidate) => candidate.id === template.id);

    if (index >= 0) {
      this.channelMapTemplates[index] = template;
    } else {
      this.channelMapTemplates.unshift(template);
    }

    persistSettings(channelMapStorePath, "templates", this.channelMapTemplates);

    return template;
  }

  async findChannelMapTemplate(templateId: string) {
    return this.channelMapTemplates.find((template) => template.id === templateId);
  }

  async listChannelMapTemplates() {
    return this.channelMapTemplates;
  }

  async updateChannelMapTemplate(templateId: string, update: ChannelMapTemplateUpdate) {
    const index = this.channelMapTemplates.findIndex((template) => template.id === templateId);

    if (index < 0) {
      return undefined;
    }

    const updated = { ...this.channelMapTemplates[index], ...update, id: templateId };
    this.channelMapTemplates[index] = updated;
    persistSettings(channelMapStorePath, "templates", this.channelMapTemplates);

    return updated;
  }

  async listChannelMapAssignments() {
    return this.channelMapAssignments;
  }

  async assignChannelMapTemplate(input: ChannelMapTemplateAssignmentInput) {
    const existingIndex = this.channelMapAssignments.findIndex(
      (assignment) =>
        assignment.targetType === input.targetType && assignment.targetId === input.targetId,
    );
    const assignment = channelMapAssignmentFromInput(
      input,
      existingIndex >= 0 ? this.channelMapAssignments[existingIndex]?.id : undefined,
    );

    if (existingIndex >= 0) {
      this.channelMapAssignments[existingIndex] = assignment;
    } else {
      this.channelMapAssignments.unshift(assignment);
    }

    persistSettings(channelMapAssignmentStorePath, "assignments", this.channelMapAssignments);

    return assignment;
  }

  async findRecordingProfile(profileId: string) {
    return this.profiles.find((profile) => profile.id === profileId);
  }

  async listRecordingProfiles() {
    return this.profiles;
  }

  async findWatchdogPolicy(policyId: string) {
    return this.watchdogPolicies.find((policy) => policy.id === policyId);
  }

  async listWatchdogPolicies() {
    return this.watchdogPolicies;
  }

  async updateRecordingProfile(profileId: string, update: RecordingProfileUpdate) {
    const index = this.profiles.findIndex((profile) => profile.id === profileId);

    if (index < 0) {
      return undefined;
    }

    const updated = { ...this.profiles[index], ...update, id: profileId };
    this.profiles[index] = updated;
    persistSettings(recordingProfileStorePath, "profiles", this.profiles);

    return updated;
  }

  async updateWatchdogPolicy(policyId: string, update: WatchdogPolicyUpdate) {
    const index = this.watchdogPolicies.findIndex((policy) => policy.id === policyId);

    if (index < 0) {
      return undefined;
    }

    const updated = { ...this.watchdogPolicies[index], ...update, id: policyId };
    this.watchdogPolicies[index] = updated;
    persistSettings(watchdogPolicyStorePath, "policies", this.watchdogPolicies);

    return updated;
  }
}

class PostgresSettingsStore implements SettingsStore {
  private dbAvailable = true;
  private hasSeededProfiles = false;
  private hasSeededWatchdogPolicies = false;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: SettingsStore,
    private readonly seedProfiles: RecordingProfile[],
    private readonly seedWatchdogPolicies: WatchdogPolicy[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async createChannelMapTemplate(input: ChannelMapTemplateInput) {
    if (!this.dbAvailable) {
      return this.fallback.createChannelMapTemplate(input);
    }

    try {
      const template = channelMapTemplateFromInput(input);
      await this.writeChannelMapTemplate(template);

      return template;
    } catch (error) {
      await this.failover("channel map template persistence unavailable; using JSON store", error);
      return this.fallback.createChannelMapTemplate(input);
    }
  }

  async findChannelMapTemplate(templateId: string) {
    if (!this.dbAvailable) {
      return this.fallback.findChannelMapTemplate(templateId);
    }

    try {
      const [row] = await this.db
        .select()
        .from(channelMapTemplatesTable)
        .where(eq(channelMapTemplatesTable.id, templateId))
        .limit(1);

      return row ? channelMapTemplateFromRow(row) : undefined;
    } catch (error) {
      await this.failover("channel map template lookup unavailable; using JSON store", error);
      return this.fallback.findChannelMapTemplate(templateId);
    }
  }

  async listChannelMapTemplates() {
    if (!this.dbAvailable) {
      return this.fallback.listChannelMapTemplates();
    }

    try {
      const rows = await this.db
        .select()
        .from(channelMapTemplatesTable)
        .orderBy(desc(channelMapTemplatesTable.createdAt));

      return rows.map(channelMapTemplateFromRow);
    } catch (error) {
      await this.failover("channel map template query unavailable; using JSON store", error);
      return this.fallback.listChannelMapTemplates();
    }
  }

  async updateChannelMapTemplate(templateId: string, update: ChannelMapTemplateUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.updateChannelMapTemplate(templateId, update);
    }

    try {
      const existing = await this.findChannelMapTemplate(templateId);

      if (!existing) {
        return undefined;
      }

      const updated = { ...existing, ...update, id: templateId };
      await this.writeChannelMapTemplate(updated);

      return updated;
    } catch (error) {
      await this.failover("channel map template update unavailable; using JSON store", error);
      return this.fallback.updateChannelMapTemplate(templateId, update);
    }
  }

  async listChannelMapAssignments() {
    if (!this.dbAvailable) {
      return this.fallback.listChannelMapAssignments();
    }

    try {
      const rows = await this.db
        .select()
        .from(templateAssignmentsTable)
        .where(eq(templateAssignmentsTable.templateKind, "channel_map"))
        .orderBy(desc(templateAssignmentsTable.assignedAt));

      return rows.map(channelMapAssignmentFromRow);
    } catch (error) {
      await this.failover("channel map assignment query unavailable; using JSON store", error);
      return this.fallback.listChannelMapAssignments();
    }
  }

  async assignChannelMapTemplate(input: ChannelMapTemplateAssignmentInput, actorUserId?: string) {
    if (!this.dbAvailable) {
      return this.fallback.assignChannelMapTemplate(input, actorUserId);
    }

    try {
      const existing = (await this.listChannelMapAssignments()).find(
        (assignment) =>
          assignment.targetType === input.targetType && assignment.targetId === input.targetId,
      );
      const assignment = channelMapAssignmentFromInput(input, existing?.id);
      const row = channelMapAssignmentToRow(assignment, actorUserId);

      if (existing) {
        await this.db
          .update(templateAssignmentsTable)
          .set({
            assignedAt: row.assignedAt,
            assignedByUserId: row.assignedByUserId,
            targetId: row.targetId,
            targetType: row.targetType,
            templateId: row.templateId,
            templateKind: row.templateKind,
          })
          .where(eq(templateAssignmentsTable.id, existing.id));
      } else {
        await this.db.insert(templateAssignmentsTable).values(row);
      }

      return assignment;
    } catch (error) {
      await this.failover("channel map assignment unavailable; using JSON store", error);
      return this.fallback.assignChannelMapTemplate(input, actorUserId);
    }
  }

  async findRecordingProfile(profileId: string) {
    if (!this.dbAvailable) {
      return this.fallback.findRecordingProfile(profileId);
    }

    try {
      await this.seedProfilesIfEmpty();
      const [row] = await this.db
        .select()
        .from(recordingProfilesTable)
        .where(eq(recordingProfilesTable.id, profileId))
        .limit(1);

      return row ? recordingProfileFromRow(row) : undefined;
    } catch (error) {
      await this.failover("recording profile lookup unavailable; using JSON store", error);
      return this.fallback.findRecordingProfile(profileId);
    }
  }

  async findWatchdogPolicy(policyId: string) {
    if (!this.dbAvailable) {
      return this.fallback.findWatchdogPolicy(policyId);
    }

    try {
      await this.seedWatchdogPoliciesIfEmpty();
      const [row] = await this.db
        .select()
        .from(watchdogPoliciesTable)
        .where(eq(watchdogPoliciesTable.id, policyId))
        .limit(1);

      return row ? watchdogPolicyFromRow(row) : undefined;
    } catch (error) {
      await this.failover("watchdog policy lookup unavailable; using JSON store", error);
      return this.fallback.findWatchdogPolicy(policyId);
    }
  }

  async listRecordingProfiles() {
    if (!this.dbAvailable) {
      return this.fallback.listRecordingProfiles();
    }

    try {
      await this.seedProfilesIfEmpty();
      const rows = await this.db
        .select()
        .from(recordingProfilesTable)
        .orderBy(desc(recordingProfilesTable.createdAt));

      return rows.map(recordingProfileFromRow);
    } catch (error) {
      await this.failover("recording profile query unavailable; using JSON store", error);
      return this.fallback.listRecordingProfiles();
    }
  }

  async listWatchdogPolicies() {
    if (!this.dbAvailable) {
      return this.fallback.listWatchdogPolicies();
    }

    try {
      await this.seedWatchdogPoliciesIfEmpty();
      const rows = await this.db
        .select()
        .from(watchdogPoliciesTable)
        .orderBy(desc(watchdogPoliciesTable.createdAt));

      return rows.map(watchdogPolicyFromRow);
    } catch (error) {
      await this.failover("watchdog policy query unavailable; using JSON store", error);
      return this.fallback.listWatchdogPolicies();
    }
  }

  async updateRecordingProfile(profileId: string, update: RecordingProfileUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.updateRecordingProfile(profileId, update);
    }

    try {
      await this.seedProfilesIfEmpty();
      const existing = await this.findRecordingProfile(profileId);

      if (!existing) {
        return undefined;
      }

      const updated = { ...existing, ...update, id: profileId };
      await this.writeRecordingProfile(updated);

      return updated;
    } catch (error) {
      await this.failover("recording profile update unavailable; using JSON store", error);
      return this.fallback.updateRecordingProfile(profileId, update);
    }
  }

  async updateWatchdogPolicy(policyId: string, update: WatchdogPolicyUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.updateWatchdogPolicy(policyId, update);
    }

    try {
      await this.seedWatchdogPoliciesIfEmpty();
      const existing = await this.findWatchdogPolicy(policyId);

      if (!existing) {
        return undefined;
      }

      const updated = { ...existing, ...update, id: policyId };
      await this.writeWatchdogPolicy(updated);

      return updated;
    } catch (error) {
      await this.failover("watchdog policy update unavailable; using JSON store", error);
      return this.fallback.updateWatchdogPolicy(policyId, update);
    }
  }

  private async seedProfilesIfEmpty() {
    if (this.hasSeededProfiles || this.seedProfiles.length === 0 || demoSeedDisabled()) {
      return;
    }

    const existing = await this.db
      .select({ id: recordingProfilesTable.id })
      .from(recordingProfilesTable)
      .limit(1);

    if (existing.length === 0) {
      await Promise.all(this.seedProfiles.map((profile) => this.writeRecordingProfile(profile)));
    }

    this.hasSeededProfiles = true;
  }

  private async seedWatchdogPoliciesIfEmpty() {
    if (
      this.hasSeededWatchdogPolicies ||
      this.seedWatchdogPolicies.length === 0 ||
      demoSeedDisabled()
    ) {
      return;
    }

    const existing = await this.db
      .select({ id: watchdogPoliciesTable.id })
      .from(watchdogPoliciesTable)
      .limit(1);

    if (existing.length === 0) {
      await Promise.all(
        this.seedWatchdogPolicies.map((policy) => this.writeWatchdogPolicy(policy)),
      );
    }

    this.hasSeededWatchdogPolicies = true;
  }

  private async writeRecordingProfile(profile: RecordingProfile) {
    const row = recordingProfileToRow(profile);

    await this.db
      .insert(recordingProfilesTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          bitrateKbps: row.bitrateKbps,
          channelMode: row.channelMode,
          codec: row.codec,
          name: row.name,
          settings: row.settings,
          silenceDetectionEnabled: row.silenceDetectionEnabled,
          silenceSkipEnabled: row.silenceSkipEnabled,
          vbr: row.vbr,
        },
        target: recordingProfilesTable.id,
      });
  }

  private async writeChannelMapTemplate(template: ChannelMapTemplate) {
    const row = channelMapTemplateToRow(template);

    await this.db
      .insert(channelMapTemplatesTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          channelMode: row.channelMode,
          entries: row.entries,
          name: row.name,
          tags: row.tags,
          updatedAt: new Date(),
        },
        target: channelMapTemplatesTable.id,
      });
  }

  private async writeWatchdogPolicy(policy: WatchdogPolicy) {
    const row = watchdogPolicyToRow(policy);

    await this.db
      .insert(watchdogPoliciesTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          name: row.name,
          rules: row.rules,
        },
        target: watchdogPoliciesTable.id,
      });
  }

  private async failover(message: string, error: unknown) {
    this.dbAvailable = false;
    console.warn(message, error);
  }
}

function loadRecordingProfiles(seedProfiles: RecordingProfile[]) {
  if (!existsSync(recordingProfileStorePath)) {
    return seedProfiles.map((profile) => ({ ...profile }));
  }

  const raw = readFileSync(recordingProfileStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const profiles = isRecordingProfileStore(parsed) ? parsed.profiles : parsed;

  if (!Array.isArray(profiles)) {
    throw new Error("recording_profile_store_invalid");
  }

  return profiles.map((profile) => recordingProfileSchema.parse(profile));
}

function loadWatchdogPolicies(seedPolicies: WatchdogPolicy[]) {
  if (!existsSync(watchdogPolicyStorePath)) {
    return seedPolicies.map((policy) => ({ ...policy }));
  }

  const raw = readFileSync(watchdogPolicyStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const policies = isWatchdogPolicyStore(parsed) ? parsed.policies : parsed;

  if (!Array.isArray(policies)) {
    throw new Error("watchdog_policy_store_invalid");
  }

  return policies.map((policy) => watchdogPolicySchema.parse(policy));
}

function loadChannelMapTemplates() {
  if (!existsSync(channelMapStorePath)) {
    return [];
  }

  const raw = readFileSync(channelMapStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const templates = isChannelMapTemplateStore(parsed) ? parsed.templates : parsed;

  if (!Array.isArray(templates)) {
    throw new Error("channel_map_template_store_invalid");
  }

  return templates.map((template) => channelMapTemplateSchema.parse(template));
}

function loadChannelMapAssignments() {
  if (!existsSync(channelMapAssignmentStorePath)) {
    return [];
  }

  const raw = readFileSync(channelMapAssignmentStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const assignments = isChannelMapAssignmentStore(parsed) ? parsed.assignments : parsed;

  if (!Array.isArray(assignments)) {
    throw new Error("channel_map_assignment_store_invalid");
  }

  return assignments.map((assignment) => channelMapTemplateAssignmentSchema.parse(assignment));
}

function persistSettings<T>(filePath: string, key: string, values: T[]) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = JSON.stringify(
    {
      [key]: values,
      updatedAt: new Date().toISOString(),
      version: 1,
    },
    null,
    2,
  );

  writeFileSync(tempPath, `${payload}\n`);
  renameSync(tempPath, filePath);
}

function channelMapTemplateFromInput(input: ChannelMapTemplateInput): ChannelMapTemplate {
  return channelMapTemplateSchema.parse({
    channelMode: input.channelMode,
    entries: input.entries,
    id: input.id ?? `channel_map_${randomUUID()}`,
    name: input.name,
    tags: input.tags,
  });
}

function channelMapTemplateToRow(template: ChannelMapTemplate): ChannelMapTemplateInsert {
  return {
    channelMode: template.channelMode,
    entries: template.entries,
    id: template.id,
    name: template.name,
    tags: template.tags,
    updatedAt: new Date(),
  };
}

function channelMapTemplateFromRow(row: ChannelMapTemplateRow): ChannelMapTemplate {
  return channelMapTemplateSchema.parse({
    channelMode: row.channelMode,
    entries: row.entries,
    id: row.id,
    name: row.name,
    tags: row.tags,
  });
}

function channelMapAssignmentFromInput(
  input: ChannelMapTemplateAssignmentInput,
  existingId?: string,
): ChannelMapTemplateAssignment {
  return channelMapTemplateAssignmentSchema.parse({
    assignedAt: new Date().toISOString(),
    id: existingId ?? `assignment_${randomUUID()}`,
    targetId: input.targetId,
    targetType: input.targetType,
    templateId: input.templateId,
  });
}

function channelMapAssignmentToRow(
  assignment: ChannelMapTemplateAssignment,
  actorUserId?: string,
): TemplateAssignmentInsert {
  return {
    assignedAt: new Date(assignment.assignedAt),
    assignedByUserId: actorUserId ?? null,
    id: uuidFromDomainId(assignment.id),
    metadata: {},
    targetId: assignment.targetId,
    targetType: assignment.targetType,
    templateId: assignment.templateId,
    templateKind: "channel_map",
  };
}

function channelMapAssignmentFromRow(row: TemplateAssignmentRow): ChannelMapTemplateAssignment {
  return channelMapTemplateAssignmentSchema.parse({
    assignedAt: row.assignedAt.toISOString(),
    id: row.id,
    targetId: row.targetId,
    targetType: row.targetType,
    templateId: row.templateId,
  });
}

function recordingProfileToRow(profile: RecordingProfile): RecordingProfileInsert {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
    id: profile.id,
    name: profile.name,
    settings: {},
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}

function watchdogPolicyToRow(policy: WatchdogPolicy): WatchdogPolicyInsert {
  return {
    id: policy.id,
    name: policy.name,
    rules: {
      activeDuring: policy.activeDuring,
      graceSeconds: policy.graceSeconds,
      metric: policy.metric,
      minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
      repeatEverySeconds: policy.repeatEverySeconds,
      severity: policy.severity,
      thresholdDbfs: policy.thresholdDbfs,
      windowSeconds: policy.windowSeconds,
    },
  };
}

function recordingProfileFromRow(row: RecordingProfileRow): RecordingProfile {
  return recordingProfileSchema.parse({
    bitrateKbps: row.bitrateKbps,
    channelMode: row.channelMode,
    codec: row.codec,
    id: row.id,
    name: row.name,
    silenceDetectionEnabled: row.silenceDetectionEnabled,
    silenceSkipEnabled: row.silenceSkipEnabled,
    vbr: row.vbr,
  });
}

function watchdogPolicyFromRow(row: WatchdogPolicyRow): WatchdogPolicy {
  const rules = record(row.rules) ?? {};

  return watchdogPolicySchema.parse({
    ...defaultScheduledVoiceWatchdogPolicy,
    ...rules,
    id: row.id,
    name: row.name,
  });
}

function isRecordingProfileStore(value: unknown): value is { profiles: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { profiles?: unknown }).profiles)
  );
}

function isWatchdogPolicyStore(value: unknown): value is { policies: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { policies?: unknown }).policies)
  );
}

function isChannelMapTemplateStore(value: unknown): value is { templates: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { templates?: unknown }).templates)
  );
}

function isChannelMapAssignmentStore(value: unknown): value is { assignments: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { assignments?: unknown }).assignments)
  );
}

function demoSeedDisabled() {
  return process.env.RAKKR_SEED_DEMO_DATA === "0";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uuidFromDomainId(value: string) {
  const prefix = "assignment_";

  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
