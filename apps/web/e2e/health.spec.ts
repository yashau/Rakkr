import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test("health workbench renders a data table with server-side pagination", async ({
  page,
  request,
}) => {
  await loginAndOpen(page, request, "/health");

  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Severity" })).toBeVisible();
  await expect(page.getByText(/Showing \d+|No results/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/health-data-table.png` });
});

test("health pagination changes the server query", async ({ page, request }) => {
  await loginAndOpen(page, request, "/health");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText(/Showing 1[–-]|No results/)).toBeVisible();

  const next = page.getByRole("link", { name: /next/i });
  test.skip(
    (await next.getAttribute("aria-disabled")) === "true",
    "Only one page of health events in this environment",
  );

  const [request_] = await Promise.all([
    page.waitForRequest(/\/api\/v1\/health-events\?.*offset=/),
    next.click(),
  ]);

  expect(request_.url()).toMatch(/offset=/);
});
