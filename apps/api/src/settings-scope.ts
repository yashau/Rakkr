import type { RecordingProfile, WatchdogPolicy } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";

export function profileSettingsTarget(profile: Pick<RecordingProfile, "id" | "name">) {
  return {
    id: profile.id,
    name: profile.name,
    type: "recording_profile",
  };
}

export function watchdogSettingsTarget(policy: Pick<WatchdogPolicy, "id" | "name">) {
  return {
    id: policy.id,
    name: policy.name,
    type: "watchdog_policy",
  };
}

export async function scopedRecordingProfiles(
  user: AuthResult["user"],
  settingsStore: SettingsStore,
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const profiles = await settingsStore.listRecordingProfiles();
  const visibleProfiles: RecordingProfile[] = [];

  for (const profile of profiles) {
    if (await hasResourceScope(user, profileSettingsTarget(profile))) {
      visibleProfiles.push(profile);
    }
  }

  return visibleProfiles;
}

export async function scopedWatchdogPolicies(
  user: AuthResult["user"],
  settingsStore: SettingsStore,
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const policies = await settingsStore.listWatchdogPolicies();
  const visiblePolicies: WatchdogPolicy[] = [];

  for (const policy of policies) {
    if (await hasResourceScope(user, watchdogSettingsTarget(policy))) {
      visiblePolicies.push(policy);
    }
  }

  return visiblePolicies;
}
