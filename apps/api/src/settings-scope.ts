import type {
  ChannelMapAssignmentPlan,
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  RecordingProfile,
  RetentionPolicy,
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

export function channelMapAssignmentTarget(
  target: Pick<ChannelMapTemplateAssignment, "targetId" | "targetType">,
) {
  return {
    id: target.targetId,
    type: target.targetType,
  };
}

export function uniqueChannelMapAssignmentTargets(
  targets: Array<Pick<ChannelMapTemplateAssignment, "targetId" | "targetType">>,
) {
  const seen = new Set<string>();

  return targets.filter((target) => {
    const key = `${target.targetType}:${target.targetId}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
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

export function retentionPolicySettingsTarget(policy: Pick<RetentionPolicy, "id" | "name">) {
  return {
    id: policy.id,
    name: policy.name,
    type: "retention_policy",
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

export async function scopedChannelMapAssignments(
  user: AuthResult["user"],
  assignments: ChannelMapTemplateAssignment[],
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const visibleAssignments: ChannelMapTemplateAssignment[] = [];

  for (const assignment of assignments) {
    if (await hasResourceScope(user, channelMapAssignmentTarget(assignment))) {
      visibleAssignments.push(assignment);
    }
  }

  return visibleAssignments;
}

export async function firstHiddenChannelMapAssignmentTarget(
  user: AuthResult["user"],
  targets: Array<Pick<ChannelMapTemplateAssignment, "targetId" | "targetType">>,
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return targets[0] ? channelMapAssignmentTarget(targets[0]) : undefined;
  }

  for (const target of targets) {
    const auditTarget = channelMapAssignmentTarget(target);

    if (!(await hasResourceScope(user, auditTarget))) {
      return auditTarget;
    }
  }

  return undefined;
}

export async function scopedChannelMapAssignmentPlans(
  user: AuthResult["user"],
  plans: ChannelMapAssignmentPlan[],
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const visiblePlans: ChannelMapAssignmentPlan[] = [];

  for (const plan of plans) {
    if (!(await firstHiddenChannelMapAssignmentTarget(user, plan.targets, hasResourceScope))) {
      visiblePlans.push(plan);
    }
  }

  return visiblePlans;
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

export async function scopedRetentionPolicies(
  user: AuthResult["user"],
  policies: RetentionPolicy[],
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  if (!user) {
    return [];
  }

  const visiblePolicies: RetentionPolicy[] = [];

  for (const policy of policies) {
    if (await hasResourceScope(user, retentionPolicySettingsTarget(policy))) {
      visiblePolicies.push(policy);
    }
  }

  return visiblePolicies;
}
