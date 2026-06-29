import assert from "node:assert/strict";
import test from "node:test";

import { buildPaginationMeta, PAGE_POLICY, paginate, parsePagination } from "../src/pagination.js";

test("parsePagination applies the resource default limit when unset", () => {
  assert.deepEqual(parsePagination({}, PAGE_POLICY.default), { limit: 50, offset: 0 });
  assert.deepEqual(parsePagination({}, PAGE_POLICY.audit), { limit: 100, offset: 0 });
});

test("parsePagination clamps limit to the policy ceiling and floors offset", () => {
  assert.deepEqual(parsePagination({ limit: 9999, offset: 40 }, PAGE_POLICY.default), {
    limit: 200,
    offset: 40,
  });
  assert.deepEqual(parsePagination({ limit: 5, offset: -3 }, PAGE_POLICY.audit), {
    limit: 5,
    offset: 0,
  });
});

test("buildPaginationMeta computes page flags from total/offset/returned", () => {
  assert.deepEqual(buildPaginationMeta({ limit: 25, offset: 0, returned: 25, total: 80 }), {
    hasNextPage: true,
    hasPreviousPage: false,
    limit: 25,
    offset: 0,
    returned: 25,
    total: 80,
  });
  assert.deepEqual(buildPaginationMeta({ limit: 25, offset: 75, returned: 5, total: 80 }), {
    hasNextPage: false,
    hasPreviousPage: true,
    limit: 25,
    offset: 75,
    returned: 5,
    total: 80,
  });
});

test("paginate without a limit returns every item and an unbounded meta", () => {
  const items = [1, 2, 3];

  assert.deepEqual(paginate(items, {}), {
    data: [1, 2, 3],
    meta: { hasNextPage: false, hasPreviousPage: false, offset: 0, returned: 3, total: 3 },
  });
});

test("paginate slices by limit/offset and reports stable totals", () => {
  const items = Array.from({ length: 10 }, (_, index) => index);

  const page = paginate(items, { limit: 4, offset: 4 });
  assert.deepEqual(page.data, [4, 5, 6, 7]);
  assert.deepEqual(page.meta, {
    hasNextPage: true,
    hasPreviousPage: true,
    limit: 4,
    offset: 4,
    returned: 4,
    total: 10,
  });
});

test("paginate past the end returns an empty page with the real total", () => {
  const items = [1, 2, 3];

  const page = paginate(items, { limit: 5, offset: 10 });
  assert.deepEqual(page.data, []);
  assert.equal(page.meta.total, 3);
  assert.equal(page.meta.hasNextPage, false);
  assert.equal(page.meta.hasPreviousPage, true);
});
