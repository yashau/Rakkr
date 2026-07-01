import { apiErrorStatus } from "./api-error";

// What the root layout should render based on the token + the `/auth/me` query.
export type AuthGateState = "unauthenticated" | "session-error" | "loading" | "authed";

export interface AuthGateInput {
  hasToken: boolean;
  isError: boolean;
  isPending: boolean;
  error: unknown;
}

// Decide the auth gate. The key rule: only a genuine 401/403 invalidates the
// session (→ re-login, clear the token). A transient 5xx / network error must
// NOT bounce a validly-authenticated operator to the login screen (and must not
// leave a stale token behind); it surfaces a retry state instead.
export function authGateState(input: AuthGateInput): AuthGateState {
  if (!input.hasToken) {
    return "unauthenticated";
  }

  if (input.isError) {
    const status = apiErrorStatus(input.error);

    return status === 401 || status === 403 ? "unauthenticated" : "session-error";
  }

  if (input.isPending) {
    return "loading";
  }

  return "authed";
}
