import { z } from "zod";
import { roles, type AccessGroup, type ResourceGrant, type Role } from "@rakkr/shared";
import { groupsFromIds, uniqueResourceGrants, uniqueRoles } from "./auth-utils.js";

export const azureAdOidcClaimsSchema = z
  .object({
    email: z.string().email().optional(),
    groups: z.array(z.string().trim().min(1)).optional(),
    name: z.string().trim().min(1).optional(),
    oid: z.string().trim().min(1).optional(),
    preferred_username: z.string().email().optional(),
    roles: z.array(z.string().trim().min(1)).optional(),
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

  return {
    email,
    externalId: claims.data.oid ?? claims.data.sub,
    groups: groupsFromIds([...(input.groupIds ?? []), ...(claims.data.groups ?? [])]),
    name: claims.data.name?.trim() || email,
    resourceGrants: uniqueResourceGrants(input.resourceGrants ?? []),
    roles: uniqueRoles([...(input.roles ?? []), ...(claimRoles ?? [])]),
    subject: claims.data.sub,
    tenantId: claims.data.tid,
  };
}
