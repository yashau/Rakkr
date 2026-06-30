import type { UploadProviderStatus } from "@rakkr/shared";

import { toneBadgeClass } from "@/lib/status-colors";

export function uploadProviderStatusClass(status: UploadProviderStatus) {
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
