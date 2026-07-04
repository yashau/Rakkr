import { randomBytes } from "node:crypto";

import {
  and,
  authSessions,
  createDatabase,
  eq,
  gt,
  isNull,
  userResourceGrants,
  userRoles,
  userAccessGroups,
  users,
} from "@rakkr/db";
import type {
  AccessGroup,
  AccessPolicy,
  AccessPolicyInput,
  AccessPolicyDecision,
  AuthResult,
  AuthSession,
  CurrentUser,
  LocalAccess,
  LocalUserCreateInput,
  LoginResult,
  SessionContext,
} from "./auth-types.js";
import { LocalAccessPolicyManager } from "./auth-access-policy-manager.js";
import { AuthError } from "./auth-errors.js";
import { LocalGroupManager } from "./auth-group-manager.js";
import {
  resolveUserAccess,
  resolveUserGroups,
  type UserAccessResolverDeps,
} from "./auth-user-access-resolver.js";

import {
  bearerToken,
  dbOutageGraceExceeded,
  groupsFromIds,
  hashToken,
  isPgConstraintError,
  isPgErrorCode,
  isUuid,
  localAdminId,
  permissionsForRoles,
  uniqueResourceGrants,
  uniqueRoles,
} from "./auth-utils.js";
import {
  deleteLocalUser as deleteLocalUserRecord,
  localUserReturning,
  resetLocalUserPassword as resetLocalUserPasswordHash,
  revokeUserSessions,
  updateLocalUserDisabled as updateLocalUserDisabledRecord,
  type LocalUserRecord,
} from "./auth-user-lifecycle.js";
import {
  authFallbackGraceMs,
  authProvider,
  defaultLocalPassword,
  ensureSecurityCatalog,
  upsertGroups,
} from "./auth-persistence-helpers.js";
import { OidcSyncError, type AzureAdOidcUserSyncInput } from "./oidc-sync.js";
import { syncAzureAdOidcUser as syncOidcUser } from "./oidc-user-sync.js";
import { hashPassword, verifyPassword } from "./password.js";
export type {
  AccessPolicyDecision,
  AuthResult,
  LocalAccess,
  LocalUserCreateInput,
  LoginResult,
  SessionContext,
} from "./auth-types.js";
export { AuthError } from "./auth-errors.js";

const sessionTtlMs = 12 * 60 * 60 * 1000;

export class LocalAuthService {
  private accessPolicyOverrides?: AccessPolicyInput[];
  private readonly localAccessOverrides = new Map<string, LocalAccess>();
  private readonly localGroupOverrides = new Map<string, AccessGroup[]>();
  private readonly oidcUserRecords = new Map<string, LocalUserRecord>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly db?: ReturnType<typeof createDatabase>;
  private dbAvailable: boolean;
  // Epoch ms of the ongoing DB-outage start (undefined when the DB is reachable),
  // used to bound how long the memory-fallback keeps serving login-time perms.
  private dbUnavailableSince?: number;
  private readonly fallbackGraceMs: number;
  private localAdminPasswordHash?: string;
  private decoyPasswordHashPromise?: Promise<string>;
  // First-party access-group management lives in its own module; the service lends
  // it the shared session/override state it needs (see auth-group-manager.ts).
  private readonly groupManager: LocalGroupManager;
  // Resource access-policy CRUD + decision (see auth-access-policy-manager.ts); it
  // shares the service's access-policy override cache via callbacks.
  private readonly accessPolicyManager: LocalAccessPolicyManager;

  constructor(databaseUrl = process.env.DATABASE_URL, fallbackGraceMs = authFallbackGraceMs()) {
    this.db = databaseUrl ? createDatabase(databaseUrl) : undefined;
    this.dbAvailable = Boolean(this.db);
    this.fallbackGraceMs = fallbackGraceMs;
    this.groupManager = new LocalGroupManager({
      availableDatabase: () => this.availableDatabase(),
      getAccessPolicyOverrides: () => this.accessPolicyOverrides,
      localGroupOverrides: this.localGroupOverrides,
      localUser: (userId) => this.localUser(userId),
      localUsers: () => this.localUsers(),
      markDatabaseUnavailable: (error) => this.markDatabaseUnavailable(error),
      refreshUserSessions: (user) => this.refreshUserSessions(user),
      setAccessPolicyOverrides: (policies) => {
        this.accessPolicyOverrides = policies;
      },
    });
    this.accessPolicyManager = new LocalAccessPolicyManager({
      availableDatabase: () => this.availableDatabase(),
      getAccessPolicyOverrides: () => this.accessPolicyOverrides,
      markDatabaseUnavailable: (error) => this.markDatabaseUnavailable(error),
      setAccessPolicyOverrides: (policies) => {
        this.accessPolicyOverrides = policies;
      },
    });
  }

  // Access-group CRUD + membership (create/rename/delete, members, list, detail).
  get groups(): LocalGroupManager {
    return this.groupManager;
  }

  async login(email: string, password: string, context: SessionContext = {}): Promise<LoginResult> {
    const persistedUser = await this.localUserRecordByEmail(email);
    const admin = await this.localAdmin();
    const matchesAdmin = email.toLowerCase() === admin.email.toLowerCase();

    // Always run exactly one scrypt verification, even when the email is unknown
    // or the account has no local password — otherwise the fast (no-KDF) reject
    // path leaks, via response time, whether an email is registered (a login
    // user-enumeration timing oracle). When nothing matches we verify against a
    // decoy hash whose comparison is guaranteed to fail.
    const targetHash = persistedUser?.passwordHash
      ? persistedUser.passwordHash
      : matchesAdmin
        ? await this.localAdminHash()
        : await this.decoyPasswordHash();
    const valid = await verifyPassword(password, targetHash);

    if (persistedUser) {
      if (persistedUser.disabledAt) {
        throw new AuthError("Local user is disabled", "user_disabled");
      }

      if (!persistedUser.passwordHash || !valid) {
        throw new AuthError("Invalid credentials", "invalid_credentials");
      }

      return this.createSession(await this.currentUserFromRecord(persistedUser), context);
    }

    if (!matchesAdmin || !valid) {
      throw new AuthError("Invalid credentials", "invalid_credentials");
    }

    return this.createSession(admin, context);
  }

  async createSession(user: CurrentUser, context: SessionContext = {}): Promise<LoginResult> {
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
    const now = Date.now();

    // If a configured DB has been latched unavailable past the fallback grace,
    // probe it once here so a recovered DB restores fresh permissions instead of
    // the memory cache serving login-time perms indefinitely.
    if (this.staleFallbackTripped(now)) {
      this.dbAvailable = true;
    }

    const persistedSession = await this.authenticateFromDatabase(tokenHash);

    // A reachable DB (probe succeeded or it was never down) clears the outage clock.
    if (this.dbAvailable) {
      this.dbUnavailableSince = undefined;
    }

    if (persistedSession) {
      return persistedSession;
    }

    // Bounded staleness: once the outage has exceeded the grace we can no longer
    // confirm current access, so refuse to keep honoring the login-time permissions
    // cached in memory (a revoked user would otherwise retain access for the whole
    // outage). No-DB deployments (memory authoritative) are never tripped.
    if (this.staleFallbackTripped(now)) {
      return {};
    }

    const session = this.sessions.get(tokenHash);

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(tokenHash);
      return {};
    }

    if (session.user.disabledAt) {
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
      return [
        await this.localAdmin(),
        ...(await Promise.all(
          [...this.oidcUserRecords.values()].map((record) => this.currentUserFromRecord(record)),
        )),
      ];
    }

    try {
      const rows = await db.select(localUserReturning).from(users);
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

    let row: LocalUserRecord | undefined;

    try {
      [row] = await db
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
        })
        .returning(localUserReturning);

      if (!row) {
        throw new AuthError("Local user storage is unavailable", "database_unavailable");
      }

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

  async syncAzureAdOidcUser(input: AzureAdOidcUserSyncInput): Promise<CurrentUser> {
    try {
      return await syncOidcUser(input, this.oidcSyncAdapter());
    } catch (error) {
      if (error instanceof OidcSyncError) {
        throw new AuthError(error.message, error.code);
      }

      throw new AuthError("OIDC user storage is unavailable", "database_unavailable");
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

    this.refreshUserSessions(user);

    return user;
  }

  async resetLocalUserPassword(userId: string, password: string): Promise<CurrentUser | undefined> {
    const db = this.requiredDatabase();
    const before = await this.localUserRecordById(userId);

    if (!before) {
      return undefined;
    }

    await resetLocalUserPasswordHash(db, userId, password);
    await revokeUserSessions(db, this.sessions, userId);

    return this.localUser(userId);
  }

  async updateLocalUserDisabled(userId: string, disabled: boolean) {
    const db = this.requiredDatabase();
    const row = await updateLocalUserDisabledRecord(db, userId, disabled);

    if (!row) {
      return undefined;
    }

    if (disabled) {
      await revokeUserSessions(db, this.sessions, userId);
    }

    return this.currentUserFromRecord(row);
  }

  async deleteLocalUser(userId: string) {
    const db = this.requiredDatabase();
    const before = await this.localUserRecordById(userId);

    if (!before) {
      return undefined;
    }

    const deleted = await this.currentUserFromRecord(before);

    await revokeUserSessions(db, this.sessions, userId);
    await deleteLocalUserRecord(db, userId);
    this.localAccessOverrides.delete(userId);
    this.localGroupOverrides.delete(userId);

    return deleted;
  }

  accessPolicies(): Promise<AccessPolicy[]> {
    return this.accessPolicyManager.list();
  }

  accessPolicyDecision(
    user: CurrentUser,
    targets: Array<{ id?: string; type: string }>,
  ): Promise<AccessPolicyDecision | undefined> {
    return this.accessPolicyManager.decision(user, targets);
  }

  updateLocalAccessPolicies(
    policies: AccessPolicyInput[],
    actorUserId?: string,
  ): Promise<AccessPolicy[]> {
    return this.accessPolicyManager.update(policies, actorUserId);
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

  // A stable, valid scrypt hash (of a random, never-matching password) used as the
  // verify() target when no real account/hash applies, so an unknown-email login
  // still pays the full KDF cost and cannot be distinguished by timing from a real
  // failed login. Computed once and cached (its own scrypt is amortized away).
  private decoyPasswordHash() {
    this.decoyPasswordHashPromise ??= hashPassword(randomBytes(32).toString("base64url"));

    return this.decoyPasswordHashPromise;
  }

  private async localUserRecordByEmail(email: string) {
    const db = this.availableDatabase();

    if (!db) {
      return this.oidcUserRecords.get(email.toLowerCase());
    }

    try {
      const [row] = await db
        .select(localUserReturning)
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

      return row;
    } catch (error) {
      this.markDatabaseUnavailable(error);
      return undefined;
    }
  }

  private async localUserRecordByExternalId(externalId: string) {
    const db = this.availableDatabase();

    if (!db) {
      return [...this.oidcUserRecords.values()].find((record) => record.externalId === externalId);
    }

    try {
      const [row] = await db
        .select(localUserReturning)
        .from(users)
        .where(eq(users.externalId, externalId))
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
      return [...this.oidcUserRecords.values()].find((record) => record.id === userId);
    }

    try {
      const [row] = await db
        .select(localUserReturning)
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      return row;
    } catch (error) {
      this.markDatabaseUnavailable(error);
      return undefined;
    }
  }

  private async currentUserFromRecord(record: LocalUserRecord): Promise<CurrentUser> {
    const access = await this.localAccessForUser(record.id);

    return {
      disabledAt: record.disabledAt?.toISOString(),
      email: record.email,
      groups: await this.localGroupsForUser(record.id),
      id: record.id,
      name: record.name,
      permissions: permissionsForRoles(access.roles),
      provider: authProvider(record.provider),
      resourceGrants: access.resourceGrants,
      roles: access.roles,
    };
  }

  private refreshUserSessions(user: CurrentUser) {
    for (const session of this.sessions.values()) {
      if (session.user.id === user.id) {
        session.user = user;
      }
    }
  }

  private oidcSyncAdapter() {
    return {
      currentUserFromRecord: (record: LocalUserRecord) => this.currentUserFromRecord(record),
      db: () => this.availableDatabase(),
      findUserByEmail: (email: string) => this.localUserRecordByEmail(email),
      findUserByExternalId: (externalId: string) => this.localUserRecordByExternalId(externalId),
      markDatabaseUnavailable: (error: unknown) => this.markDatabaseUnavailable(error),
      memoryRecordByEmail: (email: string) => this.oidcUserRecords.get(email),
      memoryRecordByExternalId: (externalId: string) =>
        [...this.oidcUserRecords.values()].find((record) => record.externalId === externalId),
      persistAccess: async (userId: string, access: LocalAccess, groups: AccessGroup[]) => {
        await this.persistLocalUserAccess(userId, access, groups);
        this.localAccessOverrides.set(userId, {
          resourceGrants: access.resourceGrants,
          roles: access.roles,
        });
        this.localGroupOverrides.set(userId, groups);
      },
      refreshSessions: (user: CurrentUser) => this.refreshUserSessions(user),
      saveMemoryRecord: (email: string, record: LocalUserRecord) => {
        this.oidcUserRecords.set(email, record);
      },
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
          provider: session.user.provider,
        })
        .onConflictDoUpdate({
          set: {
            email: session.user.email,
            name: session.user.name,
            ...(passwordHash ? { passwordHash } : {}),
            provider: session.user.provider,
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
          userDisabledAt: users.disabledAt,
          userEmail: users.email,
          userId: users.id,
          userName: users.name,
          userProvider: users.provider,
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

      if (!row || row.userDisabledAt) {
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
          provider: authProvider(row.userProvider),
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
      await upsertGroups(db, user.groups);
      await db
        .insert(userAccessGroups)
        .values(user.groups.map((group) => ({ groupId: group.id, userId: user.id })))
        .onConflictDoNothing();
    } catch (error) {
      this.markDatabaseUnavailable(error);
    }
  }

  private localGroupsForUser(userId: string): Promise<AccessGroup[]> {
    return resolveUserGroups(this.userAccessResolverDeps(), userId);
  }

  private localAccessForUser(userId: string): Promise<LocalAccess> {
    return resolveUserAccess(this.userAccessResolverDeps(), userId);
  }

  private userAccessResolverDeps(): UserAccessResolverDeps {
    return {
      accessOverrides: this.localAccessOverrides,
      availableDatabase: () => this.availableDatabase(),
      groupOverrides: this.localGroupOverrides,
      markDatabaseUnavailable: (error) => this.markDatabaseUnavailable(error),
    };
  }

  private async persistLocalUserAccess(userId: string, access: LocalAccess, groups: AccessGroup[]) {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    try {
      await ensureSecurityCatalog(db);
      await upsertGroups(db, groups);

      await db.delete(userRoles).where(eq(userRoles.userId, userId));
      await db.delete(userResourceGrants).where(eq(userResourceGrants.userId, userId));
      await db.delete(userAccessGroups).where(eq(userAccessGroups.userId, userId));

      // Guarded like the grant/group inserts below — an empty values() insert
      // throws in Postgres, which previously broke syncing any user with no role
      // (e.g. an OIDC login whose token carries groups but no known app role).
      if (access.roles.length > 0) {
        await db.insert(userRoles).values(
          access.roles.map((roleId) => ({
            roleId,
            userId,
          })),
        );
      }

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

  private availableDatabase() {
    return this.dbAvailable ? this.db : undefined;
  }

  // True when a configured DB has been unavailable past the fallback grace window
  // — the point at which cached login-time permissions may no longer be trusted.
  private staleFallbackTripped(now: number): boolean {
    return dbOutageGraceExceeded({
      databaseAvailable: this.dbAvailable,
      databaseConfigured: this.db !== undefined,
      graceMs: this.fallbackGraceMs,
      now,
      unavailableSince: this.dbUnavailableSince,
    });
  }

  private requiredDatabase() {
    const db = this.availableDatabase();

    if (!db) {
      throw new AuthError("Local user storage is unavailable", "database_unavailable");
    }

    return db;
  }

  private markDatabaseUnavailable(error: unknown): void {
    // A data-integrity error (constraint violation / data exception) is NOT a
    // connectivity failure — this specific write was rejected for bad data. Do NOT
    // latch into the memory store (which silently drops every later DB write, incl.
    // access changes, until process restart). Also do NOT abort the caller: this
    // helper is invoked from fire-and-forget persistence and read/authorization
    // paths (login-session persist, session lookup, group/access reads) that must
    // keep serving the request on a rejected write — e.g. a login carrying an
    // over-long X-Forwarded-For must not 401. Log the rejected write and return; the
    // access-write callers that want to surface the failure throw their own
    // AuthError after calling this.
    if (isPgConstraintError(error)) {
      console.warn("auth database rejected a write (constraint violation); not latching", error);
      return;
    }

    // Stamp the outage start once (kept across probe re-latches; cleared only when
    // the DB is confirmed reachable again) so the fallback grace is measured from
    // the genuine outage start, not reset on every failed request.
    this.dbUnavailableSince ??= Date.now();
    this.dbAvailable = false;
    console.warn("auth session persistence unavailable; using memory store", error);
  }
}
