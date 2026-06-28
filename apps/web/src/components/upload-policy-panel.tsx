import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusCircle, Save, UploadCloud } from "lucide-react";
import type { UploadPolicy, UploadPolicyInput, UploadPolicyUpdate } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { toneBadgeClass } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

export function UploadPolicyPanel({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const policiesQuery = useQuery({
    enabled: canRead,
    queryFn: api.uploadPolicies,
    queryKey: ["upload-policies"],
  });
  const createMutation = useMutation({
    mutationFn: () => api.createUploadPolicy(defaultPolicyInput()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["upload-policies"] });
    },
  });
  const policies = policiesQuery.data?.data ?? [];

  return (
    <>
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Policies</h2>
          <p className="text-sm text-muted-foreground">
            Provider selection for ad hoc and scheduled queues.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
            {policies.length} policies
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  disabled={createMutation.isPending || !canManage}
                  onClick={() => createMutation.mutate()}
                  variant="outline"
                >
                  <PlusCircle className="size-4" />
                  New
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {canManage ? "Create upload policy" : "Requires settings manage"}
            </TooltipContent>
          </Tooltip>
        </div>
      </section>

      <div className="grid gap-4">
        {policies.map((policy) => (
          <UploadPolicyCard canManage={canManage} key={policy.id} policy={policy} />
        ))}
      </div>
    </>
  );
}

function UploadPolicyCard({ canManage, policy }: { canManage: boolean; policy: UploadPolicy }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const mutation = useMutation({
    mutationFn: () => api.updateUploadPolicy(policy.id, policyUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["upload-policies"] });
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
            <UploadCloud className="size-4" />
            <h3 className="text-base font-semibold">{policy.name}</h3>
            <Badge
              className={policy.enabled ? toneBadgeClass("healthy") : toneBadgeClass("neutral")}
              variant="outline"
            >
              {policy.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {policy.provider} / {policy.trigger} / {policy.maxAttempts} attempts
          </p>
        </div>
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

      <div className="grid gap-3 md:grid-cols-5">
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
        className="mt-3 flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm"
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
        className="mt-3 flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm"
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

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
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

function defaultPolicyInput(): UploadPolicyInput {
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
