import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test("recorder nodes render a data table with server-side pagination", async ({
  page,
  request,
}) => {
  await loginAndOpen(page, request, "/nodes");

  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
  await expect(page.getByText(/Showing \d+|No results/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/nodes-data-table.png` });
});

test("recorder nodes page size selector drives the limit query param", async ({
  page,
  request,
}) => {
  await loginAndOpen(page, request, "/nodes");
  await expect(page.getByRole("table")).toBeVisible();

  const [request_] = await Promise.all([
    page.waitForRequest(/\/api\/v1\/nodes\?.*limit=25/),
    page
      .getByRole("combobox", { name: "Rows per page" })
      .click()
      .then(() => page.getByRole("option", { name: "25" }).click()),
  ]);

  expect(request_.url()).toMatch(/limit=25/);
});
