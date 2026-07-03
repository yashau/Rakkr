import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, createDatabase, eq, isNull, nodeCredentials } from "@rakkr/db";

// Exercises the Postgres node-credential rotation path: the "two active
// credentials" / "zero active credentials" outcomes only appear with real async
// DB round-trips. Runs only when a test DB is provided via
// RAKKR_API_TEST_DATABASE_URL (repo convention); otherwise it skips and opens no
// pool. DATABASE_URL must be set BEFORE importing node-store (createNodeStore
// reads it). Node isolates each test file in its own process.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close, so the process would otherwise idle until the runner's exit timeout.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createNodeStore } = await import("../src/node-store.js");

test(
  "concurrent node credential rotations leave exactly one active credential",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const store = createNodeStore();
    const enrollment = await store.enroll({
      agentVersion: "0.0.0-test",
      alias: `Rotation Node ${randomUUID()}`,
      hostname: "credential-rotation-test.local",
      interfaces: [],
      ipAddresses: [],
      location: { room: "Room A", site: "Site A" },
      tags: [],
    });
    const nodeId = enrollment.node.id;

    // Many operators (or a double-submit) race to rotate the same node's bearer
    // credential at once. Pre-fix (non-atomic revoke-then-insert, no partial
    // unique index) several revoke the prior credential and all insert a fresh
    // active row — leaving multiple un-revoked (still-valid) tokens, or, if an
    // insert fails after the revoke, ZERO active credentials (node locked out).
    // The transaction + `node_credentials_active_node_idx` partial unique index
    // must leave exactly one active credential regardless of interleaving.
    const rotations = Array.from({ length: 16 }, () =>
      store.rotateCredential(nodeId).then(
        () => "ok" as const,
        () => "err" as const,
      ),
    );
    const outcomes = await Promise.all(rotations);

    const db = createDatabase(dbUrl as string);
    const active = await db
      .select({ id: nodeCredentials.id })
      .from(nodeCredentials)
      .where(and(eq(nodeCredentials.nodeId, nodeId), isNull(nodeCredentials.revokedAt)));

    assert.equal(active.length, 1, "exactly one active credential must remain after the race");
    assert.ok(
      outcomes.includes("ok"),
      "at least one rotation must succeed (the losers fail closed)",
    );
  },
);
