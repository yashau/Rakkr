import { z } from "zod";
import { roles, type AccessGroup, type ResourceGrant, type Role } from "@rakkr/shared";
import {
  groupsFromIds,
  oidcGroupsFromClaims,
  uniqueGroups,
  uniqueResourceGrants,
  uniqueRoles,
} from "./auth-utils.js";

// `groups`/`roles` are non-identity claims whose shape varies across IdPs (arrays
// of names, arrays of GUIDs, or — for a single value — a bare string). Parse them
// leniently: drop non-string/empty entries and coerce a non-array claim to no
// entries, so an IdP quirk in these claims never fails the whole login. Identity
// claims (`sub`, email family) stay strict below.
const claimStringArraySchema = z
  .array(z.unknown())
  .transform((values) =>
    values
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()),
  )
  .catch([])
  .optional();

export const azureAdOidcClaimsSchema = z
  .object({
    email: z.string().email().optional(),
    groups: claimStringArraySchema,
    name: z.string().trim().min(1).optional(),
    oid: z.string().trim().min(1).optional(),
    preferred_username: z.string().email().optional(),
    roles: claimStringArraySchema,
    sub: z.string().trim().min(1),
    tid: z.string().trim().min(1).optional(),
    upn: z.string().email().optional(),
  })
  .passthrough();

export type AzureAdOidcClaims = z.infer<typeof azureAdOidcClaimsSchema>;

export interface AzureAdOidcUserSyncInput {
  claims: AzureAdOidcClaims;
  groupIds?: string[];
  resourceGrants?: ResourceGrant[];
  roles?: Role[];
}

export interface NormalizedAzureAdOidcUser {
  email: string;
  externalId: string;
  groups: AccessGroup[];
  name: string;
  resourceGrants: ResourceGrant[];
  roles: Role[];
  subject: string;
  tenantId?: string;
}

export class OidcSyncError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_oidc_claims",
  ) {
    super(message);
  }
}

export function normalizeAzureAdOidcUser(
  input: AzureAdOidcUserSyncInput,
): NormalizedAzureAdOidcUser {
  const claims = azureAdOidcClaimsSchema.safeParse(input.claims);

  if (!claims.success) {
    throw new OidcSyncError("Azure AD OIDC claims are invalid", "invalid_oidc_claims");
  }

  const email = (claims.data.email ?? claims.data.preferred_username ?? claims.data.upn)
    ?.trim()
    .toLowerCase();

  if (!email) {
    throw new OidcSyncError("Azure AD OIDC email claim is required", "invalid_oidc_claims");
  }

  const claimRoles = claims.data.roles?.filter((role): role is Role =>
    roles.includes(role as Role),
  );

  warnOnGroupsOverage(input.claims);

  return {
    email,
    externalId: claims.data.oid ?? claims.data.sub,
    // Explicit groupIds are already-resolved Rakkr ids; claim groups are raw IdP
    // values that must be slugged so they collide with operator-created groups.
    groups: uniqueGroups([
      ...groupsFromIds(input.groupIds ?? []),
      ...oidcGroupsFromClaims(claims.data.groups ?? []),
    ]),
    name: claims.data.name?.trim() || email,
    resourceGrants: uniqueResourceGrants(input.resourceGrants ?? []),
    roles: uniqueRoles([...(input.roles ?? []), ...(claimRoles ?? [])]),
    subject: claims.data.sub,
    tenantId: claims.data.tid,
  };
}

// Azure AD replaces the `groups` claim with a `_claim_names`/`_claim_sources`
// pointer to Microsoft Graph once a user exceeds the token group limit ("groups
// overage"). We do not resolve the pointer, so such a login syncs no groups —
// surface that instead of silently dropping the user's memberships.
function warnOnGroupsOverage(claims: AzureAdOidcUserSyncInput["claims"]) {
  const claimNames = (claims as { _claim_names?: unknown })._claim_names;

  if (
    claimNames &&
    typeof claimNames === "object" &&
    "groups" in (claimNames as Record<string, unknown>)
  ) {
    console.warn(
      "Azure AD OIDC token signals groups overage (_claim_names.groups); group memberships are not synced for this login.",
    );
  }
}
