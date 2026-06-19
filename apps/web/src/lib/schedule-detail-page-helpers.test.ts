import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { scheduleDetailPagePermissions } from "./schedule-detail-page-helpers";

test("schedule detail permissions are closed by default", () => {
  assert.deepEqual(scheduleDetailPagePermissions(undefined), {
    canAcknowledgeHealth: false,
    canDownloadRecordings: false,
    canPlaybackRecordings: false,
    canReadAudit: false,
    canReadHealth: false,
    canReadNodes: false,
    canReadRecordings: false,
    canReadSchedule: false,
  });
});

test("schedule detail read permission does not imply related data access", () => {
  assert.deepEqual(scheduleDetailPagePermissions(user(["schedule:read"])), {
    canAcknowledgeHealth: false,
    canDownloadRecordings: false,
    canPlaybackRecordings: false,
    canReadAudit: false,
    canReadHealth: false,
    canReadNodes: false,
    canReadRecordings: false,
    canReadSchedule: true,
  });
});

test("schedule detail permissions mirror granular read and action grants", () => {
  assert.deepEqual(
    scheduleDetailPagePermissions(
      user([
        "audit:read",
        "health:acknowledge",
        "health:read",
        "node:read",
        "recording:download",
        "recording:playback",
        "recording:read",
        "schedule:read",
      ]),
    ),
    {
      canAcknowledgeHealth: true,
      canDownloadRecordings: true,
      canPlaybackRecordings: true,
      canReadAudit: true,
      canReadHealth: true,
      canReadNodes: true,
      canReadRecordings: true,
      canReadSchedule: true,
    },
  );
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
