import { and, desc, eq, gt, gte, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 3 });

  return drizzle(client);
}

export async function closeDatabase(database: ReturnType<typeof createDatabase>) {
  await database.$client.end();
}

export { and, desc, eq, gt, gte, ilike, isNull, lte, or, sql, type SQL };
