import assert from "node:assert/strict";
import test from "node:test";
import { isDarkResolved, themeForToggle } from "./theme-helpers";

test("toggling the switch persists an explicit light/dark override", () => {
  assert.equal(themeForToggle(true), "dark");
  assert.equal(themeForToggle(false), "light");
});

test("the switch reads as on only when the resolved theme is dark", () => {
  assert.equal(isDarkResolved("dark"), true);
  assert.equal(isDarkResolved("light"), false);
  // Undefined while the provider is still resolving (pre-mount) → switch off.
  assert.equal(isDarkResolved(undefined), false);
});
