import type { HealthEvent, HealthEventStatusSummary } from "@rakkr/shared";

/**
 * Status breakdown for the health summary tiles. Computed over the full filtered
 * event set (not the paginated page) so the tiles reflect every matching event —
 * a page-derived count undercounts once matches exceed the page size. Mirrors
 * `recordingJobStatusSummary`.
 */
export function healthEventStatusSummary(events: readonly HealthEvent[]): HealthEventStatusSummary {
  return {
    activeCritical: events.filter(
      (event) => event.severity === "critical" && event.status !== "resolved",
    ).length,
    open: events.filter((event) => event.status === "open").length,
    resolved: events.filter((event) => event.status === "resolved").length,
    suppressed: events.filter((event) => event.status === "suppressed").length,
    total: events.length,
  };
}
