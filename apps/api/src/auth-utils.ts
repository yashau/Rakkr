import { createHash } from "node:crypto";

import {
  accessGroupSlug,
  accessPolicyInputSchema,
  rolePermissions,
  roles,
  type AccessGroup,
  type AccessPolicy,
  type AccessPolicyInput,
  type CurrentUser,
  type ResourceGrant,
  type Role,
} from "@rakkr/shared";

const defaultLocalAdminId = "00000000-0000-4000-8000-000000000001";

export function bearerToken(authorizationHeader?: string) {
  const [scheme, token] = authorizationHeader?.split(" ") ?? [];

  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function localRole(): Role {
  const role = process.env.RAKKR_LOCAL_ADMIN_ROLE;

  if (isRole(role)) {
    return role;
  }

  return "owner";
}

export function localAdminId() {
  const id = process.env.RAKKR_LOCAL_ADMIN_ID;

  if (id && isUuid(id)) {
    return id;
  }

  return defaultLocalAdminId;
}

export function localResourceGrantsFromEnv(): ResourceGrant[] {
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

export function localGroupsFromEnv(): AccessGroup[] {
  const raw = process.env.RAKKR_LOCAL_ADMIN_GROUPS;

  if (!raw) {
    return [];
  }

  const values = raw.trim().startsWith("[")
    ? jsonStringArray(raw, "RAKKR_LOCAL_ADMIN_GROUPS")
    : raw.split(",");

  return groupsFromIds(values);
}

export function groupsFromIds(values: readonly string[]) {
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

export function uniqueGroups(values: readonly AccessGroup[]) {
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

// Maps raw IdP group-claim values (names or opaque ids) onto stable Rakkr group
// ids using the SAME slug rule as operator-created groups (accessGroupSlug), so
// an OIDC "Room Council" claim resolves to the `room-council` group an operator
// made instead of a divergent second group. The raw claim value is kept as the
// display name. When a value has no slug-usable characters we fall back to a
// deterministic hash id (stable across logins, unlike the random id the manual
// path uses on create) so the same claim never spawns duplicate groups.
export function oidcGroupsFromClaims(values: readonly string[]) {
  return uniqueGroups(
    values
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({
        id: accessGroupSlug(value) || `group-${hashToken(value).slice(0, 12)}`,
        // Cap to the access_groups.name varchar(160) budget (matching the operator
        // create schema). An uncapped IdP claim (e.g. a full group DN) would trip a
        // Postgres length constraint on insert, failing the login and latching the
        // auth service into DB-unavailable memory-fallback.
        name: value.slice(0, 160),
      })),
  );
}

export function localAccessPoliciesFromEnv(): AccessPolicy[] {
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

export function accessPoliciesWithIds(policies: readonly AccessPolicyInput[]): AccessPolicy[] {
  return policies.map((policy, index) => ({
    ...policy,
    id: `policy_${hashToken(JSON.stringify(policy)).slice(0, 16)}_${index}`,
  }));
}

export function policyMatchesSubject(policy: AccessPolicy, user: CurrentUser) {
  if (policy.subjectType === "everyone") {
    return true;
  }

  if (policy.subjectType === "user") {
    return policy.subjectId === user.id || policy.subjectId === user.email;
  }

  return Boolean(policy.subjectId && user.groups.some((group) => group.id === policy.subjectId));
}

export function policyMatchesTarget(
  policy: AccessPolicy,
  targets: Array<{ id?: string; type: string }>,
) {
  return targets.some(
    (target) =>
      target.id &&
      (policy.resourceType === target.type || policy.resourceType === "*") &&
      (policy.resourceId === target.id || policy.resourceId === "*"),
  );
}

export function uniqueAccessPolicyInputs(values: readonly AccessPolicyInput[]) {
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

export function uniqueRoles(values: readonly string[]): Role[] {
  const result = values.filter((role): role is Role => isRole(role));

  return [...new Set(result)];
}

export function uniqueResourceGrants(values: readonly ResourceGrant[]) {
  return [
    ...new Map(
      values.map((grant) => [`${grant.resourceType}:${grant.resourceId}`, grant] as const),
    ).values(),
  ];
}

export function permissionsForRoles(values: readonly Role[]) {
  return [...new Set(values.flatMap((role) => rolePermissions[role]))];
}

export function accessKeepsAuthManage(values: readonly string[]) {
  return uniqueRoles(values).some((role) => rolePermissions[role].includes("auth:manage"));
}

export function accessSnapshot(user: CurrentUser | undefined) {
  return {
    disabledAt: user?.disabledAt,
    groups: user?.groups ?? [],
    resourceGrants: user?.resourceGrants ?? [],
    roles: user?.roles ?? [],
  };
}

export function roleName(role: Role) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function permissionName(permission: string) {
  return permission
    .split(":")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

export function isPgErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { cause?: unknown; code?: unknown };

  // Drizzle wraps the driver's PostgresError as `.cause` ("Failed query: …"), so
  // the SQLSTATE lives on the cause, not the top-level error — walk the chain.
  return record.code === code || isPgErrorCode(record.cause, code);
}

// SQLSTATE class 22 (data exception, e.g. 22001 string-too-long) and 23 (integrity
// constraint violation, e.g. 23505 unique / 23503 FK / 23502 not-null / 23514
// check) mean the write was rejected for BAD DATA — not that the database is
// unreachable. Walks the `cause` chain like isPgErrorCode.
export function isPgConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { cause?: unknown; code?: unknown };
  const code = typeof record.code === "string" ? record.code : "";

  return code.startsWith("22") || code.startsWith("23") || isPgConstraintError(record.cause);
}

// Bounded staleness for the auth memory-fallback. Once a CONFIGURED database has
// been unavailable longer than the grace window, the controller can no longer
// confirm current access, so it must stop honoring the login-time permissions
// cached in memory (a revoked user would otherwise keep access for the whole
// outage). Returns true only for a configured-but-currently-unavailable DB whose
// outage has exceeded the grace; no-DB deployments (memory is authoritative) and
// healthy/short-blip DBs are never tripped. Drives both the recovery probe and
// the deny decision in authenticate().
export function dbOutageGraceExceeded(input: {
  databaseConfigured: boolean;
  databaseAvailable: boolean;
  unavailableSince: number | undefined;
  now: number;
  graceMs: number;
}): boolean {
  if (
    !input.databaseConfigured ||
    input.databaseAvailable ||
    input.unavailableSince === undefined
  ) {
    return false;
  }

  return input.now - input.unavailableSince > input.graceMs;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && roles.includes(value as Role);
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
