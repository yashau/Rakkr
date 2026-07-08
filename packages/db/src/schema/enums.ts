import { pgEnum } from "drizzle-orm/pg-core";

export const nodeStatusEnum = pgEnum("node_status", [
  "provisioning",
  "online",
  "offline",
  "degraded",
  "recording",
  "alerting",
]);

export const healthSeverityEnum = pgEnum("health_severity", ["info", "warning", "critical"]);

export const recordingStatusEnum = pgEnum("recording_status", [
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
  "partial",
]);
export const recordingJobStatusEnum = pgEnum("recording_job_status", [
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);
export const recordingChunkStatusEnum = pgEnum("recording_chunk_status", [
  "capturing",
  "cached",
  "uploading",
  "uploaded",
  "partial",
  "failed",
]);

export const recordingSourceEnum = pgEnum("recording_source", ["ad_hoc", "schedule"]);

export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "allowed",
  "denied",
  "failed",
  "partial",
  "succeeded",
]);
export const accessPolicyEffectEnum = pgEnum("access_policy_effect", ["allow", "deny"]);
export const accessPolicySubjectTypeEnum = pgEnum("access_policy_subject_type", [
  "user",
  "group",
  "everyone",
]);
// Room roster subjects are always explicit (a user or a group); "everyone" is
// deliberately not a roster subject.
export const roomRosterSubjectTypeEnum = pgEnum("room_roster_subject_type", ["user", "group"]);
// Provenance of a roster entry: operator-managed, or materialized from a
// schedule/meeting assignment so calendar-derived grants reconcile independently.
export const roomRosterSourceEnum = pgEnum("room_roster_source", ["manual", "calendar"]);
