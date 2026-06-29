import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test("settings renders configuration data tables", async ({ page, request }) => {
  await loginAndOpen(page, request, "/settings");

  await expect(page.getByRole("heading", { name: "Recording Profiles" })).toBeVisible();
  await expect(page.getByRole("table").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Channel Mode" })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/settings-data-tables.png` });
});
