import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import {
  emptyUploadQueueFilterDraft,
  uploadQueueFilterChips,
  uploadQueueFiltersFromDraft,
  uploadRunnerPanelPermissions,
} from "./upload-runner-panel-helpers";

test("upload runner panel permissions are closed by default", () => {
  assert.deepEqual(uploadRunnerPanelPermissions(undefined), {
    canRead: false,
    canRun: false,
  });
});

test("upload runner panel separates status read from run control", () => {
  assert.deepEqual(uploadRunnerPanelPermissions(user(["recording:read"])), {
    canRead: true,
    canRun: false,
  });
  assert.deepEqual(uploadRunnerPanelPermissions(user(["recording:control"])), {
    canRead: false,
    canRun: true,
  });
  assert.deepEqual(uploadRunnerPanelPermissions(user(["recording:control", "recording:read"])), {
    canRead: true,
    canRun: true,
  });
});

test("upload queue filters trim recording ids and expose active chips", () => {
  const filters = uploadQueueFiltersFromDraft({
    ...emptyUploadQueueFilterDraft,
    provider: "s3",
    recordingId: " rec_upload_1 ",
    status: "failed",
  });

  assert.deepEqual(filters, {
    provider: "s3",
    recordingId: "rec_upload_1",
    status: "failed",
  });
  assert.deepEqual(uploadQueueFilterChips(filters), [
    { key: "status", label: "status", value: "failed" },
    { key: "provider", label: "provider", value: "s3" },
    { key: "recordingId", label: "recording", value: "rec_upload_1" },
  ]);
});

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "operator@example.test",
    groups: [],
    id: "user_operator",
    name: "Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
