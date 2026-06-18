export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "database_unavailable"
      | "invalid_oidc_claims"
      | "invalid_credentials"
      | "missing_local_password"
      | "user_disabled"
      | "user_exists",
  ) {
    super(message);
  }
}
