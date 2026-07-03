import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// Exercises the Postgres node metadata read-modify-write: the clobber only
// appears with real concurrent DB round-trips. Runs only when a test DB is
// provided via RAKKR_API_TEST_DATABASE_URL (repo convention); otherwise it skips
// and opens no pool. DATABASE_URL must be set BEFORE importing node-store.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close, so the process would otherwise idle until the runner's exit timeout.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createNodeStore } = await import("../src/node-store.js");

test(
  "concurrent node update and heartbeat do not clobber each other's metadata",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const store = createNodeStore();
    const enrollment = await store.enroll({
      agentVersion: "0.0.0-test",
      alias: `Metadata Race Node ${randomUUID()}`,
      hostname: "metadata-race-test.local",
      interfaces: [],
      ipAddresses: [],
      location: { room: "Room A", site: "Site A" },
      tags: [],
    });
    const nodeId = enrollment.node.id;

    // An operator raises the recording capacity (a metadata JSONB field) while the
    // agent heartbeats frequently (each rewriting metadata from its own read).
    // Pre-fix, a heartbeat that read the pre-update metadata writes it back and
    // reverts the operator's change (last-writer-wins). The per-row lock on the
    // read-modify-write must serialize the two so the operator's change survives.
    // Separate store instances use separate pool connections to make the race real.
    await Promise.all([
      createNodeStore().update(nodeId, { recordingCapacity: { maxConcurrentRecordings: 7 } }),
      ...Array.from({ length: 16 }, () =>
        createNodeStore().heartbeat(nodeId, {
          agentVersion: "0.0.0-test",
          hostname: "metadata-race-test.local",
          ipAddresses: [],
          status: "online",
        }),
      ),
    ]);

    const node = await store.find(nodeId);

    assert.equal(
      node?.recordingCapacity?.maxConcurrentRecordings,
      7,
      "the operator's capacity update must survive concurrent heartbeats",
    );
  },
);
