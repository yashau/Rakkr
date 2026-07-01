// Error thrown by the API client for a non-2xx response, carrying the HTTP
// status so callers can distinguish a genuine auth failure (401/403) from a
// transient server/network error (5xx) — see auth-gate.ts.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Request failed: ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export function apiErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}
