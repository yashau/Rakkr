import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from "node:crypto";

import {
  and,
  authSessions,
  createDatabase,
  eq,
  gt,
  isNull,
  userResourceGrants,
  users,
} from "@rakkr/db";
import { rolePermissions, type CurrentUser, type ResourceGrant, type Role } from "@rakkr/shared";

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

  async localAdmin(): Promise<CurrentUser> {
    const role = localRole();
    const userId = localAdminId();

    return {
      email: process.env.RAKKR_LOCAL_ADMIN_EMAIL ?? "admin@rakkr.local",
      id: userId,
      name: process.env.RAKKR_LOCAL_ADMIN_NAME ?? "Local Admin",
      permissions: [...rolePermissions[role]],
      provider: "local",
      resourceGrants: await this.resourceGrantsForUser(userId),
      roles: [role],
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

      const role = localRole();
      const resourceGrants = await this.resourceGrantsForUser(row.userId);

      return {
        sessionId: row.sessionId,
        user: {
          email: row.userEmail,
          id: row.userId,
          name: row.userName,
          permissions: [...rolePermissions[role]],
          provider: "local",
          resourceGrants,
          roles: [role],
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

  private async resourceGrantsForUser(userId: string): Promise<ResourceGrant[]> {
    const db = this.availableDatabase();

    if (db) {
      try {
        const rows = await db
          .select({
            resourceId: userResourceGrants.resourceId,
            resourceType: userResourceGrants.resourceType,
          })
          .from(userResourceGrants)
          .where(eq(userResourceGrants.userId, userId));

        if (rows.length > 0) {
          return rows;
        }
      } catch (error) {
        this.markDatabaseUnavailable(error);
      }
    }

    return userId === localAdminId() ? localResourceGrantsFromEnv() : [];
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
