import assert from "node:assert/strict";
import test from "node:test";

import {
  currentPageFromOffset,
  offsetForPage,
  paginationSummary,
  shallowFiltersEqual,
} from "./server-pagination";

test("offsetForPage and currentPageFromOffset round-trip", () => {
  assert.equal(offsetForPage(1, 25), 0);
  assert.equal(offsetForPage(3, 25), 50);
  assert.equal(currentPageFromOffset(0, 25), 1);
  assert.equal(currentPageFromOffset(50, 25), 3);
  assert.equal(currentPageFromOffset(60, 25), 3);
});

test("currentPageFromOffset guards against a zero limit", () => {
  assert.equal(currentPageFromOffset(40, 0), 1);
});

test("paginationSummary reports 1-based from/to over the total", () => {
  assert.deepEqual(
    paginationSummary({
      hasNextPage: true,
      hasPreviousPage: false,
      limit: 25,
      offset: 0,
      returned: 25,
      total: 80,
    }),
    { from: 1, to: 25, total: 80 },
  );
  assert.deepEqual(
    paginationSummary({
      hasNextPage: false,
      hasPreviousPage: true,
      limit: 25,
      offset: 75,
      returned: 5,
      total: 80,
    }),
    { from: 76, to: 80, total: 80 },
  );
});

test("paginationSummary is empty-safe", () => {
  assert.deepEqual(paginationSummary(undefined), { from: 0, to: 0, total: 0 });
  assert.deepEqual(
    paginationSummary({
      hasNextPage: false,
      hasPreviousPage: false,
      offset: 0,
      returned: 0,
      total: 0,
    }),
    { from: 0, to: 0, total: 0 },
  );
});

test("shallowFiltersEqual compares filter drafts by value", () => {
  assert.equal(shallowFiltersEqual({ status: "open", q: "" }, { status: "open", q: "" }), true);
  assert.equal(shallowFiltersEqual({ status: "open" }, { status: "resolved" }), false);
  assert.equal(shallowFiltersEqual({ status: "open" }, { status: "open", q: "x" }), false);
});
