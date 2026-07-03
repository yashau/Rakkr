import type {
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
  groupIds: string[];
  grantsText: string;
  roles: Role[];
}

export interface CreateUserDraft {
  email: string;
  groupIds: string[];
  grantsText: string;
  name: string;
  password: string;
  roles: Role[];
}

export const emptyCreateUserDraft: CreateUserDraft = {
  email: "",
  groupIds: [],
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
    groupIds: user.groups.map((group) => group.id),
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

export function accessUpdateFromDraft(draft: AccessDraft): UserAccessUpdate {
  return {
    groupIds: [...new Set(draft.groupIds)],
    resourceGrants: grantsFromText(draft.grantsText),
    roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
  };
}

export function createInputFromDraft(draft: CreateUserDraft): LocalUserCreateInput {
  return {
    email: draft.email.trim(),
    groupIds: [...new Set(draft.groupIds)],
    name: draft.name.trim(),
    password: draft.password,
    resourceGrants: grantsFromText(draft.grantsText),
    roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
  };
}

/**
 * Assignable-subject pickers (room roster, schedule assignees) fetch the full
 * user/group list up to the server cap (`PAGE_POLICY.default.maxLimit`), not a
 * 50-row page — otherwise groups/users beyond the first page are unreachable in
 * the combobox. The query keys are params-suffixed so the pickers do NOT share a
 * TanStack Query cache slot with the paginated management views: a shared bare
 * `["access-groups"]` slot let whichever query ran last clamp the other's list.
 */
export const SUBJECT_PICKER_LIMIT = 200;

export function subjectPickerFilters(): { limit: number } {
  return { limit: SUBJECT_PICKER_LIMIT };
}

export function subjectPickerGroupsQueryKey() {
  return ["access-groups", subjectPickerFilters()] as const;
}

export function subjectPickerUsersQueryKey() {
  return ["access-users", subjectPickerFilters()] as const;
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
