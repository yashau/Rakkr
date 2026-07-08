import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { toast } from "sonner";
import type { RetentionPolicy, RetentionPolicyInput, RetentionPolicyUpdate } from "@rakkr/shared";

import { Field, Toggle } from "@/components/settings-fields";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { numericInputCommit } from "@/lib/settings-updates";

export function RetentionPolicyEditor({
  canManage,
  onSaved,
  policy,
}: {
  canManage: boolean;
  onSaved?: () => void;
  policy: RetentionPolicy;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const mutation = useMutation({
    mutationFn: () => api.updateRetentionPolicy(policy.id, policyUpdate(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The retention policy could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(data);
      toast.success("Retention policy saved");
      void queryClient.invalidateQueries({ queryKey: ["retention-policies"] });
      onSaved?.();
    },
  });

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Scope">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                scope: value as RetentionPolicy["scope"],
              }))
            }
            value={draft.scope}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="controller_cache">Controller Cache</SelectItem>
              <SelectItem value="recorder_cache">Recorder Cache</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Action">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                action: value as RetentionPolicy["action"],
              }))
            }
            value={draft.action}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keep">Keep</SelectItem>
              <SelectItem value="delete_cache">Delete Cache</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          label="Max Age Days"
          onChange={(maxAgeDays) => setDraft((current) => ({ ...current, maxAgeDays }))}
          value={draft.maxAgeDays}
          canManage={canManage}
        />
        <NumberField
          label="Min Free %"
          onChange={(minFreeDiskPercent) =>
            setDraft((current) => ({ ...current, minFreeDiskPercent }))
          }
          value={draft.minFreeDiskPercent}
          canManage={canManage}
        />
        <NumberField
          label="Max Bytes"
          onChange={(maxBytes) => setDraft((current) => ({ ...current, maxBytes }))}
          value={draft.maxBytes}
          canManage={canManage}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Toggle
          checked={draft.deleteOnlyAfterUploaded}
          disabled={!canManage}
          label="Only after upload"
          onChange={(deleteOnlyAfterUploaded) =>
            setDraft((current) => ({ ...current, deleteOnlyAfterUploaded }))
          }
        />
        <Toggle
          checked={draft.preserveTagged}
          disabled={!canManage}
          label="Preserve tagged"
          onChange={(preserveTagged) => setDraft((current) => ({ ...current, preserveTagged }))}
        />
        <Toggle
          checked={draft.enabled}
          disabled={!canManage}
          label="Enabled"
          onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
        />
      </div>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <DialogFooter>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage}
                  onClick={() => mutation.mutate()}
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canManage ? "Save retention policy" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </DialogFooter>
    </div>
  );
}

function NumberField({
  canManage,
  label,
  onChange,
  value,
}: {
  canManage: boolean;
  label: string;
  onChange: (value: number | null) => void;
  value: number | null;
}) {
  return (
    <Field label={label}>
      <Input
        disabled={!canManage}
        min={1}
        onChange={(event) => onChange(optionalNumber(event.target.value))}
        type="number"
        value={value ?? ""}
      />
    </Field>
  );
}

function policyUpdate(policy: RetentionPolicy): RetentionPolicyUpdate {
  return {
    action: policy.action,
    deleteOnlyAfterUploaded: policy.deleteOnlyAfterUploaded,
    enabled: policy.enabled,
    maxAgeDays: policy.maxAgeDays,
    maxBytes: policy.maxBytes,
    minFreeDiskPercent: policy.minFreeDiskPercent,
    name: policy.name,
    preserveTagged: policy.preserveTagged,
    scope: policy.scope,
  };
}

export function defaultRetentionPolicyInput(): RetentionPolicyInput {
  return {
    action: "keep",
    deleteOnlyAfterUploaded: true,
    enabled: true,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: null,
    name: "New Retention Policy",
    preserveTagged: true,
    scope: "controller_cache",
  };
}

function optionalNumber(value: string): number | null {
  // Empty clears the limit (null); an invalid/non-decimal entry commits null
  // rather than NaN (Number("abc")/Number("0x1f") would otherwise slip through)
  // (audit H4-3).
  return numericInputCommit(value) ?? null;
}
