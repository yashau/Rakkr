import { isDatabaseUnavailableError } from "./database-unavailable.js";

// Background runners fire on a timer with no caller to catch rejections. A
// DB-authoritative store now throws DatabaseUnavailableError when Postgres is
// unreachable (see database-unavailable.ts), so a scheduled tick must swallow
// it — skip this tick and retry next interval — rather than let it escape a
// `void tick()` as an unhandled promise rejection and crash the process. This
// restores the pre-503 "runners degrade, don't die" property for the scheduled
// path; request-path `runOnce()` still propagates so the route returns 503.
//
// The handler never rethrows (that would re-create the unhandled rejection); it
// logs unexpected errors loudly and transient DB unavailability quietly.
export function reportRunnerTickError(runner: string) {
  return (error: unknown) => {
    if (isDatabaseUnavailableError(error)) {
      console.warn(`${runner} tick skipped: database unavailable`);
      return;
    }

    console.error(`${runner} tick failed`, error);
  };
}
