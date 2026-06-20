import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChannelMapAssignmentPlan,
  ChannelMapEntry,
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  ChannelMapTemplateUpdate,
  RecorderNode,
  UploadProviderRuntimeStatus,
} from "@rakkr/shared";
import {
  Cable,
  PlusCircle,
  RotateCcw,
  Rocket,
  Save,
  ShieldAlert,
  Trash2,
  UploadCloud,
} from "lucide-react";

import { RecordingProfileSettingsCard } from "@/components/recording-profile-settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UploadPolicyPanel } from "@/components/upload-policy-panel";
import { UploadRunnerPanel } from "@/components/upload-runner-panel";
import { WatchdogPolicyCard } from "@/components/watchdog-policy-card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { settingsPagePermissions } from "@/lib/settings-page-helpers";
import { uploadProviderUpdate } from "@/lib/settings-updates";
import { uploadProviderStatusClass } from "@/lib/upload-status";

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
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
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
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
          {watchdogPoliciesQuery.data?.data.length ?? 0} policies
        </Badge>
      </section>

      <div className="grid gap-4">
        {(watchdogPoliciesQuery.data?.data ?? []).map((policy) => (
          <WatchdogPolicyCard canManage={canManageSettings} key={policy.id} policy={policy} />
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
          <UploadProviderCard
            canManage={canManageSettings}
            key={provider.provider}
            provider={provider}
          />
        ))}
      </div>

      <UploadPolicyPanel canManage={canManageSettings} canRead={canReadSettings} />

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
            disabled={createChannelMapMutation.isPending || !canManageSettings}
            onClick={() => createChannelMapMutation.mutate()}
            title={canManageSettings ? "Create channel map" : "Requires settings manage"}
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
        <Button
          disabled={mutation.isPending || !canManage}
          onClick={() => mutation.mutate()}
          title={canManage ? "Save upload provider" : "Requires settings manage"}
        >
          <Save className="size-4" />
          Save
        </Button>
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

function ChannelMapTemplateCard({
  assignments,
  canManage,
  canReadNodes,
  nodes,
  plans,
  template,
}: {
  assignments: ChannelMapTemplateAssignment[];
  canManage: boolean;
  canReadNodes: boolean;
  nodes: RecorderNode[];
  plans: ChannelMapAssignmentPlan[];
  template: ChannelMapTemplate;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(template);
  const targetOptions = channelMapTargets(nodes);
  const [selectedTarget, setSelectedTarget] = useState(targetOptions[0]?.value ?? "");
  const [selectedTargets, setSelectedTargets] = useState<string[]>(
    targetOptions.slice(0, 3).map((target) => target.value),
  );
  const [planNote, setPlanNote] = useState("");
  const assignedTargets = assignments.filter((assignment) => assignment.templateId === template.id);
  const pendingPlans = plans.filter(
    (plan) => plan.templateId === template.id && plan.status === "pending",
  );
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
  const bulkAssignMutation = useMutation({
    mutationFn: () =>
      api.bulkAssignChannelMapTemplate({
        targets: selectedTargets.map((value) => {
          const target = parseTargetValue(value);

          return {
            targetId: target.id,
            targetType: target.type,
          };
        }),
        templateId: template.id,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel-map-assignments"] });
    },
  });
  const createPlanMutation = useMutation({
    mutationFn: () =>
      api.createChannelMapAssignmentPlan({
        note: planNote.trim() || undefined,
        targets: selectedTargets.map((value) => {
          const target = parseTargetValue(value);

          return {
            targetId: target.id,
            targetType: target.type,
          };
        }),
        templateId: template.id,
      }),
    onSuccess: () => {
      setPlanNote("");
      void queryClient.invalidateQueries({ queryKey: ["channel-map-assignment-plans"] });
    },
  });
  const applyPlanMutation = useMutation({
    mutationFn: (planId: string) => api.applyChannelMapAssignmentPlan(planId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel-map-assignment-plans"] });
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

  useEffect(() => {
    if (selectedTargets.length === 0 && targetOptions[0]) {
      setSelectedTargets([targetOptions[0].value]);
    }
  }, [selectedTargets.length, targetOptions]);

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
            disabled={!draftChanged || updateMutation.isPending || !canManage}
            onClick={() => updateMutation.mutate()}
            title={canManage ? "Promote channel map revision" : "Requires settings manage"}
          >
            <Rocket className="size-4" />
            Promote Rev {nextRevision}
          </Button>
          <Button
            disabled={!draftChanged || updateMutation.isPending || !canManage}
            onClick={() => setDraft(template)}
            title={canManage ? "Reset channel map draft" : "Requires settings manage"}
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
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
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
            disabled={!canManage}
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
              disabled={!canManage}
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
              disabled={!canManage}
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
              disabled={!canManage}
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
              disabled={!canManage}
              label="Included"
              onChange={(checked) =>
                setDraft((current) => updateChannelEntry(current, index, { included: checked }))
              }
            />
            <Button
              disabled={draft.entries.length <= 1 || !canManage}
              onClick={() => setDraft((current) => removeChannelEntry(current, index))}
              size="icon"
              title={canManage ? "Remove channel" : "Requires settings manage"}
              type="button"
              variant="outline"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          className="justify-self-start"
          disabled={!canManage}
          onClick={() => setDraft((current) => addChannelEntry(current))}
          title={canManage ? "Add channel" : "Requires settings manage"}
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
            disabled={!canManage || !canReadNodes}
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
          disabled={!selectedTarget || assignMutation.isPending || !canManage || !canReadNodes}
          onClick={() => assignMutation.mutate()}
          title={assignTargetTitle(canManage, canReadNodes)}
          variant="outline"
        >
          <Cable className="size-4" />
          Assign
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-end">
        <Field label="Bulk Targets">
          <select
            className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={!canManage || !canReadNodes}
            multiple
            onChange={(event) => setSelectedTargets(selectedOptionValues(event.currentTarget))}
            value={selectedTargets}
          >
            {targetOptions.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={
            selectedTargets.length === 0 ||
            bulkAssignMutation.isPending ||
            !canManage ||
            !canReadNodes
          }
          onClick={() => bulkAssignMutation.mutate()}
          title={assignTargetTitle(canManage, canReadNodes)}
          variant="outline"
        >
          <Cable className="size-4" />
          Assign Selected
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-end">
        <Field label="Rollout Note">
          <Input
            disabled={!canManage || !canReadNodes}
            onChange={(event) => setPlanNote(event.target.value)}
            placeholder="Stage before applying"
            value={planNote}
          />
        </Field>
        <Button
          disabled={
            selectedTargets.length === 0 ||
            createPlanMutation.isPending ||
            !canManage ||
            !canReadNodes
          }
          onClick={() => createPlanMutation.mutate()}
          title={assignTargetTitle(canManage, canReadNodes)}
          variant="outline"
        >
          <Rocket className="size-4" />
          Stage Plan
        </Button>
      </div>

      {pendingPlans.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {pendingPlans.map((plan) => (
            <div
              className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm md:flex-row md:items-center md:justify-between"
              key={plan.id}
            >
              <div>
                <div className="font-medium">{plan.targets.length} staged targets</div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(plan.createdAt)}
                  {plan.note ? ` / ${plan.note}` : ""}
                </div>
              </div>
              <Button
                disabled={!canManage || applyPlanMutation.isPending}
                onClick={() => applyPlanMutation.mutate(plan.id)}
                size="sm"
                title={canManage ? "Apply staged rollout" : "Requires settings manage"}
                type="button"
                variant="outline"
              >
                <Rocket className="size-4" />
                Apply
              </Button>
            </div>
          ))}
        </div>
      ) : null}

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
                    !canManage ||
                    rollbackMutation.isPending ||
                    !assignment.history.some((event) => event.previousTemplateId)
                  }
                  onClick={() => rollbackMutation.mutate(assignment)}
                  size="sm"
                  title={canManage ? "Roll back assignment" : "Requires settings manage"}
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

      {updateMutation.isError ||
      assignMutation.isError ||
      bulkAssignMutation.isError ||
      createPlanMutation.isError ||
      applyPlanMutation.isError ||
      rollbackMutation.isError ? (
        <p className="mt-3 text-sm text-destructive">Save failed.</p>
      ) : null}
    </Card>
  );
}

function assignTargetTitle(canManage: boolean, canReadNodes: boolean) {
  if (!canManage) {
    return "Requires settings manage";
  }

  return canReadNodes ? "Assign channel map" : "Requires node read";
}

function selectedOptionValues(select: HTMLSelectElement) {
  return Array.from(select.selectedOptions, (option) => option.value);
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
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
      <input
        checked={checked}
        className="size-4"
        disabled={disabled}
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
