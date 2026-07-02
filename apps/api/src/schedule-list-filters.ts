import type { Context } from "hono";
import type { ScheduleSummary } from "@rakkr/shared";

import type { AppBindings } from "./http-types.js";
import { captureBackendFromQuery, enabledFromQuery, trimmed } from "./schedule-route-helpers.js";

export interface ScheduleFilters {
  captureBackend?: NonNullable<ScheduleSummary["captureBackend"]>;
  captureInterfaceId?: string;
  enabled?: boolean;
  nodeId?: string;
  search?: string;
}

export function scheduleFilters(c: Context<AppBindings>): ScheduleFilters {
  const captureBackend = captureBackendFromQuery(c.req.query("captureBackend"));
  const captureInterfaceId = trimmed(c.req.query("captureInterfaceId"));
  const enabled = enabledFromQuery(c.req.query("enabled"));
  const nodeId = trimmed(c.req.query("nodeId"));
  const search = trimmed(c.req.query("search"));

  return {
    captureBackend,
    captureInterfaceId,
    enabled,
    nodeId,
    search,
  };
}

export function filterSchedules(schedules: ScheduleSummary[], filters: ScheduleFilters) {
  const search = filters.search?.toLowerCase();

  return schedules.filter((schedule) => {
    if (filters.enabled !== undefined && schedule.enabled !== filters.enabled) {
      return false;
    }

    if (filters.nodeId && schedule.nodeId !== filters.nodeId) {
      return false;
    }

    if (filters.captureBackend && schedule.captureBackend !== filters.captureBackend) {
      return false;
    }

    if (filters.captureInterfaceId && schedule.captureInterfaceId !== filters.captureInterfaceId) {
      return false;
    }

    return search ? scheduleSearchText(schedule).includes(search) : true;
  });
}

function scheduleSearchText(schedule: ScheduleSummary) {
  return [
    schedule.captureBackend,
    schedule.captureInterfaceId,
    schedule.folderTemplate,
    schedule.id,
    schedule.name,
    schedule.nodeId,
    schedule.recordingProfileId,
    schedule.retentionPolicyId,
    schedule.room,
    schedule.tags.join(" "),
    schedule.timezone,
    schedule.titleTemplate,
    schedule.uploadPolicyIds.join(" "),
    schedule.watchdogPolicyId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
