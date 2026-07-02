// Theme preference persisted by next-themes. "system" (the default) follows the
// OS `prefers-color-scheme`; "light"/"dark" are explicit operator overrides.
export type ThemePreference = "dark" | "light" | "system";

// The explicit theme to persist when the dark-mode switch is flipped. The switch
// is binary, so toggling it always writes an explicit override — "system" only
// survives while the switch is left untouched from a fresh (unstored) state.
export function themeForToggle(nextIsDark: boolean): "dark" | "light" {
  return nextIsDark ? "dark" : "light";
}

// Whether the dark-mode switch should read as "on". Driven by the *resolved*
// theme (system → the concrete light/dark the OS resolved to) so the switch
// reflects what the operator actually sees, including under "system".
export function isDarkResolved(resolvedTheme: string | undefined): boolean {
  return resolvedTheme === "dark";
}
