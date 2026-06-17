import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from "node:crypto";

import { rolePermissions, type CurrentUser, type Role } from "@rakkr/shared";

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

export interface AuthResult {
  sessionId?: string;
  user?: CurrentUser;
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
  private localAdminPasswordHash?: string;

  async login(email: string, password: string): Promise<LoginResult> {
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

    this.sessions.set(tokenHash, {
      createdAt: new Date(),
      expiresAt,
      tokenHash,
      user,
    });

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
      this.sessions.delete(hashToken(token));
    }
  }

  async localAdmin(): Promise<CurrentUser> {
    const role = localRole();

    return {
      email: process.env.RAKKR_LOCAL_ADMIN_EMAIL ?? "admin@rakkr.local",
      id: process.env.RAKKR_LOCAL_ADMIN_ID ?? "local_admin",
      name: process.env.RAKKR_LOCAL_ADMIN_NAME ?? "Local Admin",
      permissions: [...rolePermissions[role]],
      provider: "local",
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

function defaultLocalPassword() {
  if (process.env.NODE_ENV === "production") {
    throw new AuthError(
      "RAKKR_LOCAL_ADMIN_PASSWORD is required in production",
      "missing_local_password",
    );
  }

  return "rakkr-local-dev-password";
}
