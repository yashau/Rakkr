import type { ScheduleInput } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";
import { findRetentionPolicy } from "./retention-policies.js";
import type { SettingsStore } from "./settings-store.js";
import {
  profileSettingsTarget,
  retentionPolicySettingsTarget,
  uploadPolicySettingsTarget,
  watchdogSettingsTarget,
} from "./settings-scope.js";
import { findUploadPolicy } from "./upload-policies.js";

export type ScheduleSettingsSelection = Partial<
  Pick<
    ScheduleInput,
    "recordingProfileId" | "retentionPolicyId" | "uploadPolicyIds" | "watchdogPolicyId"
  >
>;

export async function scheduleSettingsSelectionFailure(
  user: NonNullable<AuthResult["user"]>,
  selection: ScheduleSettingsSelection,
  dependencies: {
    hasResourceScope: (
      user: NonNullable<AuthResult["user"]>,
      target: AuditTarget,
    ) => Promise<boolean>;
    settingsStore: SettingsStore;
  },
) {
  if (selection.recordingProfileId !== undefined) {
    const profile = await dependencies.settingsStore.findRecordingProfile(
      selection.recordingProfileId,
    );

    if (!profile) {
      return settingsNotFound("recording_profile_not_found", {
        id: selection.recordingProfileId,
        type: "recording_profile",
      });
    }

    const target = profileSettingsTarget(profile);

    if (!(await dependencies.hasResourceScope(user, target))) {
      return settingsHidden(target);
    }
  }

  if (selection.watchdogPolicyId !== undefined) {
    const policy = await dependencies.settingsStore.findWatchdogPolicy(selection.watchdogPolicyId);

    if (!policy) {
      return settingsNotFound("watchdog_policy_not_found", {
        id: selection.watchdogPolicyId,
        type: "watchdog_policy",
      });
    }

    const target = watchdogSettingsTarget(policy);

    if (!(await dependencies.hasResourceScope(user, target))) {
      return settingsHidden(target);
    }
  }

  if (selection.retentionPolicyId !== undefined) {
    const policy = await findRetentionPolicy(selection.retentionPolicyId);

    if (!policy) {
      return settingsNotFound("retention_policy_not_found", {
        id: selection.retentionPolicyId,
        type: "retention_policy",
      });
    }

    const target = retentionPolicySettingsTarget(policy);

    if (!(await dependencies.hasResourceScope(user, target))) {
      return settingsHidden(target);
    }
  }

  if (selection.uploadPolicyIds !== undefined) {
    for (const uploadPolicyId of selection.uploadPolicyIds) {
      const policy = await findUploadPolicy(uploadPolicyId);

      if (!policy) {
        return settingsNotFound("upload_policy_not_found", {
          id: uploadPolicyId,
          type: "upload_policy",
        });
      }

      const target = uploadPolicySettingsTarget(policy);

      if (!(await dependencies.hasResourceScope(user, target))) {
        return settingsHidden(target);
      }
    }
  }

  return undefined;
}

function settingsHidden(target: AuditTarget) {
  return {
    error: "Forbidden",
    reason: "missing_resource_scope",
    status: 403 as const,
    target,
  };
}

function settingsNotFound(reason: string, target: AuditTarget) {
  return {
    error: "Schedule settings resource not found",
    reason,
    status: 404 as const,
    target,
  };
}
