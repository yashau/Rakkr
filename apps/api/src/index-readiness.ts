import { createDatabase, sql } from "@rakkr/db";

const READINESS_DB_TIMEOUT_MS = 3000;

// Readiness backing for /readyz. When DATABASE_URL is set we hold ONE dedicated
// health client and probe it with a bounded `select 1`; a hung DB must not hang
// the probe, so the query races a short timeout. When DATABASE_URL is unset
// (memory-store / test mode) there is no DB to depend on, so the controller is
// always ready.
export function createReadinessProbe(databaseUrl: string | undefined) {
  const readinessDatabase = databaseUrl ? createDatabase(databaseUrl) : undefined;

  async function checkDatabaseReady(): Promise<boolean> {
    if (!readinessDatabase) {
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const probe = readinessDatabase.execute(sql`select 1`);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("database readiness probe timed out")),
          READINESS_DB_TIMEOUT_MS,
        );
      });

      await Promise.race([probe, timeout]);

      return true;
    } catch {
      return false;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  return { checkDatabaseReady };
}
