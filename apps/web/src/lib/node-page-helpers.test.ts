import assert from "node:assert/strict";
import test from "node:test";
import type { Permission } from "@rakkr/shared";

import { nodePageActionPermissions, rotateNodeTokenTitle } from "./node-page-helpers";

test("node page action permissions split listen and management actions", () => {
  assert.deepEqual(nodePageActionPermissions(["node:read"]), {
    canListen: false,
    canManage: false,
  });
  assert.deepEqual(nodePageActionPermissions(["node:read", "listen:monitor"]), {
    canListen: true,
    canManage: false,
  });
  assert.deepEqual(nodePageActionPermissions(["node:manage"] satisfies Permission[]), {
    canListen: false,
    canManage: true,
  });
});

test("node token rotation titles explain permission and persistence state", () => {
  assert.equal(rotateNodeTokenTitle(false, true), "Requires node manage");
  assert.equal(rotateNodeTokenTitle(true, false), "Demo node tokens are not persisted");
  assert.equal(rotateNodeTokenTitle(true, true), "Rotate node token");
});
