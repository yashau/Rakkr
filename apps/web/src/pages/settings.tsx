import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChannelMapEntry,
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  ChannelMapTemplateUpdate,
  RecorderNode,
  RecordingProfile,
  UploadProviderRuntimeStatus,
  WatchdogPolicy,
} from "@rakkr/shared";
import {
  Cable,
  PlusCircle,
  RotateCcw,
  Rocket,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UploadPolicyPanel } from "@/components/upload-policy-panel";
import { UploadRunnerPanel } from "@/components/upload-runner-panel";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  optionalPositiveNumber,
  recordingProfileUpdate,
  uploadProviderUpdate,
  watchdogPolicyUpdate,
} from "@/lib/settings-updates";
import { uploadProviderStatusClass } from "@/lib/upload-status";

export function SettingsPage() {
  const profilesQuery = useQuery({
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const watchdogPoliciesQuery = useQuery({
    queryFn: api.watchdogPolicies,
    queryKey: ["watchdog-policies"],
  });
  const channelMapsQuery = useQuery({
    queryFn: api.channelMapTemplates,
    queryKey: ["channel-map-templates"],
  });
  const uploadProvidersQuery = useQuery({
    queryFn: api.uploadProviders,
    queryKey: ["upload-providers"],
  });
  const assignmentsQuery = useQuery({
    queryFn: api.channelMapAssignments,
    queryKey: ["channel-map-assignments"],
  });
  const nodesQuery = useQuery({
    queryFn: api.nodes,
    queryKey: ["nodes"],
  });
  const queryClient = useQueryClient();
  const createChannelMapMutation = useMutation({
    mutationFn: () => api.createChannelMapTemplate(defaultChannelMapTemplate()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel-map-templates"] });
    },
  });

  return (
    <div className="grid gap-6">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recording Profiles</h2>
          <p className="text-sm text-muted-foreground">Central audio defaults and templates.</p>
        </div>
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
          {profilesQuery.data?.data.length ?? 0} profiles
        </Badge>
      </section>

      <div className="grid gap-4">
        {(profilesQuery.data?.data ?? []).map((profile) => (
          <RecordingProfileCard key={profile.id} profile={profile} />
        ))}
      </div>

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Watchdog Policies</h2>
          <p className="text-sm text-muted-foreground">Scheduled signal health thresholds.</p>
        </div>
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
          {watchdogPoliciesQuery.data?.data.length ?? 0} policies
        </Badge>
      </section>

      <div className="grid gap-4">
        {(watchdogPoliciesQuery.data?.data ?? []).map((policy) => (
          <WatchdogPolicyCard key={policy.id} policy={policy} />
        ))}
      </div>

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Providers</h2>
          <p className="text-sm text-muted-foreground">
            Storage targets and credential references.
          </p>
        </div>
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
          {(uploadProvidersQuery.data?.data ?? []).filter((provider) => provider.enabled).length}{" "}
          enabled
        </Badge>
      </section>

      <div className="grid gap-4">
        {(uploadProvidersQuery.data?.data ?? []).map((provider) => (
          <UploadProviderCard key={provider.provider} provider={provider} />
        ))}
      </div>

      <UploadPolicyPanel />

      <UploadRunnerPanel />

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Channel Maps</h2>
          <p className="text-sm text-muted-foreground">Reusable node and interface routing.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
            {channelMapsQuery.data?.data.length ?? 0} templates
          </Badge>
          <Button
            disabled={createChannelMapMutation.isPending}
            onClick={() => createChannelMapMutation.mutate()}
            variant="outline"
          >
            <PlusCircle className="size-4" />
            New
          </Button>
        </div>
      </section>

      <div className="grid gap-4">
        {(channelMapsQuery.data?.data ?? []).map((template) => (
          <ChannelMapTemplateCard
            assignments={assignmentsQuery.data?.data ?? []}
            key={template.id}
            nodes={nodesQuery.data?.data ?? []}
            template={template}
          />
        ))}
      </div>
    </div>
  );
}

function UploadProviderCard({ provider }: { provider: UploadProviderRuntimeStatus }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(provider);
  const mutation = useMutation({
    mutationFn: () => api.updateUploadProvider(provider.provider, uploadProviderUpdate(draft)),
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
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Name">
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, displayName: event.target.value }))
            }
            value={draft.displayName}
          />
        </Field>
        <Field label="Target">
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, target: event.target.value }))
            }
            value={draft.target ?? ""}
          />
        </Field>
        <Field label="Credential Ref">
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, credentialRef: event.target.value }))
            }
            value={draft.credentialRef ?? ""}
          />
        </Field>
        <Toggle
          checked={draft.enabled}
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

function RecordingProfileCard({ profile }: { profile: RecordingProfile }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(profile);
  const mutation = useMutation({
    mutationFn: () => api.updateRecordingProfile(profile.id, recordingProfileUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["recording-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <SlidersHorizontal className="size-4" />
            <h3 className="text-base font-semibold">{profile.name}</h3>
            <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline">
              {profile.id}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {profile.codec.toUpperCase()} / {profile.bitrateKbps} kbps / {profile.channelMode}
          </p>
        </div>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Codec">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                codec: event.target.value as RecordingProfile["codec"],
              }))
            }
            value={draft.codec}
          >
            <option value="mp3">MP3</option>
            <option value="flac">FLAC</option>
            <option value="wav">WAV</option>
          </select>
        </Field>
        <Field label="Bitrate">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({ ...current, bitrateKbps: Number(event.target.value) }))
            }
            type="number"
            value={draft.bitrateKbps}
          />
        </Field>
        <Field label="Max Track Seconds">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                maxTrackSeconds: optionalPositiveNumber(event.target.value),
              }))
            }
            placeholder="Disabled"
            type="number"
            value={draft.maxTrackSeconds ?? ""}
          />
        </Field>
        <Field label="Channel Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                channelMode: event.target.value as RecordingProfile["channelMode"],
              }))
            }
            value={draft.channelMode}
          >
            <option value="mono">Mono</option>
            <option value="stereo">Stereo</option>
            <option value="mono_to_stereo_mix">Mono To Stereo Mix</option>
            <option value="multichannel">Multichannel</option>
          </select>
        </Field>
        <Toggle
          checked={draft.vbr}
          label="VBR"
          onChange={(checked) => setDraft((current) => ({ ...current, vbr: checked }))}
        />
        <Toggle
          checked={draft.silenceDetectionEnabled}
          label="Silence Detection"
          onChange={(checked) =>
            setDraft((current) => ({ ...current, silenceDetectionEnabled: checked }))
          }
        />
        <Toggle
          checked={draft.silenceSkipEnabled}
          label="Silence Skip"
          onChange={(checked) =>
            setDraft((current) => ({ ...current, silenceSkipEnabled: checked }))
          }
        />
      </div>

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
    </Card>
  );
}

function WatchdogPolicyCard({ policy }: { policy: WatchdogPolicy }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const mutation = useMutation({
    mutationFn: () => api.updateWatchdogPolicy(policy.id, watchdogPolicyUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["watchdog-policies"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="size-4" />
            <h3 className="text-base font-semibold">{policy.name}</h3>
            <Badge className="border-amber-200 bg-amber-50 text-amber-700" variant="outline">
              {policy.id}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {policy.metric} below {policy.thresholdDbfs} dBFS / {policy.windowSeconds}s
          </p>
        </div>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Active During">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                activeDuring: event.target.value as WatchdogPolicy["activeDuring"],
              }))
            }
            value={draft.activeDuring}
          >
            <option value="always">Always</option>
            <option value="recording">Recording</option>
            <option value="scheduled_recording">Scheduled Recording</option>
          </select>
        </Field>
        <Field label="Metric">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                metric: event.target.value as WatchdogPolicy["metric"],
              }))
            }
            value={draft.metric}
          >
            <option value="rms">RMS</option>
            <option value="peak">Peak</option>
            <option value="percentile_95">Percentile 95</option>
          </select>
        </Field>
        <Field label="Threshold dBFS">
          <Input
            max={24}
            min={-160}
            onChange={(event) =>
              setDraft((current) => ({ ...current, thresholdDbfs: Number(event.target.value) }))
            }
            type="number"
            value={draft.thresholdDbfs}
          />
        </Field>
        <Field label="Window Seconds">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({ ...current, windowSeconds: Number(event.target.value) }))
            }
            type="number"
            value={draft.windowSeconds}
          />
        </Field>
        <Field label="Grace Seconds">
          <Input
            min={0}
            onChange={(event) =>
              setDraft((current) => ({ ...current, graceSeconds: Number(event.target.value) }))
            }
            type="number"
            value={draft.graceSeconds}
          />
        </Field>
        <Field label="Repeat Seconds">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                repeatEverySeconds: Number(event.target.value),
              }))
            }
            type="number"
            value={draft.repeatEverySeconds}
          />
        </Field>
        <Field label="Min Above Seconds">
          <Input
            min={0}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                minCumulativeSecondsAboveThreshold: Number(event.target.value),
              }))
            }
            type="number"
            value={draft.minCumulativeSecondsAboveThreshold}
          />
        </Field>
        <Field label="Severity">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                severity: event.target.value as WatchdogPolicy["severity"],
              }))
            }
            value={draft.severity}
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </Field>
      </div>

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
    </Card>
  );
}

function ChannelMapTemplateCard({
  assignments,
  nodes,
  template,
}: {
  assignments: ChannelMapTemplateAssignment[];
  nodes: RecorderNode[];
  template: ChannelMapTemplate;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(template);
  const targetOptions = channelMapTargets(nodes);
  const [selectedTarget, setSelectedTarget] = useState(targetOptions[0]?.value ?? "");
  const assignedTargets = assignments.filter((assignment) => assignment.templateId === template.id);
  const draftChanged = channelMapDraftChanged(template, draft);
  const nextRevision = template.revision + 1;
  const updateMutation = useMutation({
    mutationFn: () => api.updateChannelMapTemplate(template.id, channelMapTemplateUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["channel-map-templates"] });
    },
  });
  const assignMutation = useMutation({
    mutationFn: () => {
      const target = parseTargetValue(selectedTarget);

      return api.assignChannelMapTemplate({
        targetId: target.id,
        targetType: target.type,
        templateId: template.id,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel-map-assignments"] });
    },
  });
  const rollbackMutation = useMutation({
    mutationFn: (assignment: ChannelMapTemplateAssignment) =>
      api.rollbackChannelMapAssignment({
        targetId: assignment.targetId,
        targetType: assignment.targetType,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel-map-assignments"] });
    },
  });

  useEffect(() => {
    setDraft(template);
  }, [template]);

  useEffect(() => {
    if (!selectedTarget && targetOptions[0]) {
      setSelectedTarget(targetOptions[0].value);
    }
  }, [selectedTarget, targetOptions]);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Cable className="size-4" />
            <h3 className="text-base font-semibold">{template.name}</h3>
            <Badge className="border-sky-200 bg-sky-50 text-sky-700" variant="outline">
              {assignedTargets.length} targets
            </Badge>
            <Badge className="border-violet-200 bg-violet-50 text-violet-700" variant="outline">
              rev {template.revision}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {template.channelMode} / {template.entries.filter((entry) => entry.included).length}{" "}
            active channels
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!draftChanged || updateMutation.isPending}
            onClick={() => updateMutation.mutate()}
          >
            <Rocket className="size-4" />
            Promote Rev {nextRevision}
          </Button>
          <Button
            disabled={!draftChanged || updateMutation.isPending}
            onClick={() => setDraft(template)}
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-4" />
            Reset
          </Button>
        </div>
      </div>

      <div className="mb-4 grid gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm md:grid-cols-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground uppercase">Current</div>
          <div>Revision {template.revision}</div>
          <div className="text-xs text-muted-foreground">
            {template.promotedAt ? formatDateTime(template.promotedAt) : "No promotion date"}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground uppercase">Draft</div>
          <div>{draftChanged ? `Promotes to revision ${nextRevision}` : "No pending changes"}</div>
          <div className="text-xs text-muted-foreground">
            {draft.entries.filter((entry) => entry.included).length} active channels
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground uppercase">Rollout</div>
          <div>{assignedTargets.length} assigned targets</div>
          <div className="text-xs text-muted-foreground">
            {template.promotedFromTemplateId
              ? `Previous ${template.promotedFromTemplateId}`
              : "No previous template"}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                channelMode: event.target.value as ChannelMapTemplate["channelMode"],
              }))
            }
            value={draft.channelMode}
          >
            <option value="mono">Mono</option>
            <option value="stereo">Stereo</option>
            <option value="mono_to_stereo_mix">Mono To Stereo Mix</option>
            <option value="multichannel">Multichannel</option>
          </select>
        </Field>
        <Field label="Tags">
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, tags: parseTags(event.target.value) }))
            }
            value={draft.tags.join(", ")}
          />
        </Field>
      </div>

      <div className="mt-4 grid gap-2">
        {draft.entries.map((entry, index) => (
          <div
            className="grid gap-2 rounded-md border border-border bg-muted/20 p-2 md:grid-cols-[90px_90px_1fr_120px_40px]"
            key={index}
          >
            <Input
              min={1}
              onChange={(event) =>
                setDraft((current) =>
                  updateChannelEntry(current, index, {
                    sourceChannelIndex: Number(event.target.value),
                  }),
                )
              }
              type="number"
              value={entry.sourceChannelIndex}
            />
            <Input
              min={1}
              onChange={(event) =>
                setDraft((current) =>
                  updateChannelEntry(current, index, {
                    outputChannelIndex: Number(event.target.value),
                  }),
                )
              }
              type="number"
              value={entry.outputChannelIndex ?? ""}
            />
            <Input
              onChange={(event) =>
                setDraft((current) =>
                  updateChannelEntry(current, index, {
                    label: event.target.value,
                  }),
                )
              }
              value={entry.label}
            />
            <Toggle
              checked={entry.included}
              label="Included"
              onChange={(checked) =>
                setDraft((current) => updateChannelEntry(current, index, { included: checked }))
              }
            />
            <Button
              disabled={draft.entries.length <= 1}
              onClick={() => setDraft((current) => removeChannelEntry(current, index))}
              size="icon"
              type="button"
              variant="outline"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          className="justify-self-start"
          onClick={() => setDraft((current) => addChannelEntry(current))}
          type="button"
          variant="outline"
        >
          <PlusCircle className="size-4" />
          Add Channel
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-end">
        <Field label="Assign Target">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => setSelectedTarget(event.target.value)}
            value={selectedTarget}
          >
            {targetOptions.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={!selectedTarget || assignMutation.isPending}
          onClick={() => assignMutation.mutate()}
          variant="outline"
        >
          <Cable className="size-4" />
          Assign
        </Button>
      </div>

      {assignedTargets.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {assignedTargets.map((assignment) => {
            const latest = assignment.history.at(-1);

            return (
              <div
                className="flex flex-col gap-2 rounded-md border border-border bg-background p-2 text-sm md:flex-row md:items-center md:justify-between"
                key={assignment.id}
              >
                <div>
                  <div className="font-medium">
                    {assignment.targetType}:{assignment.targetId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {assignment.history.length} changes
                    {latest ? ` / ${formatDateTime(latest.changedAt)}` : ""}
                  </div>
                  {latest ? (
                    <div className="text-xs text-muted-foreground">
                      {latest.reason} {latest.previousTemplateId ?? "none"} -&gt;{" "}
                      {latest.nextTemplateId}
                    </div>
                  ) : null}
                </div>
                <Button
                  disabled={
                    rollbackMutation.isPending ||
                    !assignment.history.some((event) => event.previousTemplateId)
                  }
                  onClick={() => rollbackMutation.mutate(assignment)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RotateCcw className="size-4" />
                  Roll Back
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      {updateMutation.isError || assignMutation.isError || rollbackMutation.isError ? (
        <p className="mt-3 text-sm text-destructive">Save failed.</p>
      ) : null}
    </Card>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
      <input
        checked={checked}
        className="size-4"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
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

function channelMapTemplateUpdate(template: ChannelMapTemplate): ChannelMapTemplateUpdate {
  return {
    channelMode: template.channelMode,
    entries: template.entries,
    name: template.name,
    tags: template.tags,
  };
}

function channelMapDraftChanged(template: ChannelMapTemplate, draft: ChannelMapTemplate) {
  return (
    JSON.stringify(channelMapTemplateUpdate(template)) !==
    JSON.stringify(channelMapTemplateUpdate(draft))
  );
}

function updateChannelEntry(
  template: ChannelMapTemplate,
  index: number,
  patch: Partial<ChannelMapEntry>,
) {
  return {
    ...template,
    entries: template.entries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, ...patch } : entry,
    ),
  };
}

function addChannelEntry(template: ChannelMapTemplate) {
  const nextIndex = template.entries.length + 1;

  return {
    ...template,
    entries: [
      ...template.entries,
      {
        included: true,
        label: `Channel ${nextIndex}`,
        outputChannelIndex: nextIndex,
        sourceChannelIndex: nextIndex,
      },
    ],
  };
}

function removeChannelEntry(template: ChannelMapTemplate, index: number) {
  return {
    ...template,
    entries: template.entries.filter((_, entryIndex) => entryIndex !== index),
  };
}

function parseTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function channelMapTargets(nodes: RecorderNode[]) {
  return nodes.flatMap((node) => [
    {
      label: `${node.alias} / node`,
      value: `node:${node.id}`,
    },
    ...node.interfaces.map((audioInterface) => ({
      label: `${node.alias} / ${audioInterface.alias}`,
      value: `interface:${audioInterface.id}`,
    })),
  ]);
}

function parseTargetValue(value: string): { id: string; type: "interface" | "node" } {
  const [type, ...idParts] = value.split(":");

  if (type !== "interface" && type !== "node") {
    return { id: value, type: "node" as const };
  }

  return { id: idParts.join(":"), type };
}
