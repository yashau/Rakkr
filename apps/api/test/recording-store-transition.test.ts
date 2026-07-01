import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const root = await mkdtemp(path.join(tmpdir(), "rakkr-recording-store-transition-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_METADATA_STORE_PATH = path.join(root, "recordings.json");

const { createRecordingStore } = await import("../src/recording-store.js");

test.after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("recordingStore.transition is an atomic status compare-and-set", async () => {
  const store = createRecordingStore([]);
  const base: RecordingSummary = {
    cached: false,
    durationSeconds: 0,
    folder: "f",
    healthStatus: "unknown",
    id: "rec_transition",
    name: "Transition Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: [],
  };
  await store.create(base);

  // Transitions from an allowed source status and persists the passed object.
  const completed = await store.transition({ ...base, status: "completed" }, [
    "queued",
    "recording",
  ]);
  assert.equal(completed?.status, "completed");
  assert.equal((await store.find(base.id))?.status, "completed");

  // Loses the CAS when the stored status is no longer an allowed source, so a
  // recording another writer already moved (e.g. a concurrent cache upload that
  // secured it) is not clobbered.
  const blocked = await store.transition({ ...base, status: "failed" }, ["queued", "recording"]);
  assert.equal(blocked, undefined);
  assert.equal((await store.find(base.id))?.status, "completed");
});
