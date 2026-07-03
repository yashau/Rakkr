import assert from "node:assert/strict";
import test from "node:test";

import { isPgConstraintError, isPgErrorCode } from "../src/auth-utils.js";

test("isPgErrorCode walks the drizzle cause chain", () => {
  assert.equal(isPgErrorCode({ code: "23503" }, "23503"), true);
  // Drizzle wraps the driver PostgresError as `.cause` ("Failed query: …").
  assert.equal(isPgErrorCode({ cause: { code: "23503" } }, "23503"), true);
  assert.equal(isPgErrorCode({ cause: { code: "23505" } }, "23503"), false);
  assert.equal(isPgErrorCode(new Error("plain"), "23503"), false);
  assert.equal(isPgErrorCode(undefined, "23503"), false);
});

test("isPgConstraintError classifies data/integrity violations, not connectivity", () => {
  // SQLSTATE class 22 (data exception) + 23 (integrity constraint) => constraint.
  assert.equal(isPgConstraintError({ code: "22001" }), true); // string too long
  assert.equal(isPgConstraintError({ code: "23505" }), true); // unique
  assert.equal(isPgConstraintError({ code: "23502" }), true); // not null
  assert.equal(isPgConstraintError({ cause: { code: "23503" } }), true); // drizzle-wrapped FK
  // Connectivity / operational errors are NOT constraint errors (must still latch).
  assert.equal(isPgConstraintError({ code: "08006" }), false); // connection failure
  assert.equal(isPgConstraintError({ code: "57P01" }), false); // admin shutdown
  assert.equal(isPgConstraintError(new Error("ECONNREFUSED")), false);
  assert.equal(isPgConstraintError(undefined), false);
});
