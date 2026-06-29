import { expect, test } from "@playwright/test";

import { loginAndOpen } from "./helpers";

const screenshotDir = "e2e/screenshots";

test.beforeEach(async ({ page, request }) => {
  await loginAndOpen(page, request, "/");
  // The dashboard summary cards confirm the authenticated shell has rendered.
  await expect(page.getByText("Online nodes")).toBeVisible();
});

test("recording start panel does not overflow or overlap", async ({ page }) => {
  const form = page.locator("form", { has: page.locator("#recording-start-node") });
  await expect(form).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/dashboard-full.png`, fullPage: true });
  await form.screenshot({ path: `${screenshotDir}/recording-start-panel.png` });

  const triggerIds = [
    "recording-start-node",
    "recording-start-backend",
    "recording-start-interface",
    "recording-start-profile",
    "recording-start-upload-policy",
  ];

  const diagnostics = await page.evaluate((ids) => {
    const formEl = document.querySelector<HTMLFormElement>("form:has(#recording-start-node)");
    const formRect = formEl?.getBoundingClientRect();

    const triggers = ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) {
        return { id, present: false };
      }
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const valueSpan = el.querySelector("span");
      const spanStyle = valueSpan ? getComputedStyle(valueSpan) : undefined;

      return {
        id,
        present: true,
        text: valueSpan?.textContent ?? el.textContent,
        triggerWidth: Math.round(rect.width),
        triggerScrollWidth: el.scrollWidth,
        overflowsTrigger: el.scrollWidth > Math.ceil(rect.width) + 1,
        // Does the trigger spill past the right edge of the form?
        overflowsForm: formRect ? rect.right > formRect.right + 1 : null,
        trigger: {
          display: style.display,
          minWidth: style.minWidth,
          overflow: style.overflowX,
          whiteSpace: style.whiteSpace,
        },
        valueSpan: valueSpan
          ? {
              clientWidth: valueSpan.clientWidth,
              scrollWidth: valueSpan.scrollWidth,
              truncated: valueSpan.scrollWidth > valueSpan.clientWidth + 1,
              minWidth: spanStyle?.minWidth,
              overflow: spanStyle?.overflowX,
              lineClamp: spanStyle?.webkitLineClamp,
            }
          : null,
      };
    });

    const formStyle = formEl ? getComputedStyle(formEl) : undefined;

    return {
      pageOverflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth + 1,
      innerWidth: window.innerWidth,
      formGridTemplateColumns: formStyle?.gridTemplateColumns,
      formDisplay: formStyle?.display,
      form: formRect
        ? {
            width: Math.round(formRect.width),
            scrollWidth: formEl?.scrollWidth,
            overflows: (formEl?.scrollWidth ?? 0) > Math.ceil(formRect.width) + 1,
          }
        : null,
      triggers,
    };
  }, triggerIds);

  // Surfaced in the Playwright `list` reporter output for diagnosis.
  console.log("RECORDING_START_DIAGNOSTICS " + JSON.stringify(diagnostics, null, 2));

  // Regression guards (soft so screenshots + diagnostics are always produced).
  expect.soft(diagnostics.pageOverflowsHorizontally, "page overflows horizontally").toBe(false);
  expect.soft(diagnostics.form?.overflows, "start-panel form overflows its width").toBe(false);
  for (const trigger of diagnostics.triggers) {
    expect.soft(trigger.overflowsForm, `${trigger.id} spills past the form`).not.toBe(true);
  }
});
