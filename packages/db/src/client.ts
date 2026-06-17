import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 3 });

  return drizzle(client);
}

export { desc };
