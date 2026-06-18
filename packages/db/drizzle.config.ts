import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://rakkr:rakkr@127.0.0.1:5432/rakkr",
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema.ts",
});
