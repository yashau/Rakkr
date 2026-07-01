// Thrown by DB-authoritative stores when Postgres is unreachable, instead of
// silently diverging to the boot-time in-memory/JSON fallback (whose writes
// vanish on the next restart). The API error boundary maps it to 503 so the
// caller retries against the real database rather than persisting to a store
// that will not survive. Stores that use the in-memory store as a legitimate
// primary (audit/health/meter) keep their resilient fallback and do NOT throw.
export class DatabaseUnavailableError extends Error {
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = "DatabaseUnavailableError";
    this.reason = reason;
  }
}

export function isDatabaseUnavailableError(error: unknown): error is DatabaseUnavailableError {
  return error instanceof DatabaseUnavailableError;
}
