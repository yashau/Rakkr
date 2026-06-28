export type StatusTone = "critical" | "healthy" | "info" | "neutral" | "warning";

/**
 * Canonical outline-badge color classes by status tone. Centralizes the
 * rose/amber/emerald/sky/slate ladders that were previously re-declared across
 * many components so status colors stay consistent app-wide.
 */
export function toneBadgeClass(tone: StatusTone): string {
  if (tone === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (tone === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (tone === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (tone === "info") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

/**
 * Larger summary-tile variant of the status tones (darker text-800 on the same
 * tinted background). Neutral falls back to the plain bordered surface.
 */
export function toneTileClass(tone: StatusTone): string {
  if (tone === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }

  if (tone === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }

  if (tone === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }

  if (tone === "info") {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }

  return "border-border bg-background text-foreground";
}
