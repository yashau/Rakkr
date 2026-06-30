import type { ScheduleSummary } from "@rakkr/shared";
import { neutralizeCsvFormula } from "./csv.js";

export function schedulesCsv(schedules: ScheduleSummary[]) {
  return [
    csvRow([
      "id",
      "name",
      "enabled",
      "nodeId",
      "room",
      "timezone",
      "nextRunAt",
      "captureBackend",
      "captureInterfaceId",
      "recordingProfileId",
      "watchdogPolicyId",
      "retentionPolicyId",
      "uploadPolicyIds",
      "tags",
    ]),
    ...schedules.map((schedule) =>
      csvRow([
        schedule.id,
        schedule.name,
        String(schedule.enabled),
        schedule.nodeId,
        schedule.room,
        schedule.timezone,
        schedule.nextRunAt ?? "",
        schedule.captureBackend ?? "",
        schedule.captureInterfaceId ?? "",
        schedule.recordingProfileId ?? "",
        schedule.watchdogPolicyId ?? "",
        schedule.retentionPolicyId ?? "",
        schedule.uploadPolicyIds.join(";"),
        schedule.tags.join(";"),
      ]),
    ),
  ].join("\n");
}

export function scheduleExportFileName() {
  return `rakkr-schedules-${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}.csv`;
}

function csvRow(values: string[]) {
  return values.map(csvCell).join(",");
}

function csvCell(value: string) {
  return `"${neutralizeCsvFormula(value).replaceAll('"', '""')}"`;
}
