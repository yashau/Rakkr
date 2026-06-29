import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test("access users render a data table with server-side pagination", async ({ page, request }) => {
  await loginAndOpen(page, request, "/access");

  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Email" })).toBeVisible();
  await expect(page.getByText(/Showing \d+|No results/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/access-data-table.png` });
});

test("access users page size selector drives the limit query param", async ({ page, request }) => {
  await loginAndOpen(page, request, "/access");
  await expect(page.getByRole("table")).toBeVisible();

  const [request_] = await Promise.all([
    page.waitForRequest(/\/api\/v1\/auth\/users\?.*limit=25/),
    page
      .getByRole("combobox", { name: "Rows per page" })
      .click()
      .then(() => page.getByRole("option", { name: "25" }).click()),
  ]);

  expect(request_.url()).toMatch(/limit=25/);
});
