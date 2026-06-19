import type { NodeStatus } from "@rakkr/shared";

export function nodeStatusBadgeClass(status: NodeStatus | undefined) {
  if (status === "online") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "recording") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (status === "degraded") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (status === "alerting") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}
