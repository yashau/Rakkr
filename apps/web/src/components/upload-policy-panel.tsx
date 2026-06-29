import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { toast } from "sonner";
import type { UploadPolicy, UploadPolicyInput, UploadPolicyUpdate } from "@rakkr/shared";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Provider">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                provider: value as UploadPolicy["provider"],
              }))
            }
            value={draft.provider}
          >
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stub">Stub</SelectItem>
              <SelectItem value="smb">SMB</SelectItem>
              <SelectItem value="s3">S3</SelectItem>
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
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="on_recording_cached">On Cached</SelectItem>
            </SelectContent>
          </Select>
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
        <Field label="Attempts">
          <Input
            disabled={!canManage}
            min={1}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxAttempts: Number(event.target.value) }))
            }
            type="number"
            value={draft.maxAttempts}
          />
        </Field>
      </div>

      <label
        className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm"
        htmlFor={`upload-policy-enabled-${policy.id}`}
      >
        <Checkbox
          checked={draft.enabled}
          disabled={!canManage}
          id={`upload-policy-enabled-${policy.id}`}
          onCheckedChange={(value) =>
            setDraft((current) => ({ ...current, enabled: value === true }))
          }
        />
        Enabled
      </label>

      <label
        className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm"
        htmlFor={`upload-policy-delete-cache-${policy.id}`}
      >
        <Checkbox
          checked={draft.deleteCacheAfterUpload}
          disabled={!canManage}
          id={`upload-policy-delete-cache-${policy.id}`}
          onCheckedChange={(value) =>
            setDraft((current) => ({
              ...current,
              deleteCacheAfterUpload: value === true,
            }))
          }
        />
        Delete controller cache after confirmed upload
      </label>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button disabled={mutation.isPending || !canManage} onClick={() => mutation.mutate()}>
                <Save className="size-4" />
                Save
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {canManage ? "Save upload policy" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
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

function policyUpdate(policy: UploadPolicy): UploadPolicyUpdate {
  return {
    deleteCacheAfterUpload: policy.deleteCacheAfterUpload,
    enabled: policy.enabled,
    maxAttempts: policy.maxAttempts,
    name: policy.name,
    provider: policy.provider,
    target: optionalText(policy.target),
    trigger: policy.trigger,
  };
}

export function defaultUploadPolicyInput(): UploadPolicyInput {
  return {
    deleteCacheAfterUpload: false,
    enabled: true,
    maxAttempts: 5,
    name: "New Upload Policy",
    provider: "stub",
    target: "stub://queue-only",
    trigger: "manual",
  };
}

function optionalText(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed || undefined;
}
