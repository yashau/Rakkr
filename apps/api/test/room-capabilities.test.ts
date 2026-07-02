import assert from "node:assert/strict";
import test from "node:test";
import type { Permission } from "@rakkr/shared";
import {
  permissionRequiresCapability,
  roomCapabilities,
  roomCapabilityPermissions,
} from "@rakkr/shared";

test("each capability maps to concrete room-scoped permissions", () => {
  assert.deepEqual(roomCapabilityPermissions.operate, ["recording:create", "recording:control"]);
  assert.deepEqual(roomCapabilityPermissions.book, ["schedule:manage"]);
  assert.deepEqual(roomCapabilityPermissions.listen, ["listen:monitor"]);
  assert.ok(roomCapabilityPermissions.view.includes("recording:read"));
  assert.ok(roomCapabilityPermissions.view.includes("recording:playback"));
});

test("permissionRequiresCapability resolves room-grantable permissions", () => {
  assert.equal(permissionRequiresCapability("recording:create"), "operate");
  assert.equal(permissionRequiresCapability("recording:control"), "operate");
  assert.equal(permissionRequiresCapability("schedule:manage"), "book");
  assert.equal(permissionRequiresCapability("listen:monitor"), "listen");
  assert.equal(permissionRequiresCapability("recording:download"), "download");
  assert.equal(permissionRequiresCapability("recording:delete"), "delete");
  assert.equal(permissionRequiresCapability("recording:edit"), "edit");
  assert.equal(permissionRequiresCapability("node:read"), "view");
});

test("global / infrastructure permissions can never be room-granted", () => {
  const nonRoomPermissions: Permission[] = [
    "node:manage",
    "node:control",
    "settings:manage",
    "settings:read",
    "auth:manage",
    "metrics:read",
    "audit:read",
    "system:admin",
  ];

  for (const permission of nonRoomPermissions) {
    assert.equal(
      permissionRequiresCapability(permission),
      undefined,
      `${permission} must not map to a room capability`,
    );
  }
});

test("every capability's permissions are individually reverse-resolvable", () => {
  for (const capability of roomCapabilities) {
    for (const permission of roomCapabilityPermissions[capability]) {
      assert.equal(permissionRequiresCapability(permission), capability);
    }
  }
});
