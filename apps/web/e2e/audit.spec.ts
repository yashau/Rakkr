import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test("audit trail renders a data table with server-side pagination", async ({ page, request }) => {
  await loginAndOpen(page, request, "/audit");

  // The shadcn data table renders (column headers visible).
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Action" })).toBeVisible();

  // The pagination footer is present (driven by the server `meta`).
  await expect(page.getByText(/Showing \d+|No results/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/audit-data-table.png` });
});

test("audit pagination changes the server query", async ({ page, request }) => {
  await loginAndOpen(page, request, "/audit");
  await expect(page.getByRole("table")).toBeVisible();
  // Wait for the first page to actually load (meta-driven summary) before
  // inspecting the Next control, otherwise we race the loading skeleton.
  await expect(page.getByText(/Showing 1[–-]/)).toBeVisible();

  const next = page.getByRole("link", { name: /next/i });
  const nextDisabled = (await next.getAttribute("aria-disabled")) === "true";

  // Only assert paging behavior when there is more than one page of events.
  test.skip(nextDisabled, "Only one page of audit events in this environment");

  const [request_] = await Promise.all([
    page.waitForRequest(/\/api\/v1\/audit-events\?.*offset=/),
    next.click(),
  ]);

  expect(request_.url()).toMatch(/offset=/);
});

test("audit page size selector drives the limit query param", async ({ page, request }) => {
  await loginAndOpen(page, request, "/audit");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText(/Showing 1[–-]50 of/)).toBeVisible();

  // Select a smaller page size and assert the server-driven summary shrinks to
  // it (asserting the observable outcome is robust against background refetches).
  await page.getByRole("combobox", { name: "Rows per page" }).click();
  await page.getByRole("option", { name: "25", exact: true }).click();

  await expect(page.getByText(/Showing 1[–-]25 of/)).toBeVisible();
});
