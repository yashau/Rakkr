import type {
  ChannelMapTemplate,
  RecordingProfile,
  UploadPolicy,
  UploadProviderRuntimeStatus,
  WatchdogPolicy,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";
import type { UploadProviderStore } from "./upload-providers.js";

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

export function channelMapTemplateSettingsTarget(
  template: Pick<ChannelMapTemplate, "id" | "name">,
) {
  return {
    id: template.id,
    name: template.name,
    type: "channel_map_template",
  };
}

export function uploadProviderSettingsTarget(provider?: UploadProviderRuntimeStatus) {
  return {
    id: provider?.provider,
    name: provider?.displayName,
    type: "upload_provider",
  };
}

export function uploadPolicySettingsTarget(
  policy: Pick<UploadPolicy, "id"> & Partial<Pick<UploadPolicy, "name">>,
) {
  return {
    id: policy.id,
    name: policy.name,
    type: "upload_policy",
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

export async function scopedChannelMapTemplates(
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

  const templates = await settingsStore.listChannelMapTemplates();
  const visibleTemplates: ChannelMapTemplate[] = [];

  for (const template of templates) {
    if (await hasResourceScope(user, channelMapTemplateSettingsTarget(template))) {
      visibleTemplates.push(template);
    }
  }

  return visibleTemplates;
}

export async function scopedUploadProviders(
  user: AuthResult["user"],
  uploadProviderStore: UploadProviderStore,
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const visibleProviders: UploadProviderRuntimeStatus[] = [];

  for (const provider of await uploadProviderStore.listStatuses()) {
    if (await hasResourceScope(user, uploadProviderSettingsTarget(provider))) {
      visibleProviders.push(provider);
    }
  }

  return visibleProviders;
}

export async function scopedUploadPolicies(
  user: AuthResult["user"],
  policies: UploadPolicy[],
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const visiblePolicies: UploadPolicy[] = [];

  for (const policy of policies) {
    if (await hasResourceScope(user, uploadPolicySettingsTarget(policy))) {
      visiblePolicies.push(policy);
    }
  }

  return visiblePolicies;
}
