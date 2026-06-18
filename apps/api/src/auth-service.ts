import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from "node:crypto";

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
  accessPolicyInputSchema,
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

const passwordHashVersion = "scrypt";
const passwordKeyLength = 64;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptMaxMemory = 64 * 1024 * 1024;
const sessionTtlMs = 12 * 60 * 60 * 1000;
const defaultLocalAdminId = "00000000-0000-4000-8000-000000000001";

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
    readonly code: "invalid_credentials" | "missing_local_password",
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
    const user = await this.localAdmin();

    if (email.toLowerCase() !== user.email.toLowerCase()) {
      throw new AuthError("Invalid credentials", "invalid_credentials");
    }

    const passwordHash = await this.localAdminHash();
    const valid = await verifyPassword(password, passwordHash);

    if (!valid) {
      throw new AuthError("Invalid credentials", "invalid_credentials");
    }

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
    return [await this.localAdmin()];
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
    return userId === localAdminId() ? this.localAdmin() : undefined;
  }

  async updateLocalUserAccess(
    userId: string,
    access: LocalAccess,
  ): Promise<CurrentUser | undefined> {
    if (userId !== localAdminId()) {
      return undefined;
    }

    const nextAccess = {
      resourceGrants: uniqueResourceGrants(access.resourceGrants),
      roles: uniqueRoles(access.roles),
    };
    const nextGroups = groupsFromIds(access.groupIds ?? []);

    this.localAccessOverrides.set(userId, nextAccess);
    this.localGroupOverrides.set(userId, nextGroups);
    await this.persistLocalUserAccess(userId, nextAccess, nextGroups);

    const user = await this.localAdmin();

    for (const session of this.sessions.values()) {
      if (session.user.id === userId) {
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

  private async persistLoginSession(session: AuthSession, context: SessionContext) {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    try {
      await db
        .insert(users)
        .values({
          email: session.user.email,
          id: session.user.id,
          name: session.user.name,
          passwordHash: await this.localAdminHash(),
        })
        .onConflictDoUpdate({
          set: {
            email: session.user.email,
            name: session.user.name,
            passwordHash: await this.localAdminHash(),
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

function bearerToken(authorizationHeader?: string) {
  const [scheme, token] = authorizationHeader?.split(" ") ?? [];

  return scheme?.toLowerCase() === "bearer" ? token : undefined;
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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function localRole(): Role {
  const role = process.env.RAKKR_LOCAL_ADMIN_ROLE;

  if (
    role === "owner" ||
    role === "admin" ||
    role === "operator" ||
    role === "viewer" ||
    role === "auditor"
  ) {
    return role;
  }

  return "owner";
}

function localAdminId() {
  const id = process.env.RAKKR_LOCAL_ADMIN_ID;

  if (id && isUuid(id)) {
    return id;
  }

  return defaultLocalAdminId;
}

function localResourceGrantsFromEnv(): ResourceGrant[] {
  const raw = process.env.RAKKR_LOCAL_RESOURCE_GRANTS;

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return Object.entries(parsed).flatMap(([resourceType, values]) => {
      if (!Array.isArray(values)) {
        return [];
      }

      return values
        .filter((resourceId): resourceId is string => typeof resourceId === "string")
        .map((resourceId) => ({
          resourceId,
          resourceType,
        }));
    });
  } catch (error) {
    console.warn("invalid RAKKR_LOCAL_RESOURCE_GRANTS JSON; ignoring scoped grants", error);
    return [];
  }
}

function localGroupsFromEnv(): AccessGroup[] {
  const raw = process.env.RAKKR_LOCAL_ADMIN_GROUPS;

  if (!raw) {
    return [];
  }

  const values = raw.trim().startsWith("[")
    ? jsonStringArray(raw, "RAKKR_LOCAL_ADMIN_GROUPS")
    : raw.split(",");

  return groupsFromIds(values);
}

function groupsFromIds(values: readonly string[]) {
  return uniqueGroups(
    values
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({
        id: value,
        name: value,
      })),
  );
}

function uniqueGroups(values: readonly AccessGroup[]) {
  return [
    ...new Map(
      values
        .map((group) => ({
          id: group.id.trim(),
          name: group.name.trim() || group.id.trim(),
        }))
        .filter((group) => group.id)
        .map((group) => [group.id, group] as const),
    ).values(),
  ];
}

function localAccessPoliciesFromEnv(): AccessPolicy[] {
  const raw = process.env.RAKKR_LOCAL_ACCESS_POLICIES;

  if (!raw) {
    return [];
  }

  try {
    const parsed = accessPolicyInputSchema.array().parse(JSON.parse(raw));

    return accessPoliciesWithIds(parsed);
  } catch (error) {
    console.warn("invalid RAKKR_LOCAL_ACCESS_POLICIES JSON; ignoring access policies", error);
    return [];
  }
}

function accessPoliciesWithIds(policies: readonly AccessPolicyInput[]): AccessPolicy[] {
  return policies.map((policy, index) => ({
    ...policy,
    id: `policy_${hashToken(JSON.stringify(policy)).slice(0, 16)}_${index}`,
  }));
}

function policyMatchesSubject(policy: AccessPolicy, user: CurrentUser) {
  if (policy.subjectType === "everyone") {
    return true;
  }

  if (policy.subjectType === "user") {
    return policy.subjectId === user.id || policy.subjectId === user.email;
  }

  return Boolean(policy.subjectId && user.groups.some((group) => group.id === policy.subjectId));
}

function policyMatchesTarget(policy: AccessPolicy, targets: Array<{ id?: string; type: string }>) {
  return targets.some(
    (target) =>
      target.id &&
      (policy.resourceType === target.type || policy.resourceType === "*") &&
      (policy.resourceId === target.id || policy.resourceId === "*"),
  );
}

function uniqueAccessPolicyInputs(values: readonly AccessPolicyInput[]) {
  return [
    ...new Map(
      values.map((policy) => [
        [
          policy.effect,
          policy.subjectType,
          policy.subjectId ?? "",
          policy.resourceType,
          policy.resourceId,
        ].join(":"),
        policy,
      ]),
    ).values(),
  ];
}

function jsonStringArray(raw: string, name: string) {
  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch (error) {
    console.warn(`invalid ${name} JSON; ignoring groups`, error);
    return [];
  }
}

function uniqueRoles(values: readonly string[]): Role[] {
  const result = values.filter((role): role is Role => roles.includes(role as Role));

  return [...new Set(result)];
}

function uniqueResourceGrants(values: readonly ResourceGrant[]) {
  return [
    ...new Map(
      values.map((grant) => [`${grant.resourceType}:${grant.resourceId}`, grant] as const),
    ).values(),
  ];
}

function permissionsForRoles(values: readonly Role[]) {
  return [...new Set(values.flatMap((role) => rolePermissions[role]))];
}

function roleName(role: Role) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function permissionName(permission: string) {
  return permission
    .split(":")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
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
