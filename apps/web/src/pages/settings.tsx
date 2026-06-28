import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UploadProviderRuntimeStatus } from "@rakkr/shared";
import { PlusCircle, Save, ShieldAlert, UploadCloud } from "lucide-react";

import { toast } from "sonner";

import { ChannelMapTemplateCard } from "@/components/channel-map-template-card";
import { HintButton } from "@/components/hint-button";
import { RecordingProfileSettingsCard } from "@/components/recording-profile-settings-card";
import { RetentionPolicyPanel } from "@/components/retention-policy-panel";
import { Field, Toggle } from "@/components/settings-fields";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UploadPolicyPanel } from "@/components/upload-policy-panel";
import { UploadRunnerPanel } from "@/components/upload-runner-panel";
import { WatchdogPolicyCard } from "@/components/watchdog-policy-card";
import { api } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import { settingsPagePermissions } from "@/lib/settings-page-helpers";
import { uploadProviderUpdate } from "@/lib/settings-updates";
import { uploadProviderStatusClass } from "@/lib/upload-status";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const pagePermissions = settingsPagePermissions(currentUserQuery.data?.data);
  const canReadNodes = pagePermissions.canReadNodes;
  const canReadSettings = pagePermissions.canReadSettings;
  const canManageSettings = pagePermissions.canManageSettings;
  const profilesQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const watchdogPoliciesQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.watchdogPolicies,
    queryKey: ["watchdog-policies"],
  });
  const channelMapsQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.channelMapTemplates,
    queryKey: ["channel-map-templates"],
  });
  const uploadProvidersQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.uploadProviders,
    queryKey: ["upload-providers"],
  });
  const assignmentsQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.channelMapAssignments,
    queryKey: ["channel-map-assignments"],
  });
  const assignmentPlansQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.channelMapAssignmentPlans,
    queryKey: ["channel-map-assignment-plans"],
  });
  const nodesQuery = useQuery({
    enabled: canReadSettings && canReadNodes,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const queryClient = useQueryClient();
  const createChannelMapMutation = useMutation({
    mutationFn: () => api.createChannelMapTemplate(defaultChannelMapTemplate()),
    onError: () =>
      toast.error("Create failed", {
        description: "The channel map template could not be created.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel-map-templates"] });
    },
  });

  if (currentUserQuery.isPending) {
    return <SettingsAccessState description="Checking current permissions." title="Loading" />;
  }

  if (!canReadSettings) {
    return (
      <SettingsAccessState
        description="Your account does not have settings read permission."
        title="Settings Access Denied"
      />
    );
  }

  return (
    <div className="grid gap-6">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recording Profiles</h2>
          <p className="text-sm text-muted-foreground">Central audio defaults and templates.</p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {profilesQuery.data?.data.length ?? 0} profiles
        </Badge>
      </section>

      <div className="grid gap-4">
        {(profilesQuery.data?.data ?? []).map((profile) => (
          <RecordingProfileSettingsCard
            canManage={canManageSettings}
            key={profile.id}
            profile={profile}
          />
        ))}
      </div>

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Watchdog Policies</h2>
          <p className="text-sm text-muted-foreground">Scheduled signal health thresholds.</p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {watchdogPoliciesQuery.data?.data.length ?? 0} policies
        </Badge>
      </section>

      <div className="grid gap-4">
        {(watchdogPoliciesQuery.data?.data ?? []).map((policy) => (
          <WatchdogPolicyCard
            canManage={canManageSettings}
            canReadNodes={canReadNodes}
            key={policy.id}
            nodes={nodesQuery.data?.data ?? []}
            policy={policy}
          />
        ))}
      </div>

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Providers</h2>
          <p className="text-sm text-muted-foreground">
            Storage targets and credential references.
          </p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {(uploadProvidersQuery.data?.data ?? []).filter((provider) => provider.enabled).length}{" "}
          enabled
        </Badge>
      </section>

      <div className="grid gap-4">
        {(uploadProvidersQuery.data?.data ?? []).map((provider) => (
          <UploadProviderCard
            canManage={canManageSettings}
            key={provider.provider}
            provider={provider}
          />
        ))}
      </div>

      <UploadPolicyPanel canManage={canManageSettings} canRead={canReadSettings} />

      <RetentionPolicyPanel canManage={canManageSettings} canRead={canReadSettings} />

      <UploadRunnerPanel />

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Channel Maps</h2>
          <p className="text-sm text-muted-foreground">Reusable node and interface routing.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
            {channelMapsQuery.data?.data.length ?? 0} templates
          </Badge>
          <HintButton
            disabled={createChannelMapMutation.isPending || !canManageSettings}
            hint={canManageSettings ? "Create channel map" : "Requires settings manage"}
            onClick={() => createChannelMapMutation.mutate()}
            variant="outline"
          >
            <PlusCircle className="size-4" />
            New
          </HintButton>
        </div>
      </section>

      <div className="grid gap-4">
        {(channelMapsQuery.data?.data ?? []).map((template) => (
          <ChannelMapTemplateCard
            assignments={assignmentsQuery.data?.data ?? []}
            canManage={canManageSettings}
            canReadNodes={canReadNodes}
            key={template.id}
            nodes={nodesQuery.data?.data ?? []}
            plans={assignmentPlansQuery.data?.data ?? []}
            template={template}
          />
        ))}
      </div>
    </div>
  );
}

function SettingsAccessState({ description, title }: { description: string; title: string }) {
  return (
    <Card className="rounded-lg p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700">
          <ShieldAlert className="size-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </Card>
  );
}

function UploadProviderCard({
  canManage,
  provider,
}: {
  canManage: boolean;
  provider: UploadProviderRuntimeStatus;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(provider);
  const mutation = useMutation({
    mutationFn: () => api.updateUploadProvider(provider.provider, uploadProviderUpdate(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The upload provider settings could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["upload-providers"] });
    },
  });

  useEffect(() => {
    setDraft(provider);
  }, [provider]);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <UploadCloud className="size-4" />
            <h3 className="text-base font-semibold">{provider.displayName}</h3>
            <Badge className={uploadProviderStatusClass(provider.status)} variant="outline">
              {provider.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {provider.provider} / {provider.implemented ? "driver scaffolded" : "driver pending"}
          </p>
        </div>
        <HintButton
          disabled={mutation.isPending || !canManage}
          hint={canManage ? "Save upload provider" : "Requires settings manage"}
          onClick={() => mutation.mutate()}
        >
          <Save className="size-4" />
          Save
        </HintButton>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, displayName: event.target.value }))
            }
            value={draft.displayName}
          />
        </Field>
        <Field label="Target">
          <Input
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, target: event.target.value }))
            }
            value={draft.target ?? ""}
          />
        </Field>
        <Field label="Credential Ref">
          <Input
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, credentialRef: event.target.value }))
            }
            value={draft.credentialRef ?? ""}
          />
        </Field>
        <Toggle
          checked={draft.enabled}
          disabled={!canManage}
          label="Enabled"
          onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>
          Required {provider.requiredFields.length ? provider.requiredFields.join(", ") : "none"}
        </span>
        {provider.missingFields.length > 0 ? (
          <span>Missing {provider.missingFields.join(", ")}</span>
        ) : null}
        {provider.reason ? <span>{provider.reason}</span> : null}
      </div>

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
    </Card>
  );
}

function defaultChannelMapTemplate() {
  return {
    channelMode: "mono_to_stereo_mix" as const,
    entries: [
      {
        included: true,
        label: "Voice Channel 1",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    name: "Voice Mono To Stereo",
    tags: ["voice"],
  };
}
