import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

// The popover is portalled to the end of <body> by Radix; scope calendar
// queries to it so page-level controls (e.g. the bulk "Clear" button) do not
// collide with the in-popover affordances.
const popover = "[data-radix-popper-content-wrapper]";

test("jobs date filter uses the shadcn calendar popover", async ({ page, request }) => {
  await loginAndOpen(page, request, "/jobs");

  // Secondary filters (incl. the created-from date picker) live in the filter
  // slide-out; open it before driving the calendar.
  await page.getByRole("button", { name: "Filters" }).click();

  // `exact` avoids matching the active-filter chip's "Clear created from filter".
  const trigger = page.getByRole("button", { name: "Created from", exact: true });
  await expect(trigger).toBeVisible();
  // Replaces the old native <input type="date">.
  await expect(page.locator('input[type="date"]')).toHaveCount(0);

  // Opening the trigger reveals the react-day-picker calendar grid.
  await trigger.click();
  const calendar = page.locator(popover);
  await expect(calendar).toBeVisible();
  const dayButtons = calendar.locator("button[data-day]");
  expect(await dayButtons.count()).toBeGreaterThanOrEqual(28);

  await page.screenshot({ path: `${screenshotDir}/date-picker-calendar.png` });

  // Selecting a day writes the ISO date back into the trigger and closes it.
  await dayButtons.filter({ hasText: /^15$/ }).first().click();
  await expect(calendar).toBeHidden();
  await expect(trigger).toHaveText(/^\d{4}-\d{2}-15$/);

  // Re-opening shows a Clear affordance that resets the field.
  await trigger.click();
  await page.locator(popover).getByRole("button", { name: "Clear" }).click();
  await expect(trigger).toHaveText("Pick a date");
});

test("audit date-time filters use a calendar date plus a native time field", async ({
  page,
  request,
}) => {
  await loginAndOpen(page, request, "/audit");

  // The audit filters (incl. the From/To pickers) live in the filter slide-out.
  await page.getByRole("button", { name: "Filters" }).click();

  // From + To each render a calendar-backed date trigger (labelled "From"/"To",
  // showing the "Pick a date" placeholder) plus a native time input. The old
  // native <input type="datetime-local"> is gone.
  const dateTriggers = page.getByRole("button").filter({ hasText: "Pick a date" });
  await expect(dateTriggers).toHaveCount(2);
  await expect(page.locator('input[type="time"]')).toHaveCount(2);
  await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);

  await dateTriggers.first().click();
  const calendar = page.locator(popover);
  await expect(calendar).toBeVisible();
  expect(await calendar.locator("button[data-day]").count()).toBeGreaterThanOrEqual(28);

  await page.screenshot({ path: `${screenshotDir}/date-time-picker.png` });
});
