import type { UploadProviderRuntimeStatus } from "@rakkr/shared";

import { toneBadgeClass } from "@/lib/status-colors";

export function uploadProviderStatusClass(status: UploadProviderRuntimeStatus["status"]) {
  if (status === "ready") {
    return toneBadgeClass("healthy");
  }

  if (status === "disabled") {
    return toneBadgeClass("neutral");
  }

  if (status === "not_configured") {
    return toneBadgeClass("warning");
  }

  return toneBadgeClass("critical");
}
