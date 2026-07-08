import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { toast } from "sonner";
import type { UploadPolicy, UploadPolicyInput, UploadPolicyUpdate } from "@rakkr/shared";

import { Field, NumberField, Toggle } from "@/components/settings-fields";
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

export function UploadPolicyEditor({
  canManage,
  onSaved,
  policy,
}: {
  canManage: boolean;
  onSaved?: () => void;
  policy: UploadPolicy;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const destinationsQuery = useQuery({
    queryFn: api.uploadDestinations,
    queryKey: ["upload-destinations"],
  });
  const destinations = destinationsQuery.data?.data ?? [];
  const mutation = useMutation({
    mutationFn: () => api.updateUploadPolicy(policy.id, policyUpdate(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The upload policy could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(data);
      toast.success("Upload policy saved");
      void queryClient.invalidateQueries({ queryKey: ["upload-policies"] });
      onSaved?.();
    },
  });

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

  return (
    <div className="grid gap-5">
      {destinations.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Add an upload destination first — every policy uploads to a real destination.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Destination">
          <Select
            disabled={!canManage}
            onValueChange={(value) => setDraft((current) => ({ ...current, destinationId: value }))}
            value={draft.destinationId ?? ""}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a destination" />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((destination) => (
                <SelectItem key={destination.id} value={destination.id}>
                  {destination.displayName} ({destination.kind.toUpperCase()})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Trigger">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                trigger: value as UploadPolicy["trigger"],
              }))
            }
            value={draft.trigger}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="on_recording_cached">On Cached</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          disabled={!canManage}
          label="Attempts"
          min={1}
          onChange={(maxAttempts) => setDraft((current) => ({ ...current, maxAttempts }))}
          value={draft.maxAttempts}
        />
        <Field className="sm:col-span-2" label="Subfolder (optional)">
          <Input
            disabled={!canManage || !draft.destinationId}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                pathOverride: event.target.value || undefined,
              }))
            }
            placeholder="appended to the destination path"
            value={draft.pathOverride ?? ""}
          />
        </Field>
      </div>

      <div className="grid gap-2">
        <Toggle
          checked={draft.enabled}
          disabled={!canManage}
          label="Enabled"
          onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
        />
        <Toggle
          checked={draft.deleteCacheAfterUpload}
          disabled={!canManage}
          label="Delete controller cache after confirmed upload"
          onChange={(deleteCacheAfterUpload) =>
            setDraft((current) => ({ ...current, deleteCacheAfterUpload }))
          }
        />
      </div>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <DialogFooter>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage || !draft.destinationId}
                  onClick={() => mutation.mutate()}
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {!canManage
              ? "Requires settings manage"
              : draft.destinationId
                ? "Save upload policy"
                : "Select a destination first"}
          </TooltipContent>
        </Tooltip>
      </DialogFooter>
    </div>
  );
}

function policyUpdate(policy: UploadPolicy): UploadPolicyUpdate {
  return {
    deleteCacheAfterUpload: policy.deleteCacheAfterUpload,
    destinationId: policy.destinationId,
    enabled: policy.enabled,
    maxAttempts: policy.maxAttempts,
    name: policy.name,
    pathOverride: optionalText(policy.pathOverride),
    trigger: policy.trigger,
  };
}

export function defaultUploadPolicyInput(destinationId: string): UploadPolicyInput {
  return {
    deleteCacheAfterUpload: false,
    destinationId,
    enabled: true,
    maxAttempts: 5,
    name: "New Upload Policy",
    trigger: "manual",
  };
}

function optionalText(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed || undefined;
}
