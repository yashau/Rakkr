import { randomBytes } from "node:crypto";

import {
  accessGroups,
  accessPolicies as accessPolicyRows,
  and,
  count,
  createDatabase,
  eq,
  userAccessGroups,
} from "@rakkr/db";
import { accessGroupSlug } from "@rakkr/shared";
import type {
  AccessGroup,
  AccessGroupCreateRequest,
  AccessGroupDetail,
  AccessGroupMember,
  AccessGroupSummary,
  AccessGroupUpdateRequest,
  AccessPolicyInput,
  CurrentUser,
} from "@rakkr/shared";

import { AuthError } from "./auth-errors.js";
import { localGroupsFromEnv } from "./auth-utils.js";

type Database = ReturnType<typeof createDatabase>;
type GroupMeta = {
  createdAt: string;
  description?: string;
  id: string;
  name: string;
  updatedAt: string;
};

// Dependencies the group manager borrows from LocalAuthService. The service owns
// shared state (session refresh, the group-override cache used by user access, and
// the access-policy override cache); the manager owns the in-memory group registry.
export interface GroupManagerDeps {
  availableDatabase(): Database | undefined;
  getAccessPolicyOverrides(): AccessPolicyInput[] | undefined;
  localGroupOverrides: Map<string, AccessGroup[]>;
  localUser(userId: string): Promise<CurrentUser | undefined>;
  localUsers(): Promise<CurrentUser[]>;
  markDatabaseUnavailable(error: unknown): void;
  refreshUserSessions(user: CurrentUser): void;
  setAccessPolicyOverrides(policies: AccessPolicyInput[]): void;
}

// First-party access-group management. In DB mode `access_groups`/`user_access_groups`
// are the source of truth; without a DB (tests, degraded mode) an in-memory registry
// plus the service's per-user override map stand in. Group roster entries are
// evaluated dynamically, so membership changes only refresh sessions.
export class LocalGroupManager {
  private readonly registry = new Map<string, GroupMeta>();

  constructor(private readonly deps: GroupManagerDeps) {}

  async localGroups(): Promise<AccessGroupSummary[]> {
    const db = this.deps.availableDatabase();

    if (db) {
      try {
        const rows = await db
          .select({
            createdAt: accessGroups.createdAt,
            description: accessGroups.description,
            id: accessGroups.id,
            name: accessGroups.name,
            updatedAt: accessGroups.updatedAt,
          })
          .from(accessGroups);

        if (rows.length > 0) {
          const counts = await db
            .select({ groupId: userAccessGroups.groupId, value: count() })
            .from(userAccessGroups)
            .groupBy(userAccessGroups.groupId);
          const countById = new Map(counts.map((row) => [row.groupId, Number(row.value)]));

          return rows.map((row) => ({
            createdAt: row.createdAt?.toISOString(),
            description: row.description ?? undefined,
            id: row.id,
            memberCount: countById.get(row.id) ?? 0,
            name: row.name,
            updatedAt: row.updatedAt?.toISOString(),
          }));
        }
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }

    return this.memoryGroupSummaries();
  }

  async group(id: string): Promise<AccessGroupDetail | undefined> {
    const summary = (await this.localGroups()).find((group) => group.id === id);

    if (!summary) {
      return undefined;
    }

    const members = await this.groupMembers(id);

    return { ...summary, memberCount: members.length, members };
  }

  async groupMembers(id: string): Promise<AccessGroupMember[]> {
    const memberIds = new Set(await this.groupMemberIds(id));

    if (memberIds.size === 0) {
      return [];
    }

    return (await this.deps.localUsers())
      .filter((user) => memberIds.has(user.id))
      .map((user) => ({ email: user.email, id: user.id, name: user.name }));
  }

  async createGroup(input: AccessGroupCreateRequest): Promise<AccessGroupDetail> {
    const id = await this.nextAvailableGroupId(input.name);
    const db = this.deps.availableDatabase();

    if (db) {
      try {
        await db
          .insert(accessGroups)
          .values({ description: input.description ?? null, id, name: input.name });
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
        throw new AuthError("Group storage is unavailable", "database_unavailable");
      }
    } else {
      const now = new Date().toISOString();

      this.registry.set(id, {
        createdAt: now,
        description: input.description,
        id,
        name: input.name,
        updatedAt: now,
      });
    }

    await this.applyMembership(id, input.name, input.memberIds);

    const detail = await this.group(id);

    if (!detail) {
      throw new AuthError("Group storage is unavailable", "database_unavailable");
    }

    return detail;
  }

  async updateGroup(
    id: string,
    input: AccessGroupUpdateRequest,
  ): Promise<AccessGroupDetail | undefined> {
    const existing = await this.group(id);

    if (!existing) {
      return undefined;
    }

    const db = this.deps.availableDatabase();

    if (db) {
      const updates: { description?: string | null; name?: string; updatedAt: Date } = {
        updatedAt: new Date(),
      };

      if (input.name !== undefined) {
        updates.name = input.name;
      }

      if (input.description !== undefined) {
        updates.description = input.description;
      }

      try {
        await db.update(accessGroups).set(updates).where(eq(accessGroups.id, id));
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
        throw new AuthError("Group storage is unavailable", "database_unavailable");
      }
    } else {
      const meta = this.registry.get(id);

      if (meta) {
        if (input.name !== undefined) {
          meta.name = input.name;
        }

        if (input.description !== undefined) {
          meta.description = input.description ?? undefined;
        }

        meta.updatedAt = new Date().toISOString();
      }
    }

    if (input.name !== undefined && input.name !== existing.name) {
      this.renameGroupInOverrides(id, input.name);
    }

    await this.refreshGroupMemberSessions(id);

    return this.group(id);
  }

  async setGroupMembers(id: string, userIds: string[]): Promise<AccessGroupDetail | undefined> {
    const existing = await this.group(id);

    if (!existing) {
      return undefined;
    }

    await this.applyMembership(id, existing.name, userIds);

    return this.group(id);
  }

  async deleteGroup(id: string): Promise<{ id: string; name: string } | undefined> {
    const existing = await this.group(id);

    if (!existing) {
      return undefined;
    }

    // Clear membership first (refreshes affected sessions + drops the override cache),
    // then strip group access policies, then remove the group row itself. Roster and
    // schedule cleanup are orchestrated by the route via injected callbacks.
    await this.applyMembership(id, existing.name, []);
    await this.removeGroupAccessPolicies(id);

    const db = this.deps.availableDatabase();

    if (db) {
      try {
        await db.delete(accessGroups).where(eq(accessGroups.id, id));
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }

    this.registry.delete(id);

    return { id: existing.id, name: existing.name };
  }

  private memoryGroupSummaries(): AccessGroupSummary[] {
    const byId = new Map<string, AccessGroupSummary>();

    for (const meta of this.registry.values()) {
      byId.set(meta.id, {
        createdAt: meta.createdAt,
        description: meta.description,
        id: meta.id,
        memberCount: 0,
        name: meta.name,
        updatedAt: meta.updatedAt,
      });
    }

    for (const group of localGroupsFromEnv()) {
      if (!byId.has(group.id)) {
        byId.set(group.id, { id: group.id, memberCount: 0, name: group.name });
      }
    }

    for (const groups of this.deps.localGroupOverrides.values()) {
      for (const group of groups) {
        const existing = byId.get(group.id);

        if (existing) {
          existing.memberCount += 1;
        } else {
          byId.set(group.id, { id: group.id, memberCount: 1, name: group.name });
        }
      }
    }

    return [...byId.values()];
  }

  private async groupMemberIds(groupId: string): Promise<string[]> {
    const db = this.deps.availableDatabase();

    if (db) {
      try {
        const rows = await db
          .select({ userId: userAccessGroups.userId })
          .from(userAccessGroups)
          .where(eq(userAccessGroups.groupId, groupId));

        return rows.map((row) => row.userId);
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }

    const ids: string[] = [];

    for (const [userId, groups] of this.deps.localGroupOverrides) {
      if (groups.some((group) => group.id === groupId)) {
        ids.push(userId);
      }
    }

    return ids;
  }

  // Replace a group's membership and keep sessions + the override cache consistent.
  // In no-DB mode the override map is authoritative; in DB mode it is a write-through
  // cache, so only existing cache entries are updated (others read fresh from the DB).
  private async applyMembership(groupId: string, groupName: string, nextUserIds: string[]) {
    const knownUserIds = new Set((await this.deps.localUsers()).map((user) => user.id));
    const next = [...new Set(nextUserIds)].filter((userId) => knownUserIds.has(userId));
    const nextSet = new Set(next);
    const previous = await this.groupMemberIds(groupId);
    const db = this.deps.availableDatabase();

    if (db) {
      try {
        await db.delete(userAccessGroups).where(eq(userAccessGroups.groupId, groupId));

        if (next.length > 0) {
          await db
            .insert(userAccessGroups)
            .values(next.map((userId) => ({ groupId, userId })))
            .onConflictDoNothing();
        }
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
        throw new AuthError("Group membership storage is unavailable", "database_unavailable");
      }
    }

    const affected = new Set([...previous, ...next]);

    for (const userId of affected) {
      const existing = this.deps.localGroupOverrides.get(userId);

      if (!existing && db) {
        continue;
      }

      const groups = (existing ?? []).filter((group) => group.id !== groupId);

      if (nextSet.has(userId)) {
        groups.push({ id: groupId, name: groupName });
      }

      this.deps.localGroupOverrides.set(userId, groups);
    }

    for (const userId of affected) {
      const user = await this.deps.localUser(userId);

      if (user) {
        this.deps.refreshUserSessions(user);
      }
    }
  }

  private renameGroupInOverrides(groupId: string, name: string) {
    for (const [userId, groups] of this.deps.localGroupOverrides) {
      if (groups.some((group) => group.id === groupId)) {
        this.deps.localGroupOverrides.set(
          userId,
          groups.map((group) => (group.id === groupId ? { id: group.id, name } : group)),
        );
      }
    }
  }

  private async refreshGroupMemberSessions(groupId: string) {
    for (const userId of await this.groupMemberIds(groupId)) {
      const user = await this.deps.localUser(userId);

      if (user) {
        this.deps.refreshUserSessions(user);
      }
    }
  }

  private async removeGroupAccessPolicies(groupId: string) {
    const overrides = this.deps.getAccessPolicyOverrides();

    if (overrides) {
      this.deps.setAccessPolicyOverrides(
        overrides.filter(
          (policy) => !(policy.subjectType === "group" && policy.subjectId === groupId),
        ),
      );
    }

    const db = this.deps.availableDatabase();

    if (db) {
      try {
        await db
          .delete(accessPolicyRows)
          .where(
            and(eq(accessPolicyRows.subjectType, "group"), eq(accessPolicyRows.subjectId, groupId)),
          );
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }
  }

  private async nextAvailableGroupId(name: string): Promise<string> {
    const base = accessGroupSlug(name) || `group-${randomBytes(3).toString("hex")}`;
    const existing = await this.existingGroupIds();

    if (!existing.has(base)) {
      return base;
    }

    for (let attempt = 2; attempt < 10_000; attempt += 1) {
      const suffix = `-${attempt}`;
      const candidate = `${base.slice(0, 120 - suffix.length)}${suffix}`;

      if (!existing.has(candidate)) {
        return candidate;
      }
    }

    return `group-${randomBytes(6).toString("hex")}`;
  }

  private async existingGroupIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const db = this.deps.availableDatabase();

    if (db) {
      try {
        const rows = await db.select({ id: accessGroups.id }).from(accessGroups);

        for (const row of rows) {
          ids.add(row.id);
        }
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }

    for (const id of this.registry.keys()) {
      ids.add(id);
    }

    for (const group of localGroupsFromEnv()) {
      ids.add(group.id);
    }

    for (const groups of this.deps.localGroupOverrides.values()) {
      for (const group of groups) {
        ids.add(group.id);
      }
    }

    return ids;
  }
}
