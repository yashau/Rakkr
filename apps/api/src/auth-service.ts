import { randomBytes, timingSafeEqual, scrypt as scryptCallback } from "node:crypto";

import {
  accessGroups,
  accessPolicies as accessPolicyRows,
  and,
  authSessions,
  createDatabase,
  eq,
  gt,
  isNull,
  permissions as permissionRows,
  rolePermissions as rolePermissionRows,
  roles as roleRows,
  userResourceGrants,
  userRoles,
  userAccessGroups,
  users,
} from "@rakkr/db";
import {
  permissions,
  rolePermissions,
  roles,
  type AccessGroup,
  type AccessPolicy,
  type AccessPolicyEffect,
  type AccessPolicyInput,
  type CurrentUser,
  type ResourceGrant,
  type Role,
} from "@rakkr/shared";

import {
  accessPoliciesWithIds,
  bearerToken,
  groupsFromIds,
  hashToken,
  isPgErrorCode,
  isUuid,
  localAccessPoliciesFromEnv,
  localAdminId,
  localGroupsFromEnv,
  localResourceGrantsFromEnv,
  localRole,
  permissionName,
  permissionsForRoles,
  policyMatchesSubject,
  policyMatchesTarget,
  roleName,
  uniqueAccessPolicyInputs,
  uniqueGroups,
  uniqueResourceGrants,
  uniqueRoles,
} from "./auth-utils.js";

const passwordHashVersion = "scrypt";
const passwordKeyLength = 64;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptMaxMemory = 64 * 1024 * 1024;
const sessionTtlMs = 12 * 60 * 60 * 1000;

interface AuthSession {
  createdAt: Date;
  expiresAt: Date;
  tokenHash: string;
  user: CurrentUser;
}

export interface LocalAccess {
  groupIds?: string[];
  resourceGrants: ResourceGrant[];
  roles: Role[];
}

export interface LocalUserCreateInput extends LocalAccess {
  email: string;
  name: string;
  password: string;
}

export interface AccessPolicyDecision {
  effect: AccessPolicyEffect;
  policy: AccessPolicy;
}

export interface AuthResult {
  sessionId?: string;
  user?: CurrentUser;
}

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface LoginResult {
  expiresAt: string;
  sessionId: string;
  token: string;
  user: CurrentUser;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "database_unavailable"
      | "invalid_credentials"
      | "missing_local_password"
      | "user_exists",
  ) {
    super(message);
  }
}

export class LocalAuthService {
  private accessPolicyOverrides?: AccessPolicyInput[];
  private readonly localAccessOverrides = new Map<string, LocalAccess>();
  private readonly localGroupOverrides = new Map<string, AccessGroup[]>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly db?: ReturnType<typeof createDatabase>;
  private dbAvailable: boolean;
  private localAdminPasswordHash?: string;

  constructor(databaseUrl = process.env.DATABASE_URL) {
    this.db = databaseUrl ? createDatabase(databaseUrl) : undefined;
    this.dbAvailable = Boolean(this.db);
  }

  async login(email: string, password: string, context: SessionContext = {}): Promise<LoginResult> {
    const persistedUser = await this.localUserRecordByEmail(email);

    if (persistedUser) {
      const valid =
        Boolean(persistedUser.passwordHash) &&
        (await verifyPassword(password, persistedUser.passwordHash ?? ""));

      if (!valid) {
        throw new AuthError("Invalid credentials", "invalid_credentials");
      }

      return this.createSession(await this.currentUserFromRecord(persistedUser), context);
    }

    const user = await this.localAdmin();

    if (
      email.toLowerCase() !== user.email.toLowerCase() ||
      !(await verifyPassword(password, await this.localAdminHash()))
    ) {
      throw new AuthError("Invalid credentials", "invalid_credentials");
    }

    return this.createSession(user, context);
  }

  private async createSession(
    user: CurrentUser,
    context: SessionContext = {},
  ): Promise<LoginResult> {
    const token = `rakkr_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + sessionTtlMs);
    const session: AuthSession = {
      createdAt: new Date(),
      expiresAt,
      tokenHash,
      user,
    };

    this.sessions.set(tokenHash, session);
    await this.persistLoginSession(session, context);

    return {
      expiresAt: expiresAt.toISOString(),
      sessionId: tokenHash.slice(0, 16),
      token,
      user,
    };
  }

  async authenticate(authorizationHeader?: string): Promise<AuthResult> {
    const token = bearerToken(authorizationHeader);

    if (!token) {
      return {};
    }

    const tokenHash = hashToken(token);

    const persistedSession = await this.authenticateFromDatabase(tokenHash);

    if (persistedSession) {
      return persistedSession;
    }

    const session = this.sessions.get(tokenHash);

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(tokenHash);
      return {};
    }

    return {
      sessionId: tokenHash.slice(0, 16),
      user: session.user,
    };
  }

  async logout(authorizationHeader?: string) {
    const token = bearerToken(authorizationHeader);

    if (token) {
      const tokenHash = hashToken(token);

      this.sessions.delete(tokenHash);
      await this.revokeDatabaseSession(tokenHash);
    }
  }

  async localUsers(): Promise<CurrentUser[]> {
    const db = this.availableDatabase();

    if (!db) {
      return [await this.localAdmin()];
    }

    try {
      const rows = await db
        .select({
          email: users.email,
          id: users.id,
          name: users.name,
          passwordHash: users.passwordHash,
        })
        .from(users);
      const result: CurrentUser[] = [];

      for (const row of rows) {
        result.push(await this.currentUserFromRecord(row));
      }

      if (!result.some((user) => user.id === localAdminId())) {
        result.unshift(await this.localAdmin());
      }

      return result;
    } catch (error) {
      this.markDatabaseUnavailable(error);
      return [await this.localAdmin()];
    }
  }

  async localGroups(): Promise<AccessGroup[]> {
    const overrideGroups = [...this.localGroupOverrides.values()].flat();
    const db = this.availableDatabase();

    if (db) {
      try {
        const rows = await db
          .select({
            id: accessGroups.id,
            name: accessGroups.name,
          })
          .from(accessGroups);

        if (rows.length > 0) {
          return uniqueGroups([...rows, ...overrideGroups]);
        }
      } catch (error) {
        this.markDatabaseUnavailable(error);
      }
    }

    return uniqueGroups([...localGroupsFromEnv(), ...overrideGroups]);
  }

  async localUser(userId: string): Promise<CurrentUser | undefined> {
    const record = await this.localUserRecordById(userId);

    if (record) {
      return this.currentUserFromRecord(record);
    }

    return userId === localAdminId() ? this.localAdmin() : undefined;
  }

  async createLocalUser(input: LocalUserCreateInput): Promise<CurrentUser> {
    let db = this.availableDatabase();

    if (!db) {
      throw new AuthError("Local user storage is unavailable", "database_unavailable");
    }

    if (await this.localUserRecordByEmail(input.email)) {
      throw new AuthError("Local user already exists", "user_exists");
    }

    db = this.availableDatabase();

    if (!db) {
      throw new AuthError("Local user storage is unavailable", "database_unavailable");
    }

    let row:
      | {
          email: string;
          id: string;
          name: string;
          passwordHash: string | null;
        }
      | undefined;

    try {
      [row] = await db
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
        })
        .returning({
          email: users.email,
          id: users.id,
          name: users.name,
          passwordHash: users.passwordHash,
        });

      await this.persistLocalUserAccess(row.id, input, groupsFromIds(input.groupIds ?? []));

      return this.currentUserFromRecord(row);
    } catch (error) {
      if (isPgErrorCode(error, "23505")) {
        throw new AuthError("Local user already exists", "user_exists");
      }

      if (row) {
        await db
          .delete(users)
          .where(eq(users.id, row.id))
          .catch(() => undefined);
      }

      if (error instanceof AuthError) {
        throw error;
      }

      this.markDatabaseUnavailable(error);
      throw new AuthError("Local user storage is unavailable", "database_unavailable");
    }
  }

  async updateLocalUserAccess(
    userId: string,
    access: LocalAccess,
  ): Promise<CurrentUser | undefined> {
    const before = await this.localUser(userId);

    if (!before) {
      return undefined;
    }

    const nextAccess = {
      resourceGrants: uniqueResourceGrants(access.resourceGrants),
      roles: uniqueRoles(access.roles),
    };
    const nextGroups = groupsFromIds(access.groupIds ?? []);

    await this.persistLocalUserAccess(userId, nextAccess, nextGroups);

    this.localAccessOverrides.set(userId, nextAccess);
    this.localGroupOverrides.set(userId, nextGroups);

    const user = await this.localUser(userId);

    if (!user) {
      return undefined;
    }

    for (const session of this.sessions.values()) {
      if (session.user.id === user.id) {
        session.user = user;
      }
    }

    return user;
  }

  async accessPolicies(): Promise<AccessPolicy[]> {
    if (this.accessPolicyOverrides) {
      return accessPoliciesWithIds(this.accessPolicyOverrides);
    }

    const db = this.availableDatabase();

    if (db) {
      try {
        const rows = await db.select().from(accessPolicyRows);

        if (rows.length > 0) {
          return rows.map((row) => ({
            effect: row.effect,
            id: row.id,
            reason: row.reason ?? undefined,
            resourceId: row.resourceId,
            resourceType: row.resourceType,
            subjectId: row.subjectId ?? undefined,
            subjectType: row.subjectType,
          }));
        }
      } catch (error) {
        this.markDatabaseUnavailable(error);
      }
    }

    return localAccessPoliciesFromEnv();
  }

  async accessPolicyDecision(
    user: CurrentUser,
    targets: Array<{ id?: string; type: string }>,
  ): Promise<AccessPolicyDecision | undefined> {
    const matchingPolicies = (await this.accessPolicies()).filter(
      (policy) => policyMatchesSubject(policy, user) && policyMatchesTarget(policy, targets),
    );
    const deny = matchingPolicies.find((policy) => policy.effect === "deny");

    if (deny) {
      return { effect: "deny", policy: deny };
    }

    const allow = matchingPolicies.find((policy) => policy.effect === "allow");

    return allow ? { effect: "allow", policy: allow } : undefined;
  }

  async updateLocalAccessPolicies(
    policies: AccessPolicyInput[],
    actorUserId?: string,
  ): Promise<AccessPolicy[]> {
    const nextPolicies = uniqueAccessPolicyInputs(policies);

    this.accessPolicyOverrides = nextPolicies;

    const db = this.availableDatabase();

    if (db) {
      try {
        await db.delete(accessPolicyRows);

        if (nextPolicies.length > 0) {
          await db.insert(accessPolicyRows).values(
            nextPolicies.map((policy) => ({
              createdByUserId: actorUserId && isUuid(actorUserId) ? actorUserId : undefined,
              effect: policy.effect,
              reason: policy.reason,
              resourceId: policy.resourceId,
              resourceType: policy.resourceType,
              subjectId: policy.subjectId,
              subjectType: policy.subjectType,
            })),
          );
        }
      } catch (error) {
        this.markDatabaseUnavailable(error);
      }
    }

    return accessPoliciesWithIds(nextPolicies);
  }

  async localAdmin(): Promise<CurrentUser> {
    const userId = localAdminId();
    const access = await this.localAccessForUser(userId);

    return {
      email: process.env.RAKKR_LOCAL_ADMIN_EMAIL ?? "admin@rakkr.local",
      groups: await this.localGroupsForUser(userId),
      id: userId,
      name: process.env.RAKKR_LOCAL_ADMIN_NAME ?? "Local Admin",
      permissions: permissionsForRoles(access.roles),
      provider: "local",
      resourceGrants: access.resourceGrants,
      roles: access.roles,
    };
  }

  private async localAdminHash() {
    if (!this.localAdminPasswordHash) {
      const password = process.env.RAKKR_LOCAL_ADMIN_PASSWORD ?? defaultLocalPassword();
      this.localAdminPasswordHash = await hashPassword(password);
    }

    return this.localAdminPasswordHash;
  }

  private async localUserRecordByEmail(email: string) {
    const db = this.availableDatabase();

    if (!db) {
      return undefined;
    }

    try {
      const [row] = await db
        .select({
          email: users.email,
          id: users.id,
          name: users.name,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      return row;
    } catch (error) {
      this.markDatabaseUnavailable(error);
      return undefined;
    }
  }

  private async localUserRecordById(userId: string) {
    const db = this.availableDatabase();

    if (!db || !isUuid(userId)) {
      return undefined;
    }

    try {
      const [row] = await db
        .select({
          email: users.email,
          id: users.id,
          name: users.name,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      return row;
    } catch (error) {
      this.markDatabaseUnavailable(error);
      return undefined;
    }
  }

  private async currentUserFromRecord(record: {
    email: string;
    id: string;
    name: string;
    passwordHash: string | null;
  }): Promise<CurrentUser> {
    const access = await this.localAccessForUser(record.id);

    return {
      email: record.email,
      groups: await this.localGroupsForUser(record.id),
      id: record.id,
      name: record.name,
      permissions: permissionsForRoles(access.roles),
      provider: "local",
      resourceGrants: access.resourceGrants,
      roles: access.roles,
    };
  }

  private async persistLoginSession(session: AuthSession, context: SessionContext) {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    try {
      const passwordHash =
        session.user.id === localAdminId() ? await this.localAdminHash() : undefined;

      await db
        .insert(users)
        .values({
          email: session.user.email,
          id: session.user.id,
          name: session.user.name,
          passwordHash,
        })
        .onConflictDoUpdate({
          set: {
            email: session.user.email,
            name: session.user.name,
            ...(passwordHash ? { passwordHash } : {}),
            updatedAt: new Date(),
          },
          target: users.id,
        });

      await this.persistResourceGrants(session.user);
      await this.persistGroups(session.user);

      await db.insert(authSessions).values({
        expiresAt: session.expiresAt,
        ipAddress: context.ipAddress,
        tokenHash: session.tokenHash,
        userAgent: context.userAgent,
        userId: session.user.id,
      });
    } catch (error) {
      this.markDatabaseUnavailable(error);
    }
  }

  private async authenticateFromDatabase(tokenHash: string): Promise<AuthResult | undefined> {
    const db = this.availableDatabase();

    if (!db) {
      return undefined;
    }

    try {
      const [row] = await db
        .select({
          sessionId: authSessions.id,
          userEmail: users.email,
          userId: users.id,
          userName: users.name,
        })
        .from(authSessions)
        .innerJoin(users, eq(authSessions.userId, users.id))
        .where(
          and(
            eq(authSessions.tokenHash, tokenHash),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (!row) {
        return undefined;
      }

      await db
        .update(authSessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(authSessions.tokenHash, tokenHash));

      const access = await this.localAccessForUser(row.userId);
      const groups = await this.localGroupsForUser(row.userId);

      return {
        sessionId: row.sessionId,
        user: {
          email: row.userEmail,
          groups,
          id: row.userId,
          name: row.userName,
          permissions: permissionsForRoles(access.roles),
          provider: "local",
          resourceGrants: access.resourceGrants,
          roles: access.roles,
        },
      };
    } catch (error) {
      this.markDatabaseUnavailable(error);
      return undefined;
    }
  }

  private async revokeDatabaseSession(tokenHash: string) {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    try {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(authSessions.tokenHash, tokenHash));
    } catch (error) {
      this.markDatabaseUnavailable(error);
    }
  }

  private async persistResourceGrants(user: CurrentUser) {
    const db = this.availableDatabase();

    if (!db || user.resourceGrants.length === 0) {
      return;
    }

    try {
      await db
        .insert(userResourceGrants)
        .values(
          user.resourceGrants.map((grant) => ({
            resourceId: grant.resourceId,
            resourceType: grant.resourceType,
            userId: user.id,
          })),
        )
        .onConflictDoNothing();
    } catch (error) {
      this.markDatabaseUnavailable(error);
    }
  }

  private async persistGroups(user: CurrentUser) {
    const db = this.availableDatabase();

    if (!db || user.groups.length === 0 || !isUuid(user.id)) {
      return;
    }

    try {
      await this.upsertGroups(user.groups);
      await db
        .insert(userAccessGroups)
        .values(user.groups.map((group) => ({ groupId: group.id, userId: user.id })))
        .onConflictDoNothing();
    } catch (error) {
      this.markDatabaseUnavailable(error);
    }
  }

  private async localGroupsForUser(userId: string): Promise<AccessGroup[]> {
    const override = this.localGroupOverrides.get(userId);

    if (override) {
      return override;
    }

    const db = this.availableDatabase();

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
        this.markDatabaseUnavailable(error);
      }
    }

    if (userId !== localAdminId()) {
      return [];
    }

    return localGroupsFromEnv();
  }

  private async localAccessForUser(userId: string): Promise<LocalAccess> {
    const override = this.localAccessOverrides.get(userId);

    if (override) {
      return override;
    }

    const db = this.availableDatabase();

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
        this.markDatabaseUnavailable(error);
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

  private async persistLocalUserAccess(userId: string, access: LocalAccess, groups: AccessGroup[]) {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    try {
      await this.ensureSecurityCatalog();
      await this.upsertGroups(groups);

      await db.delete(userRoles).where(eq(userRoles.userId, userId));
      await db.delete(userResourceGrants).where(eq(userResourceGrants.userId, userId));
      await db.delete(userAccessGroups).where(eq(userAccessGroups.userId, userId));

      await db.insert(userRoles).values(
        access.roles.map((roleId) => ({
          roleId,
          userId,
        })),
      );

      if (access.resourceGrants.length > 0) {
        await db.insert(userResourceGrants).values(
          access.resourceGrants.map((grant) => ({
            resourceId: grant.resourceId,
            resourceType: grant.resourceType,
            userId,
          })),
        );
      }

      if (groups.length > 0) {
        await db.insert(userAccessGroups).values(
          groups.map((group) => ({
            groupId: group.id,
            userId,
          })),
        );
      }
    } catch (error) {
      this.markDatabaseUnavailable(error);
      throw new AuthError("Local user access storage is unavailable", "database_unavailable");
    }
  }

  private async upsertGroups(groups: AccessGroup[]) {
    const db = this.availableDatabase();

    if (!db || groups.length === 0) {
      return;
    }

    for (const group of groups) {
      await db.insert(accessGroups).values(group).onConflictDoNothing();
      await db
        .update(accessGroups)
        .set({
          name: group.name,
          updatedAt: new Date(),
        })
        .where(eq(accessGroups.id, group.id));
    }
  }

  private async ensureSecurityCatalog() {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    await db
      .insert(roleRows)
      .values(roles.map((id) => ({ id, name: roleName(id) })))
      .onConflictDoNothing();
    await db
      .insert(permissionRows)
      .values(permissions.map((id) => ({ id, name: permissionName(id) })))
      .onConflictDoNothing();
    await db
      .insert(rolePermissionRows)
      .values(
        roles.flatMap((roleId) =>
          rolePermissions[roleId].map((permissionId) => ({
            permissionId,
            roleId,
          })),
        ),
      )
      .onConflictDoNothing();
  }

  private availableDatabase() {
    return this.dbAvailable ? this.db : undefined;
  }

  private markDatabaseUnavailable(error: unknown) {
    this.dbAvailable = false;
    console.warn("auth session persistence unavailable; using memory store", error);
  }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt, passwordKeyLength, {
    N: scryptCost,
    maxmem: scryptMaxMemory,
    p: scryptParallelization,
    r: scryptBlockSize,
  });

  return [
    passwordHashVersion,
    scryptCost,
    scryptBlockSize,
    scryptParallelization,
    salt,
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [version, cost, blockSize, parallelization, salt, expectedHash] = encodedHash.split("$");

  if (version !== passwordHashVersion || !salt || !expectedHash) {
    return false;
  }

  const key = await scrypt(password, salt, passwordKeyLength, {
    N: Number(cost),
    maxmem: scryptMaxMemory,
    p: Number(parallelization),
    r: Number(blockSize),
  });
  const expected = Buffer.from(expectedHash, "base64url");

  return expected.length === key.length && timingSafeEqual(expected, key);
}

function scrypt(
  password: string,
  salt: string,
  keyLength: number,
  options: Parameters<typeof scryptCallback>[3],
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}

function defaultLocalPassword() {
  if (process.env.NODE_ENV === "production") {
    throw new AuthError(
      "RAKKR_LOCAL_ADMIN_PASSWORD is required in production",
      "missing_local_password",
    );
  }

  return "rakkr-local-dev-password";
}
