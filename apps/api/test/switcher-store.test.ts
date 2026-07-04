import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const storeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-switchers-"));
process.env.RAKKR_SWITCHER_STORE_PATH = path.join(storeRoot, "switchers.json");

const { createSwitcherStore, SwitcherStoreError } = await import("../src/switcher-store.js");

test.after(async () => {
  await rm(storeRoot, { force: true, recursive: true });
});

test("persists switcher config, redacts secrets, and resolves decrypted connection", async () => {
  const store = createSwitcherStore();

  assert.deepEqual(await store.list(), []);

  const created = await store.create({
    displayName: "Hansard Matrix",
    enabled: true,
    host: "172.22.195.101",
    mode: "observe",
    model: "avpro-ac-max",
    username: "admin",
  });

  // Model-derived defaults are applied.
  assert.equal(created.model, "avpro-ac-max");
  assert.equal(created.inputs, 24);
  assert.equal(created.outputs, 24);
  assert.equal(created.port, 23);
  assert.equal(created.mode, "observe");
  assert.equal(created.hasPassword, false);
  // Secrets are never echoed through status responses.
  assert.equal((created as unknown as Record<string, unknown>).password, undefined);

  // Add a password and flip to enforce.
  const updated = await store.update(created.id, { mode: "enforce", password: "naseer@123" });

  assert.equal(updated?.mode, "enforce");
  assert.equal(updated?.hasPassword, true);
  assert.equal((updated as unknown as Record<string, unknown>).password, undefined);

  // resolveConfig hands the decrypted secret to the driver/reconcile loop only.
  const resolved = await store.resolveConfig(created.id);

  assert.equal(resolved?.host, "172.22.195.101");
  assert.equal(resolved?.port, 23);
  assert.equal(resolved?.username, "admin");
  assert.equal(resolved?.password, "naseer@123");
  assert.equal(resolved?.model, "avpro-ac-max");
  assert.equal(resolved?.mode, "enforce");

  // Empty password clears the stored secret.
  const cleared = await store.update(created.id, { password: "" });

  assert.equal(cleared?.hasPassword, false);
  assert.equal((await store.resolveConfig(created.id))?.password, undefined);

  // Explicit port survives; username null clears it.
  const second = await store.create({
    displayName: "Overflow Matrix",
    enabled: false,
    host: "10.0.0.5",
    port: 2323,
    username: "svc",
  });

  assert.equal(second.port, 2323);
  assert.equal(second.enabled, false);

  const nulled = await store.update(second.id, { username: null });

  assert.equal(nulled?.username, undefined);

  // Two switchers coexist; delete removes a single row.
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.delete(second.id), true);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.find(second.id), undefined);
});

test("rejects a duplicate operator-supplied id as a conflict, not a DB outage", async () => {
  const store = createSwitcherStore();

  await store.create({
    displayName: "Chamber Matrix",
    enabled: true,
    host: "10.0.0.10",
    id: "switcher_chamber",
    model: "avpro-ac-max",
    username: "admin",
  });

  // Re-creating the same explicit id must surface a typed conflict (→ 409), not fall
  // through to the failover path that would mislabel it as a 503 "database unavailable".
  await assert.rejects(
    () =>
      store.create({
        displayName: "Chamber Matrix (dupe)",
        enabled: true,
        host: "10.0.0.11",
        id: "switcher_chamber",
        model: "avpro-ac-max",
        username: "admin",
      }),
    (error: unknown) => error instanceof SwitcherStoreError && error.code === "switcher_exists",
  );

  // The duplicate did not clobber or duplicate the stored row.
  assert.equal((await store.list()).filter((entry) => entry.id === "switcher_chamber").length, 1);
});
