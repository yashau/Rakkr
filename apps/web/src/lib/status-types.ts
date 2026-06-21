import type { RecordingProfile, WatchdogPolicy } from "@rakkr/shared";

export interface ControllerStatus {
  activeRecordings: number;
  acknowledgedAlerts: number;
  alertingNodes: number;
  cachedRecordings: number;
  completedRecordings: number;
  criticalAlerts: number;
  degradedNodes: number;
  failedRecordings: number;
  nodeCount: number;
  offlineNodes: number;
  onlineNodes: number;
  openAlerts: number;
  queuedRecordings: number;
  recordingNodes: number;
  recordingProfile?: RecordingProfile;
  startedAt: string;
  suppressedAlerts: number;
  totalRecordings: number;
  unresolvedAlerts: number;
  uploadedRecordings: number;
  warningAlerts: number;
  watchdogPolicy?: WatchdogPolicy;
}
