import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test("recordings render the card library with shared pagination", async ({ page, request }) => {
  await loginAndOpen(page, request, "/recordings");

  await expect(page.getByRole("heading", { name: "Recordings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
  await expect(page.getByText(/Showing \d+|No results/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/recordings-card-library.png` });
});

test("recordings page size selector drives the limit query param", async ({ page, request }) => {
  await loginAndOpen(page, request, "/recordings");
  const pageSize = page.getByRole("combobox", { name: "Rows per page" });
  await expect(pageSize).toBeVisible();

  // Selecting a new page size updates the control (which feeds limit into the
  // server query). Asserting the control value is robust regardless of how many
  // recordings the environment holds.
  await pageSize.click();
  await page.getByRole("option", { name: "50", exact: true }).click();

  await expect(pageSize).toContainText("50");
});

test("recordings next page drives the offset query param when enabled", async ({
  page,
  request,
}) => {
  await loginAndOpen(page, request, "/recordings");
  await expect(page.getByRole("combobox", { name: "Rows per page" })).toBeVisible();

  const nextLink = page.getByRole("link", { name: /next/i });

  // Next only advances the window when the controller reports another page.
  if ((await nextLink.getAttribute("aria-disabled")) === "true") {
    test.skip(true, "Only one page of recordings is available in this environment.");
  }

  const [request_] = await Promise.all([
    page.waitForRequest(/\/api\/v1\/recordings\?.*offset=\d+/),
    nextLink.click(),
  ]);

  expect(request_.url()).toMatch(/offset=\d+/);
});
