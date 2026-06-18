import { createHash } from "node:crypto";

import {
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

export function isPgErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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
