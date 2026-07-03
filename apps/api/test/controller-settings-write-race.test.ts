import assert from "node:assert/strict";
import test from "node:test";

// Exercises the Postgres controller-settings read-modify-write on the singleton
// row. Runs only when a test DB is provided via RAKKR_API_TEST_DATABASE_URL.
// DATABASE_URL must be set BEFORE importing the store.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createControllerSettingsStore } = await import("../src/controller-settings-store.js");

test(
  "concurrent controller-settings updates of different fields do not clobber",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    // Separate stores => separate pool connections => real parallelism.
    const reader = createControllerSettingsStore();
    const storeA = createControllerSettingsStore();
    const storeB = createControllerSettingsStore();

    // Two operators concurrently patch DIFFERENT fields. Pre-fix, each read the
    // same baseline, merged its own field, and the later writer clobbered the
    // other's change (last-writer-wins). The advisory-locked read-merge-write must
    // let both survive. Loop to make the race near-certain to be exercised.
    for (let i = 0; i < 20; i += 1) {
      await reader.update({ controllerName: `Baseline ${i}`, weekStartsOn: "monday" });

      const targetName = `Concurrent Name ${i}`;

      await Promise.all([
        storeA.update({ controllerName: targetName }),
        storeB.update({ weekStartsOn: "sunday" }),
      ]);

      const settings = await reader.find();

      assert.equal(
        settings.controllerName,
        targetName,
        `iteration ${i}: name update was clobbered`,
      );
      assert.equal(
        settings.weekStartsOn,
        "sunday",
        `iteration ${i}: weekStartsOn update was clobbered`,
      );
    }
  },
);
