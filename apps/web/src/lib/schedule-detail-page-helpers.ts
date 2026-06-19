import type { CurrentUser } from "@rakkr/shared";

export function scheduleDetailPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canAcknowledgeHealth: permissions.includes("health:acknowledge"),
    canDownloadRecordings: permissions.includes("recording:download"),
    canPlaybackRecordings: permissions.includes("recording:playback"),
    canReadAudit: permissions.includes("audit:read"),
    canReadHealth: permissions.includes("health:read"),
    canReadNodes: permissions.includes("node:read"),
    canReadRecordings: permissions.includes("recording:read"),
    canReadSchedule: permissions.includes("schedule:read"),
  };
}
