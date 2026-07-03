import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, createDatabase, eq, isNull, nodeSshCredentials, nodes } from "@rakkr/db";

// Exercises the Postgres rotation path specifically: the "two active credentials"
// race only appears with real async DB round-trips (the in-memory path is not
// used for SSH credentials — the fallback store rejects). Runs only when a test
// DB is provided via RAKKR_API_TEST_DATABASE_URL (repo convention); otherwise it
// skips and opens no pool. DATABASE_URL must be set BEFORE importing the store
// (createNodeSshCredentialStore reads it). Node isolates each test file in its
// own process, so this does not leak into other suites.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close, so the process would otherwise idle until the runner's exit timeout.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createNodeSshCredentialStore } = await import("../src/node-ssh-credential-store.js");

test(
  "concurrent SSH credential rotations leave exactly one active credential",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const db = createDatabase(dbUrl as string);
    const nodeId = `node_sshrot_${randomUUID()}`;

    await db.insert(nodes).values({
      agentVersion: "0.0.0-test",
      alias: "SSH Rotation Test Node",
      hostname: "ssh-rotation-test.local",
      id: nodeId,
    });

    // Many operators (or a double-submit) race to rotate the same node's key at
    // once. Pre-fix (non-atomic revoke-then-insert with no partial unique index)
    // several revoke the prior key and all insert a fresh active row, leaving
    // multiple un-revoked credentials for one node. The transaction plus the
    // `node_ssh_credentials_active_node_idx` partial unique index must guarantee
    // exactly one active credential regardless of interleaving. High fan-out
    // makes the race window near-certain to be exercised.
    const rotations = Array.from({ length: 16 }, () =>
      createNodeSshCredentialStore(dbUrl as string)
        .rotate(nodeId)
        .then(
          () => "ok" as const,
          () => "err" as const,
        ),
    );
    const outcomes = await Promise.all(rotations);

    const active = await db
      .select({ id: nodeSshCredentials.id })
      .from(nodeSshCredentials)
      .where(and(eq(nodeSshCredentials.nodeId, nodeId), isNull(nodeSshCredentials.revokedAt)));

    assert.equal(active.length, 1, "exactly one active credential must remain after the race");
    assert.ok(
      outcomes.includes("ok"),
      "at least one rotation must succeed (the losers fail closed)",
    );

    // The surviving active credential is resolvable as the node's active key.
    const activeMeta = await createNodeSshCredentialStore(dbUrl as string).findActiveMetadata(
      nodeId,
    );

    assert.ok(activeMeta, "the node must have a resolvable active credential");
    assert.equal(activeMeta?.id, active[0]?.id);
  },
);
