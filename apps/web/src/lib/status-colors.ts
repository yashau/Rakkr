export type StatusTone = "critical" | "healthy" | "info" | "neutral" | "warning";

/**
 * Standalone text/icon color by status tone (no background or border). Use for
 * status icons and inline accents instead of hardcoding `text-emerald-600`
 * ladders, so tones stay consistent with the badge/tile/fill variants.
 */
export function toneTextClass(tone: StatusTone): string {
  if (tone === "critical") {
    return "text-rose-600 dark:text-rose-400";
  }

  if (tone === "warning") {
    return "text-amber-600 dark:text-amber-400";
  }

  if (tone === "healthy") {
    return "text-emerald-600 dark:text-emerald-400";
  }

  if (tone === "info") {
    return "text-sky-600 dark:text-sky-400";
  }

  return "text-muted-foreground";
}

/**
 * Canonical outline-badge color classes by status tone. Centralizes the
 * rose/amber/emerald/sky/slate ladders that were previously re-declared across
 * many components so status colors stay consistent app-wide.
 */
export function toneBadgeClass(tone: StatusTone): string {
  if (tone === "critical") {
    return "border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300";
  }

  if (tone === "warning") {
    return "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300";
  }

  if (tone === "healthy") {
    return "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300";
  }

  if (tone === "info") {
    return "border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300";
  }

  return "border-border bg-muted text-muted-foreground";
}

/**
 * Larger summary-tile variant of the status tones (darker text-800 on the same
 * tinted background). Neutral falls back to the plain bordered surface.
 */
export function toneTileClass(tone: StatusTone): string {
  if (tone === "critical") {
    return "border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200";
  }

  if (tone === "warning") {
    return "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200";
  }

  if (tone === "healthy") {
    return "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200";
  }

  if (tone === "info") {
    return "border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200";
  }

  return "border-border bg-transparent text-foreground";
}

/**
 * Filled-bar variant of the status tones (saturated translucent fill on a
 * tinted border) used for compact timeline segments and severity badges. In
 * dark mode it mirrors {@link toneTileClass} (dark tint + light text + dark
 * border) so the text this class carries on badges stays legible — a saturated
 * mid fill would leave both light and dark text below WCAG AA on dark surfaces.
 */
export function toneFillClass(tone: StatusTone): string {
  if (tone === "critical") {
    return "border-rose-200 dark:border-rose-900 bg-rose-500/80 dark:bg-rose-950/50 text-rose-800 dark:text-rose-200";
  }

  if (tone === "warning") {
    return "border-amber-200 dark:border-amber-900 bg-amber-400/80 dark:bg-amber-950/50 text-amber-800 dark:text-amber-200";
  }

  if (tone === "healthy") {
    return "border-emerald-200 dark:border-emerald-900 bg-emerald-500/70 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200";
  }

  if (tone === "info") {
    return "border-sky-200 dark:border-sky-900 bg-sky-400/75 dark:bg-sky-950/50 text-sky-800 dark:text-sky-200";
  }

  // Neutral: muted fill matching the other tone variants. Previously neutral
  // fell through to the sky "info" fill, mislabeling neutral segments as info
  // (audit R3-2).
  return "border-border bg-muted text-muted-foreground";
}
