import assert from "node:assert/strict";
import test from "node:test";
import type { Permission } from "@rakkr/shared";

import { nodePageActionPermissions, rotateNodeTokenTitle } from "./node-page-helpers";

test("node page action permissions split listen and management actions", () => {
  assert.deepEqual(nodePageActionPermissions(["node:read"]), {
    canRead: true,
    canReadHealth: false,
    canListen: false,
    canManage: false,
  });
  assert.deepEqual(nodePageActionPermissions(["health:read", "node:read", "listen:monitor"]), {
    canRead: true,
    canReadHealth: true,
    canListen: true,
    canManage: false,
  });
  assert.deepEqual(nodePageActionPermissions(["node:manage"] satisfies Permission[]), {
    canRead: false,
    canReadHealth: false,
    canListen: false,
    canManage: true,
  });
});

test("node token rotation titles explain permission and persistence state", () => {
  assert.equal(rotateNodeTokenTitle(false, true), "Requires node manage");
  assert.equal(rotateNodeTokenTitle(true, false), "Demo node tokens are not persisted");
  assert.equal(rotateNodeTokenTitle(true, true), "Rotate node token");
});
