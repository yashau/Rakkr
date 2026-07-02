import type { CurrentUser, SwitcherConnectionTest, SwitcherMode } from "@rakkr/shared";

import type { StatusTone } from "./status-colors";

export function switcherPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canManageSwitcher: permissions.includes("switcher:manage"),
    canMapSwitcher: permissions.includes("switcher:map"),
    canReadSwitcher: permissions.includes("switcher:read"),
  };
}

// enforce actively drives the hardware (green); observe is a dry-run that only
// audits what it would do (amber); disabled never connects (neutral).
export function switcherModeTone(mode: SwitcherMode): StatusTone {
  if (mode === "enforce") {
    return "healthy";
  }

  if (mode === "observe") {
    return "warning";
  }

  return "neutral";
}

export function switcherTestSummary(test: SwitcherConnectionTest): string {
  if (!test.ok) {
    return test.message ?? "Unreachable";
  }

  const parts: string[] = [];

  if (test.firmware) {
    parts.push(`firmware ${test.firmware}`);
  }

  if (typeof test.routeCount === "number") {
    parts.push(`${test.routeCount} routes`);
  }

  return parts.length > 0 ? `Reachable — ${parts.join(", ")}` : "Reachable";
}
