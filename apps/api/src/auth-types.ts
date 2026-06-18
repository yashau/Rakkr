import type {
  AccessGroup,
  AccessPolicy,
  AccessPolicyEffect,
  AccessPolicyInput,
  CurrentUser,
  ResourceGrant,
  Role,
} from "@rakkr/shared";

export interface AuthSession {
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

export type { AccessGroup, AccessPolicy, AccessPolicyInput, CurrentUser };
