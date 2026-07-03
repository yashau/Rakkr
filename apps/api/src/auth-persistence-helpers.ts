import {
  accessGroups,
  createDatabase,
  permissions as permissionRows,
  rolePermissions as rolePermissionRows,
  roles as roleRows,
} from "@rakkr/db";
import {
  permissions,
  rolePermissions,
  roles,
  type AccessGroup,
  type CurrentUser,
} from "@rakkr/shared";

import { AuthError } from "./auth-errors.js";
import { permissionName, roleName } from "./auth-utils.js";

type AuthDatabase = ReturnType<typeof createDatabase>;

// Create access groups that don't exist yet (JIT from OIDC claims or user access
// assignment) but never overwrite an existing group's display name — rename is
// owned by createGroup/updateGroup, not membership sync. Otherwise every login
// would clobber the operator-curated name back to the raw claim value.
export async function upsertGroups(db: AuthDatabase, groups: readonly AccessGroup[]) {
  if (groups.length === 0) {
    return;
  }

  for (const group of groups) {
    await db.insert(accessGroups).values(group).onConflictDoNothing();
  }
}

// Idempotently seed the RBAC catalog (roles, permissions, role→permission edges)
// so user-role/grant inserts never trip a foreign key on a fresh database.
export async function ensureSecurityCatalog(db: AuthDatabase) {
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

export function authProvider(value: string): CurrentUser["provider"] {
  return value === "oidc" ? "oidc" : "local";
}

export function defaultLocalPassword() {
  if (process.env.NODE_ENV === "production") {
    throw new AuthError(
      "RAKKR_LOCAL_ADMIN_PASSWORD is required in production",
      "missing_local_password",
    );
  }

  return "rakkr-local-dev-password";
}

// Grace window (ms) during which the auth memory-fallback keeps honoring
// login-time permissions after the DB goes unavailable. Generous by default so a
// transient blip / failover doesn't log everyone out, but bounded so a prolonged
// outage stops serving potentially-revoked access. Tunable via env.
export function authFallbackGraceMs(): number {
  const raw = Number(process.env.RAKKR_AUTH_FALLBACK_GRACE_MS);

  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60 * 1000;
}
