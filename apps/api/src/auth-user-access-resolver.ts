import {
  accessGroups,
  createDatabase,
  eq,
  userAccessGroups,
  userResourceGrants,
  userRoles,
  users,
} from "@rakkr/db";

import type { AccessGroup, LocalAccess } from "./auth-types.js";
import {
  localAdminId,
  localGroupsFromEnv,
  localResourceGrantsFromEnv,
  localRole,
  uniqueRoles,
} from "./auth-utils.js";

type Database = ReturnType<typeof createDatabase>;

// State the resolver borrows from LocalAuthService to answer "what are this user's
// effective groups / roles+grants". Precedence: per-user override cache → DB rows →
// env defaults (local admin only). Kept as functions rather than a class since they
// hold no state of their own.
export interface UserAccessResolverDeps {
  availableDatabase(): Database | undefined;
  markDatabaseUnavailable(error: unknown): void;
  groupOverrides: Map<string, AccessGroup[]>;
  accessOverrides: Map<string, LocalAccess>;
}

export async function resolveUserGroups(
  deps: UserAccessResolverDeps,
  userId: string,
): Promise<AccessGroup[]> {
  const override = deps.groupOverrides.get(userId);

  if (override) {
    return override;
  }

  const db = deps.availableDatabase();

  if (db) {
    try {
      const rows = await db
        .select({
          id: accessGroups.id,
          name: accessGroups.name,
        })
        .from(userAccessGroups)
        .innerJoin(accessGroups, eq(userAccessGroups.groupId, accessGroups.id))
        .where(eq(userAccessGroups.userId, userId));

      if (rows.length > 0) {
        return rows;
      }

      const [userRow] = await db
        .select({
          id: users.id,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (userRow) {
        return [];
      }
    } catch (error) {
      deps.markDatabaseUnavailable(error);
    }
  }

  if (userId !== localAdminId()) {
    return [];
  }

  return localGroupsFromEnv();
}

export async function resolveUserAccess(
  deps: UserAccessResolverDeps,
  userId: string,
): Promise<LocalAccess> {
  const override = deps.accessOverrides.get(userId);

  if (override) {
    return override;
  }

  const db = deps.availableDatabase();

  if (db) {
    try {
      const grantRows = await db
        .select({
          resourceId: userResourceGrants.resourceId,
          resourceType: userResourceGrants.resourceType,
        })
        .from(userResourceGrants)
        .where(eq(userResourceGrants.userId, userId));
      const roleResult = await db
        .select({
          roleId: userRoles.roleId,
        })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      if (grantRows.length > 0 || roleResult.length > 0) {
        return {
          resourceGrants: grantRows,
          roles: uniqueRoles(roleResult.map((row) => row.roleId)).length
            ? uniqueRoles(roleResult.map((row) => row.roleId))
            : [localRole()],
        };
      }
    } catch (error) {
      deps.markDatabaseUnavailable(error);
    }
  }

  return userId === localAdminId()
    ? {
        resourceGrants: localResourceGrantsFromEnv(),
        roles: [localRole()],
      }
    : {
        resourceGrants: [],
        roles: [],
      };
}
