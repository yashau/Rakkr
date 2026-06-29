import { z } from "zod";

export const oidcProviderSchema = z.enum(["azure_ad"]);
export const oidcPublicConfigSchema = z.object({
  clientId: z.string().optional(),
  configured: z.boolean(),
  discoveryUrl: z.string().url().optional(),
  enabled: z.boolean(),
  issuer: z.string().url().optional(),
  loginAvailable: z.boolean(),
  missingFields: z.array(z.string()),
  provider: oidcProviderSchema,
  redirectUri: z.string().url().optional(),
  scopes: z.array(z.string().min(1)),
});
export const oidcDiscoverySchema = z.object({
  authorizationEndpoint: z.string().url(),
  issuer: z.string().url(),
  jwksUri: z.string().url(),
  tokenEndpoint: z.string().url(),
  userinfoEndpoint: z.string().url().optional(),
});

export type OidcDiscovery = z.infer<typeof oidcDiscoverySchema>;
export type OidcProvider = z.infer<typeof oidcProviderSchema>;
export type OidcPublicConfig = z.infer<typeof oidcPublicConfigSchema>;
