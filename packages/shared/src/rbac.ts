import { z } from "zod";

import { accessGroupSchema } from "./access-groups.js";
import { isoDateTimeSchema } from "./base.js";

// Role/permission catalog and the derived allow decisions. This is the RBAC
// source of truth shared by the controller API and the operator console.
export const permissions = [
  "audit:read",
  "auth:manage",
  "health:acknowledge",
  "health:read",
  "listen:monitor",
  "metrics:read",
  "node:control",
  "node:manage",
  "node:read",
  "recording:control",
  "recording:create",
  "recording:delete",
  "recording:download",
  "recording:edit",
  "recording:playback",
  "recording:read",
  "schedule:manage",
  "schedule:read",
  "settings:manage",
  "settings:read",
  "switcher:manage",
  "switcher:map",
  "switcher:read",
  "system:admin",
] as const;

export const roles = ["owner", "admin", "operator", "viewer", "auditor"] as const;
export type Permission = (typeof permissions)[number];
export type Role = (typeof roles)[number];
export const permissionSchema = z.enum(permissions);
export const roleSchema = z.enum(roles);
export const accessPolicyEffectSchema = z.enum(["allow", "deny"]);
export const accessPolicySubjectTypeSchema = z.enum(["user", "group", "everyone"]);
export const resourceGrantSchema = z.object({
  resourceId: z.string().min(1),
  resourceType: z.string().min(1),
});
export const accessPolicySchema = z.object({
  effect: accessPolicyEffectSchema,
  id: z.string().min(1),
  reason: z.string().optional(),
  resourceId: z.string().min(1),
  resourceType: z.string().min(1),
  subjectId: z.string().optional(),
  subjectType: accessPolicySubjectTypeSchema,
});
export const accessPolicyInputSchema = accessPolicySchema.omit({ id: true });
export const rolePermissions: Record<Role, readonly Permission[]> = {
  admin: permissions.filter((permission) => permission !== "system:admin"),
  auditor: ["audit:read", "health:read", "metrics:read", "recording:read"],
  operator: [
    "health:acknowledge",
    "health:read",
    "listen:monitor",
    "metrics:read",
    "node:control",
    "node:read",
    "recording:control",
    "recording:create",
    "recording:download",
    "recording:edit",
    "recording:playback",
    "recording:read",
    "schedule:manage",
    "schedule:read",
    "settings:read",
    "switcher:map",
    "switcher:read",
  ],
  owner: permissions,
  viewer: [
    "health:read",
    "metrics:read",
    "node:read",
    "recording:download",
    "recording:playback",
    "recording:read",
    "schedule:read",
    "settings:read",
    "switcher:read",
  ],
};

export function hasPermission(role: Role, permission: Permission) {
  return rolePermissions[role].includes(permission);
}

export function hasAnyPermission(role: Role, required: Permission[]) {
  return required.some((permission) => hasPermission(role, permission));
}

export const currentUserSchema = z.object({
  disabledAt: isoDateTimeSchema.optional(),
  email: z.string().email(),
  groups: z.array(accessGroupSchema),
  id: z.string().min(1),
  name: z.string().min(1),
  permissions: z.array(permissionSchema),
  provider: z.enum(["local", "oidc"]),
  resourceGrants: z.array(resourceGrantSchema),
  roles: z.array(roleSchema),
});

export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type AccessPolicyEffect = z.infer<typeof accessPolicyEffectSchema>;
export type AccessPolicyInput = z.infer<typeof accessPolicyInputSchema>;
export type AccessPolicySubjectType = z.infer<typeof accessPolicySubjectTypeSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
