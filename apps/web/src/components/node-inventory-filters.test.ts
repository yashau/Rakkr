import assert from "node:assert/strict";
import test from "node:test";
import { nodeStatusSchema } from "@rakkr/shared";

import { nodeStatuses } from "./node-inventory-filters";

test("node status filter offers every node status, including provisioning", () => {
  // The dropdown must enumerate the full NodeStatus enum so no cohort (notably
  // the enrolled-but-never-contacted `provisioning` nodes) becomes unfilterable.
  assert.deepEqual([...nodeStatuses].sort(), [...nodeStatusSchema.options].sort());
  assert.ok(nodeStatuses.includes("provisioning"));
});
