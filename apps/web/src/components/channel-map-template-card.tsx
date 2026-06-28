import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ChannelMapAssignmentPlan,
  ChannelMapEntry,
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  ChannelMapTemplateUpdate,
  RecorderNode,
} from "@rakkr/shared";
import { Cable, PlusCircle, RotateCcw, Rocket, Trash2 } from "lucide-react";

import { toast } from "sonner";

import { HintButton } from "@/components/hint-button";
import { Field, Toggle } from "@/components/settings-fields";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { toneBadgeClass } from "@/lib/status-colors";

export function ChannelMapTemplateCard({
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
    onError: () =>
      toast.error("Promote failed", {
        description: "The channel map revision could not be promoted.",
      }),
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
    onError: () =>
      toast.error("Assign failed", {
        description: "The channel map could not be assigned to the target.",
      }),
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
    onError: () =>
      toast.error("Assign failed", {
        description: "The channel map could not be assigned to the selected targets.",
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
    onError: () =>
      toast.error("Stage failed", {
        description: "The channel map rollout plan could not be staged.",
      }),
    onSuccess: () => {
      setPlanNote("");
      void queryClient.invalidateQueries({ queryKey: ["channel-map-assignment-plans"] });
    },
  });
  const applyPlanMutation = useMutation({
    mutationFn: (planId: string) => api.applyChannelMapAssignmentPlan(planId),
    onError: () =>
      toast.error("Apply failed", {
        description: "The staged channel map rollout could not be applied.",
      }),
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
    onError: () =>
      toast.error("Rollback failed", {
        description: "The channel map assignment could not be rolled back.",
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
            <Badge className={toneBadgeClass("info")} variant="outline">
              {assignedTargets.length} targets
            </Badge>
            <Badge className={toneBadgeClass("neutral")} variant="outline">
              rev {template.revision}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {template.channelMode} / {template.entries.filter((entry) => entry.included).length}{" "}
            active channels
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <HintButton
            disabled={!draftChanged || updateMutation.isPending || !canManage}
            hint={canManage ? "Promote channel map revision" : "Requires settings manage"}
            onClick={() => updateMutation.mutate()}
          >
            <Rocket className="size-4" />
            Promote Rev {nextRevision}
          </HintButton>
          <HintButton
            disabled={!draftChanged || updateMutation.isPending || !canManage}
            hint={canManage ? "Reset channel map draft" : "Requires settings manage"}
            onClick={() => setDraft(template)}
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-4" />
            Reset
          </HintButton>
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
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                channelMode: value as ChannelMapTemplate["channelMode"],
              }))
            }
            value={draft.channelMode}
          >
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mono">Mono</SelectItem>
              <SelectItem value="stereo">Stereo</SelectItem>
              <SelectItem value="mono_to_stereo_mix">Mono To Stereo Mix</SelectItem>
              <SelectItem value="multichannel">Multichannel</SelectItem>
            </SelectContent>
          </Select>
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
            <HintButton
              disabled={draft.entries.length <= 1 || !canManage}
              hint={canManage ? "Remove channel" : "Requires settings manage"}
              onClick={() => setDraft((current) => removeChannelEntry(current, index))}
              size="icon"
              type="button"
              variant="outline"
            >
              <Trash2 className="size-4" />
            </HintButton>
          </div>
        ))}
        <HintButton
          className="justify-self-start"
          disabled={!canManage}
          hint={canManage ? "Add channel" : "Requires settings manage"}
          onClick={() => setDraft((current) => addChannelEntry(current))}
          type="button"
          variant="outline"
        >
          <PlusCircle className="size-4" />
          Add Channel
        </HintButton>
      </div>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-end">
        <Field label="Assign Target">
          <Select
            disabled={!canManage || !canReadNodes}
            onValueChange={(value) => setSelectedTarget(value)}
            value={selectedTarget}
          >
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targetOptions.map((target) => (
                <SelectItem key={target.value} value={target.value}>
                  {target.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <HintButton
          disabled={!selectedTarget || assignMutation.isPending || !canManage || !canReadNodes}
          hint={assignTargetTitle(canManage, canReadNodes)}
          onClick={() => assignMutation.mutate()}
          variant="outline"
        >
          <Cable className="size-4" />
          Assign
        </HintButton>
      </div>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-end">
        <Field label="Bulk Targets">
          <fieldset
            aria-label="Bulk assignment targets"
            className="grid max-h-40 gap-1.5 overflow-y-auto rounded-md border border-input bg-background p-2"
          >
            {targetOptions.map((target) => {
              const targetId = `bulk-target-${target.value}`;

              return (
                <label
                  className="flex items-center gap-2 text-sm"
                  htmlFor={targetId}
                  key={target.value}
                >
                  <Checkbox
                    checked={selectedTargets.includes(target.value)}
                    disabled={!canManage || !canReadNodes}
                    id={targetId}
                    onCheckedChange={(value) =>
                      setSelectedTargets((current) =>
                        value === true
                          ? [...current, target.value]
                          : current.filter((entry) => entry !== target.value),
                      )
                    }
                  />
                  {target.label}
                </label>
              );
            })}
          </fieldset>
        </Field>
        <HintButton
          disabled={
            selectedTargets.length === 0 ||
            bulkAssignMutation.isPending ||
            !canManage ||
            !canReadNodes
          }
          hint={assignTargetTitle(canManage, canReadNodes)}
          onClick={() => bulkAssignMutation.mutate()}
          variant="outline"
        >
          <Cable className="size-4" />
          Assign Selected
        </HintButton>
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
        <HintButton
          disabled={
            selectedTargets.length === 0 ||
            createPlanMutation.isPending ||
            !canManage ||
            !canReadNodes
          }
          hint={assignTargetTitle(canManage, canReadNodes)}
          onClick={() => createPlanMutation.mutate()}
          variant="outline"
        >
          <Rocket className="size-4" />
          Stage Plan
        </HintButton>
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
              <HintButton
                disabled={!canManage || applyPlanMutation.isPending}
                hint={canManage ? "Apply staged rollout" : "Requires settings manage"}
                onClick={() => applyPlanMutation.mutate(plan.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Rocket className="size-4" />
                Apply
              </HintButton>
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
                <HintButton
                  disabled={
                    !canManage ||
                    rollbackMutation.isPending ||
                    !assignment.history.some((event) => event.previousTemplateId)
                  }
                  hint={canManage ? "Roll back assignment" : "Requires settings manage"}
                  onClick={() => rollbackMutation.mutate(assignment)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RotateCcw className="size-4" />
                  Roll Back
                </HintButton>
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
