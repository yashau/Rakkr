import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, PlusCircle, Save } from "lucide-react";
import type { RetentionPolicy, RetentionPolicyInput, RetentionPolicyUpdate } from "@rakkr/shared";

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

export function RetentionPolicyPanel({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const policiesQuery = useQuery({
    enabled: canRead,
    queryFn: api.retentionPolicies,
    queryKey: ["retention-policies"],
  });
  const createMutation = useMutation({
    mutationFn: () => api.createRetentionPolicy(defaultPolicyInput()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["retention-policies"] });
    },
  });
  const policies = policiesQuery.data?.data ?? [];

  return (
    <>
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Retention Policies</h2>
          <p className="text-sm text-muted-foreground">
            Cleanup templates for controller and recorder caches.
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
              {canManage ? "Create retention policy" : "Requires settings manage"}
            </TooltipContent>
          </Tooltip>
        </div>
      </section>

      <div className="grid gap-4">
        {policies.map((policy) => (
          <RetentionPolicyCard canManage={canManage} key={policy.id} policy={policy} />
        ))}
      </div>
    </>
  );
}

function RetentionPolicyCard({
  canManage,
  policy,
}: {
  canManage: boolean;
  policy: RetentionPolicy;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const mutation = useMutation({
    mutationFn: () => api.updateRetentionPolicy(policy.id, policyUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["retention-policies"] });
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
            <Clock className="size-4" />
            <h3 className="text-base font-semibold">{policy.name}</h3>
            <Badge
              className={policy.enabled ? toneBadgeClass("healthy") : toneBadgeClass("neutral")}
              variant="outline"
            >
              {policy.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {policy.scope} / {policy.action}
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
            {canManage ? "Save retention policy" : "Requires settings manage"}
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
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
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
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
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
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <NumberField
          label="Max Bytes"
          onChange={(maxBytes) => setDraft((current) => ({ ...current, maxBytes }))}
          value={draft.maxBytes}
          canManage={canManage}
        />
        <BooleanField
          checked={draft.deleteOnlyAfterUploaded}
          disabled={!canManage}
          label="Only after upload"
          onChange={(deleteOnlyAfterUploaded) =>
            setDraft((current) => ({ ...current, deleteOnlyAfterUploaded }))
          }
        />
        <BooleanField
          checked={draft.preserveTagged}
          disabled={!canManage}
          label="Preserve tagged"
          onChange={(preserveTagged) => setDraft((current) => ({ ...current, preserveTagged }))}
        />
      </div>

      <BooleanField
        checked={draft.enabled}
        disabled={!canManage}
        label="Enabled"
        onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
      />

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
    </Card>
  );
}

function BooleanField({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
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

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
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

function defaultPolicyInput(): RetentionPolicyInput {
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

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : null;
}
