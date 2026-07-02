import assert from "node:assert/strict";
import test from "node:test";

import type { CurrentUser } from "@rakkr/shared";

import {
  switcherModeTone,
  switcherPagePermissions,
  switcherTestSummary,
} from "./switcher-page-helpers.js";

test("switcher permissions derive from the current user's permission set", () => {
  assert.deepEqual(switcherPagePermissions(undefined), {
    canManageSwitcher: false,
    canMapSwitcher: false,
    canReadSwitcher: false,
  });

  assert.deepEqual(switcherPagePermissions(user(["switcher:read"])), {
    canManageSwitcher: false,
    canMapSwitcher: false,
    canReadSwitcher: true,
  });

  assert.deepEqual(switcherPagePermissions(user(["switcher:read", "switcher:map"])), {
    canManageSwitcher: false,
    canMapSwitcher: true,
    canReadSwitcher: true,
  });

  assert.equal(switcherPagePermissions(user(["switcher:manage"])).canManageSwitcher, true);
});

test("mode tone maps enforce/observe/disabled to distinct tones", () => {
  assert.equal(switcherModeTone("enforce"), "healthy");
  assert.equal(switcherModeTone("observe"), "warning");
  assert.equal(switcherModeTone("disabled"), "neutral");
});

test("test summary reports reachability with firmware and route counts", () => {
  assert.equal(
    switcherTestSummary({
      firmware: "1.31",
      model: "avpro-ac-max",
      ok: true,
      reachable: true,
      routeCount: 24,
    }),
    "Reachable — firmware 1.31, 24 routes",
  );
  assert.equal(
    switcherTestSummary({ model: "avpro-ac-max", ok: true, reachable: true }),
    "Reachable",
  );
  assert.equal(
    switcherTestSummary({
      message: "switcher_connect_timeout",
      model: "avpro-ac-max",
      ok: false,
      reachable: false,
    }),
    "switcher_connect_timeout",
  );
});

function user(permissions: CurrentUser["permissions"]): CurrentUser {
  return {
    email: "ops@example.test",
    groups: [],
    id: "user_test",
    name: "Ops",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
