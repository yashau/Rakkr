import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  DatabaseUnavailableError,
  isDatabaseUnavailableError,
} from "../src/database-unavailable.js";

test("isDatabaseUnavailableError identifies only the DB-unavailable error", () => {
  assert.equal(isDatabaseUnavailableError(new DatabaseUnavailableError("db down")), true);
  assert.equal(isDatabaseUnavailableError(new Error("other")), false);
  assert.equal(isDatabaseUnavailableError("nope"), false);
  assert.equal(isDatabaseUnavailableError(undefined), false);
});

test("the API error boundary maps DatabaseUnavailableError to 503 and other errors to 500", async () => {
  // Mirrors the app.onError boundary in index.ts.
  const app = new Hono();

  app.onError((error, c) => {
    if (isDatabaseUnavailableError(error)) {
      return c.json(
        { error: "Service temporarily unavailable", reason: "database_unavailable" },
        503,
      );
    }

    return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/db-down", () => {
    // What a DB-authoritative store now throws instead of silently falling back.
    throw new DatabaseUnavailableError("recording metadata persistence unavailable");
  });
  app.get("/boom", () => {
    throw new Error("kaboom");
  });

  const dbDown = await app.request("/db-down");
  const boom = await app.request("/boom");

  assert.equal(dbDown.status, 503);
  assert.equal(((await dbDown.json()) as { reason: string }).reason, "database_unavailable");
  assert.equal(boom.status, 500);
});
