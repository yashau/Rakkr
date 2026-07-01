import type {
  AccessGroup,
  AccessPolicy,
  AccessPolicyInput,
  CurrentUser,
  ResourceGrant,
  Role,
} from "@rakkr/shared";

import type { LocalUserCreateInput, UserAccessUpdate } from "@/lib/api";

export interface AccessPagePermissions {
  canManage: boolean;
  canRead: boolean;
}

export interface AccessDraft {
  groupsText: string;
  grantsText: string;
  roles: Role[];
}

export interface CreateUserDraft {
  email: string;
  groupsText: string;
  grantsText: string;
  name: string;
  password: string;
  roles: Role[];
}

export const emptyCreateUserDraft: CreateUserDraft = {
  email: "",
  groupsText: "",
  grantsText: "",
  name: "",
  password: "",
  roles: ["viewer"],
};

export function canManageAccessPage(user: CurrentUser | undefined) {
  return user?.permissions.includes("auth:manage") ?? false;
}

/**
 * Page-level RBAC state for the access screen. Access management is gated behind
 * the single `auth:manage` permission, so read and manage track together. Pages
 * and components must consume these booleans instead of inspecting `permissions`
 * directly (see `ui-rbac-boundary.test.ts`).
 */
export function accessPagePermissions(user: CurrentUser | undefined): AccessPagePermissions {
  const canManage = canManageAccessPage(user);

  return {
    canManage,
    canRead: canManage,
  };
}

/** Whether the create-user draft has the minimum valid fields to submit. */
export function createUserDraftValid(draft: CreateUserDraft): boolean {
  return Boolean(draft.email.trim()) && Boolean(draft.name.trim()) && draft.password.length >= 8;
}

/**
 * Whether a password reset is meaningful for this user. Only local users have a
 * controller-held password; OIDC-provisioned users authenticate through the IdP.
 * Mirrors the API's `resetPassword` action readiness
 * (`auth-management-routes.ts` -> `ready: user.provider === "local"`), so the UI
 * must not offer a reset the API will refuse with
 * `non_local_user_password_unavailable`.
 */
export function canResetUserPassword(user: CurrentUser): boolean {
  return user.provider === "local";
}

export function accessDraftFromUser(user: CurrentUser): AccessDraft {
  return {
    groupsText: groupsToText(user.groups),
    grantsText: grantsToText(user.resourceGrants),
    roles: user.roles,
  };
}

export function policiesToText(policies: AccessPolicy[]) {
  return policies
    .map((policy) =>
      [
        policy.effect,
        policySubject(policy),
        `${policy.resourceType}:${policy.resourceId}`,
        policy.reason,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

export function appendTextLine(current: string, line: string) {
  const trimmed = current.trim();

  return trimmed ? `${trimmed}\n${line}` : line;
}

function policySubject(policy: AccessPolicy) {
  if (policy.subjectType === "everyone") {
    return "everyone";
  }

  return `${policy.subjectType}:${policy.subjectId ?? ""}`;
}

export function policiesFromText(value: string): { error?: string; policies: AccessPolicyInput[] } {
  const policies: AccessPolicyInput[] = [];
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const [index, line] of lines.entries()) {
    const parts = line.includes("|")
      ? line.split("|").map((part) => part.trim())
      : line.split(/\s+/);
    const [effect, subject, resource, ...reasonParts] = parts;

    if (effect !== "allow" && effect !== "deny") {
      return { error: `Line ${index + 1} must start with allow or deny.`, policies: [] };
    }

    const parsedSubject = subjectFromText(subject);
    const parsedResource = resourceFromText(resource);

    if (!parsedSubject || !parsedResource) {
      return { error: `Line ${index + 1} has an invalid subject or resource.`, policies: [] };
    }

    policies.push({
      effect,
      reason: reasonParts.join(" | ") || undefined,
      resourceId: parsedResource.resourceId,
      resourceType: parsedResource.resourceType,
      subjectId: parsedSubject.subjectId,
      subjectType: parsedSubject.subjectType,
    });
  }

  return { policies };
}

function subjectFromText(
  value: string | undefined,
): Pick<AccessPolicyInput, "subjectId" | "subjectType"> | undefined {
  if (value === "everyone") {
    return {
      subjectType: "everyone" as const,
    };
  }

  const parsed = typedToken(value);

  if (!parsed || (parsed.type !== "user" && parsed.type !== "group")) {
    return undefined;
  }

  return {
    subjectId: parsed.id,
    subjectType: parsed.type === "user" ? "user" : "group",
  };
}

function resourceFromText(value: string | undefined) {
  const parsed = typedToken(value);

  return parsed
    ? {
        resourceId: parsed.id,
        resourceType: parsed.type,
      }
    : undefined;
}

function typedToken(value: string | undefined) {
  const separator = value?.indexOf(":") ?? -1;

  if (!value || separator <= 0) {
    return undefined;
  }

  const type = value.slice(0, separator).trim();
  const id = value.slice(separator + 1).trim();

  return type && id
    ? {
        id,
        type,
      }
    : undefined;
}

export function grantsToText(grants: ResourceGrant[]) {
  return grants.map((grant) => `${grant.resourceType}:${grant.resourceId}`).join("\n");
}

export function groupsToText(groups: AccessGroup[]) {
  return groups.map((group) => group.id).join("\n");
}

export function groupIdsFromText(value: string) {
  return uniqueTextValues(value);
}

export function accessUpdateFromDraft(draft: AccessDraft): UserAccessUpdate {
  return {
    groupIds: groupIdsFromText(draft.groupsText),
    resourceGrants: grantsFromText(draft.grantsText),
    roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
  };
}

export function createInputFromDraft(draft: CreateUserDraft): LocalUserCreateInput {
  return {
    email: draft.email.trim(),
    groupIds: groupIdsFromText(draft.groupsText),
    name: draft.name.trim(),
    password: draft.password,
    resourceGrants: grantsFromText(draft.grantsText),
    roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
  };
}

export function grantsFromText(value: string): ResourceGrant[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");

      return separator === -1
        ? {
            resourceId: line,
            resourceType: "node",
          }
        : {
            resourceId: line.slice(separator + 1).trim(),
            resourceType: line.slice(0, separator).trim(),
          };
    })
    .filter((grant) => grant.resourceId && grant.resourceType);
}

function uniqueTextValues(value: string) {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
