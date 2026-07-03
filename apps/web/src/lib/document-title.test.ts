import assert from "node:assert/strict";
import test from "node:test";

import { documentTitle } from "./document-title";

test("documentTitle appends the Rakkr suffix to a page label", () => {
  assert.equal(documentTitle("Dashboard"), "Dashboard - Rakkr");
});

test("documentTitle uses an entity name for detail pages", () => {
  assert.equal(documentTitle("Studio A"), "Studio A - Rakkr");
});

test("documentTitle falls back to Rakkr when the label is missing or blank", () => {
  assert.equal(documentTitle(), "Rakkr");
  assert.equal(documentTitle(undefined), "Rakkr");
  assert.equal(documentTitle(null), "Rakkr");
  assert.equal(documentTitle("   "), "Rakkr");
});

test("documentTitle trims surrounding whitespace", () => {
  assert.equal(documentTitle("  Nodes  "), "Nodes - Rakkr");
});
