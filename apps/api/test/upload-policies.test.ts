import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const policyRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-policies-"));
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(policyRoot, "policies.json");

const {
  createUploadPolicy,
  listUploadPolicies,
  updateUploadPolicy,
  uploadPolicyForCachedRecording,
  uploadPolicyForQueue,
  uploadQueueInputForPolicy,
} = await import("../src/upload-policies.js");

test.after(async () => {
  await rm(policyRoot, { force: true, recursive: true });
});

test("creates and updates upload policy templates", async () => {
  const created = await createUploadPolicy({
    enabled: true,
    maxAttempts: 7,
    name: "Scheduled S3",
    provider: "s3",
    target: "s3://rakkr-archive/meetings",
    trigger: "on_recording_cached",
  });

  assert.equal(created.provider, "s3");
  assert.equal(created.trigger, "on_recording_cached");

  const cachedRecording = recording(created.id);
  const autoPolicy = await uploadPolicyForCachedRecording(cachedRecording);

  assert.equal(autoPolicy?.id, created.id);
  assert.deepEqual(uploadQueueInputForPolicy(autoPolicy!, "policy_on_recording_cached"), {
    maxAttempts: 7,
    policyId: created.id,
    provider: "s3",
    reason: "policy_on_recording_cached",
    target: "s3://rakkr-archive/meetings",
  });
  assert.equal(await uploadPolicyForCachedRecording(recording("upload-policy-stub")), undefined);
  assert.equal(
    await uploadPolicyForCachedRecording({
      ...cachedRecording,
      cached: false,
      status: "recording",
    }),
    undefined,
  );

  const updated = await updateUploadPolicy(created.id, {
    provider: "stub",
    target: "stub://queue-only",
  });

  assert.equal(updated?.provider, "stub");
  assert.equal(updated?.maxAttempts, 7);
  assert.equal((await uploadPolicyForQueue(updated?.id)).provider, "stub");
  assert.equal(
    (await listUploadPolicies()).find((policy) => policy.id === updated?.id)?.maxAttempts,
    7,
  );
  assert.ok((await listUploadPolicies()).some((policy) => policy.id === "upload-policy-stub"));
});

function recording(uploadPolicyId: string): RecordingSummary {
  return {
    cached: true,
    durationSeconds: 60,
    folder: "Meetings",
    healthStatus: "healthy",
    id: "rec_upload_policy_test",
    name: "Upload Policy Test",
    nodeId: "node_upload_policy_test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: [],
    uploadPolicyId,
  };
}
