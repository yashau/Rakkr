import type { UploadProviderRuntimeStatus } from "@rakkr/shared";

export function uploadProviderStatusClass(status: UploadProviderRuntimeStatus["status"]) {
  if (status === "ready") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "disabled") {
    return "border-slate-200 bg-slate-50 text-slate-700";
  }

  if (status === "not_configured") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-rose-200 bg-rose-50 text-rose-700";
}
