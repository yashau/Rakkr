import type {
  ChannelMapAssignmentPlan,
  ChannelMapAssignmentPlanInput,
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  ChannelMapTemplateAssignmentBulkInput,
  ChannelMapTemplateAssignmentInput,
  ChannelMapTemplateAssignmentRollbackInput,
  ChannelMapTemplateInput,
  ChannelMapTemplateUpdate,
  ControllerSettings,
  ControllerSettingsUpdate,
  RecordingProfile,
  RecordingProfileUpdate,
  RetentionPolicy,
  RetentionPolicyInput,
  RetentionPolicyUpdate,
  SwitcherConnectionTest,
  SwitcherCreate,
  SwitcherMappingOptions,
  SwitcherMappings,
  SwitcherMappingsUpdate,
  SwitcherStatus,
  SwitcherUpdate,
  UploadDestinationInput,
  UploadDestinationRuntimeStatus,
  UploadDestinationUpdate,
  UploadPolicy,
  UploadPolicyInput,
  UploadPolicyUpdate,
  WatchdogPolicy,
  WatchdogPolicyUpdate,
} from "@rakkr/shared";

import { fetchJson } from "./api-http";
import type { WatchdogCalibrationInput, WatchdogCalibrationResult } from "./api-types";

const jsonHeaders = { "Content-Type": "application/json" };

// Settings client (controller settings, recording profiles, upload destinations/policies,
// switchers, retention/watchdog policies, channel-map templates/assignments/plans). Kept out of
// api.ts to stay within the LOC budget; spread into the main `api` object so call sites stay
// `api.controllerSettings(...)`.
export const settingsApi = {
  controllerSettings: () => fetchJson<{ data: ControllerSettings }>("/api/v1/settings/controller"),
  updateControllerSettings: (input: ControllerSettingsUpdate) =>
    fetchJson<{ data: ControllerSettings }>("/api/v1/settings/controller", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  recordingProfiles: () =>
    fetchJson<{ data: RecordingProfile[] }>("/api/v1/settings/recording-profiles"),
  uploadDestinations: () =>
    fetchJson<{ data: UploadDestinationRuntimeStatus[] }>("/api/v1/settings/upload-destinations"),
  uploadPolicies: () => fetchJson<{ data: UploadPolicy[] }>("/api/v1/settings/upload-policies"),
  retentionPolicies: () =>
    fetchJson<{ data: RetentionPolicy[] }>("/api/v1/settings/retention-policies"),
  watchdogPolicies: () =>
    fetchJson<{ data: WatchdogPolicy[] }>("/api/v1/settings/watchdog-policies"),
  channelMapTemplates: () =>
    fetchJson<{ data: ChannelMapTemplate[] }>("/api/v1/settings/channel-map-templates"),
  channelMapAssignments: () =>
    fetchJson<{ data: ChannelMapTemplateAssignment[] }>("/api/v1/settings/channel-map-assignments"),
  channelMapAssignmentPlans: () =>
    fetchJson<{ data: ChannelMapAssignmentPlan[] }>(
      "/api/v1/settings/channel-map-assignment-plans",
    ),
  createChannelMapTemplate: (input: ChannelMapTemplateInput) =>
    fetchJson<{ data: ChannelMapTemplate }>("/api/v1/settings/channel-map-templates", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  updateChannelMapTemplate: (templateId: string, input: ChannelMapTemplateUpdate) =>
    fetchJson<{ data: ChannelMapTemplate }>(
      `/api/v1/settings/channel-map-templates/${templateId}`,
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      },
    ),
  assignChannelMapTemplate: (input: ChannelMapTemplateAssignmentInput) =>
    fetchJson<{ data: ChannelMapTemplateAssignment }>("/api/v1/settings/channel-map-assignments", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PUT",
    }),
  bulkAssignChannelMapTemplate: (input: ChannelMapTemplateAssignmentBulkInput) =>
    fetchJson<{ data: ChannelMapTemplateAssignment[] }>(
      "/api/v1/settings/channel-map-assignments/bulk",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PUT",
      },
    ),
  createChannelMapAssignmentPlan: (input: ChannelMapAssignmentPlanInput) =>
    fetchJson<{ data: ChannelMapAssignmentPlan }>("/api/v1/settings/channel-map-assignment-plans", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  applyChannelMapAssignmentPlan: (planId: string) =>
    fetchJson<{
      data: {
        assignments: ChannelMapTemplateAssignment[];
        plan: ChannelMapAssignmentPlan | undefined;
      };
    }>(`/api/v1/settings/channel-map-assignment-plans/${planId}/apply`, {
      method: "POST",
    }),
  rollbackChannelMapAssignment: (input: ChannelMapTemplateAssignmentRollbackInput) =>
    fetchJson<{ data: ChannelMapTemplateAssignment }>(
      "/api/v1/settings/channel-map-assignments/rollback",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  createRecordingProfile: (input: Omit<RecordingProfile, "id">) =>
    fetchJson<{ data: RecordingProfile }>("/api/v1/settings/recording-profiles", {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "POST",
    }),
  updateRecordingProfile: (profileId: string, input: RecordingProfileUpdate) =>
    fetchJson<{ data: RecordingProfile }>(`/api/v1/settings/recording-profiles/${profileId}`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PATCH",
    }),
  createUploadDestination: (input: UploadDestinationInput) =>
    fetchJson<{ data: UploadDestinationRuntimeStatus }>("/api/v1/settings/upload-destinations", {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "POST",
    }),
  updateUploadDestination: (id: string, input: UploadDestinationUpdate) =>
    fetchJson<{ data: UploadDestinationRuntimeStatus }>(
      `/api/v1/settings/upload-destinations/${id}`,
      { body: JSON.stringify(input), headers: jsonHeaders, method: "PATCH" },
    ),
  deleteUploadDestination: (id: string) =>
    fetchJson<{ data: { id: string } }>(`/api/v1/settings/upload-destinations/${id}`, {
      method: "DELETE",
    }),
  switchers: () => fetchJson<{ data: SwitcherStatus[] }>("/api/v1/settings/switchers"),
  createSwitcher: (input: SwitcherCreate) =>
    fetchJson<{ data: SwitcherStatus }>("/api/v1/settings/switchers", {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "POST",
    }),
  updateSwitcher: (id: string, input: SwitcherUpdate) =>
    fetchJson<{ data: SwitcherStatus }>(`/api/v1/settings/switchers/${id}`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PATCH",
    }),
  deleteSwitcher: (id: string) =>
    fetchJson<{ data: { id: string } }>(`/api/v1/settings/switchers/${id}`, { method: "DELETE" }),
  testSwitcher: (id: string) =>
    fetchJson<{ data: SwitcherConnectionTest }>(`/api/v1/settings/switchers/${id}/test`, {
      method: "POST",
    }),
  switcherMappings: (id: string) =>
    fetchJson<{ data: SwitcherMappings }>(`/api/v1/settings/switchers/${id}/mappings`),
  updateSwitcherMappings: (id: string, input: SwitcherMappingsUpdate) =>
    fetchJson<{ data: SwitcherMappings }>(`/api/v1/settings/switchers/${id}/mappings`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PUT",
    }),
  switcherMappingOptions: () =>
    fetchJson<{ data: SwitcherMappingOptions }>("/api/v1/settings/switcher-mapping-options"),
  createUploadPolicy: (input: UploadPolicyInput) =>
    fetchJson<{ data: UploadPolicy }>("/api/v1/settings/upload-policies", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  updateUploadPolicy: (policyId: string, input: UploadPolicyUpdate) =>
    fetchJson<{ data: UploadPolicy }>(`/api/v1/settings/upload-policies/${policyId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  createRetentionPolicy: (input: RetentionPolicyInput) =>
    fetchJson<{ data: RetentionPolicy }>("/api/v1/settings/retention-policies", {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "POST",
    }),
  updateRetentionPolicy: (policyId: string, input: RetentionPolicyUpdate) =>
    fetchJson<{ data: RetentionPolicy }>(`/api/v1/settings/retention-policies/${policyId}`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PATCH",
    }),
  createWatchdogPolicy: (input: Omit<WatchdogPolicy, "id">) =>
    fetchJson<{ data: WatchdogPolicy }>("/api/v1/settings/watchdog-policies", {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "POST",
    }),
  updateWatchdogPolicy: (policyId: string, input: WatchdogPolicyUpdate) =>
    fetchJson<{ data: WatchdogPolicy }>(`/api/v1/settings/watchdog-policies/${policyId}`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PATCH",
    }),
  calibrateWatchdogPolicy: (policyId: string, input: WatchdogCalibrationInput) =>
    fetchJson<{ data: { calibration: WatchdogCalibrationResult; policy?: WatchdogPolicy } }>(
      `/api/v1/settings/watchdog-policies/${policyId}/calibrations`,
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
};
