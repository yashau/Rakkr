import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { UploadProviderRuntimeStatus } from "@rakkr/shared";
import { Pencil, Save } from "lucide-react";
import { toast } from "sonner";

import { Field, Toggle } from "@/components/settings-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import { uploadProviderUpdate } from "@/lib/settings-updates";
import { uploadProviderStatusClass } from "@/lib/upload-status";
import { cn } from "@/lib/utils";

export function SettingsUploadProvidersSection({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const [editing, setEditing] = useState<UploadProviderRuntimeStatus>();
  const providersQuery = useQuery({
    enabled: canRead,
    queryFn: api.uploadProviders,
    queryKey: ["upload-providers"],
  });
  const providers = providersQuery.data?.data ?? [];
  const enabledCount = providers.filter((provider) => provider.enabled).length;
  const columns = uploadProviderColumns({ canManage, onEdit: setEditing });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Providers</h2>
          <p className="text-sm text-muted-foreground">
            Storage targets and credential references.
          </p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {enabledCount} enabled
        </Badge>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={providers}
          emptyMessage="No upload providers are available."
          getRowId={(provider) => provider.provider}
          isLoading={providersQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        open={Boolean(editing)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Upload Provider</DialogTitle>
            <DialogDescription>
              Configure the display name, target, and credential reference for this provider.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <UploadProviderEditor
              canManage={canManage}
              onSaved={() => setEditing(undefined)}
              provider={editing}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UploadProviderEditor({
  canManage,
  onSaved,
  provider,
}: {
  canManage: boolean;
  onSaved: () => void;
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
      toast.success("Upload provider saved");
      void queryClient.invalidateQueries({ queryKey: ["upload-providers"] });
      onSaved();
    },
  });

  useEffect(() => {
    setDraft(provider);
  }, [provider]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
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

      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>
          Required {provider.requiredFields.length ? provider.requiredFields.join(", ") : "none"}
        </span>
        {provider.missingFields.length > 0 ? (
          <span>Missing {provider.missingFields.join(", ")}</span>
        ) : null}
        {provider.reason ? <span>{provider.reason}</span> : null}
      </div>

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
            {canManage ? "Save upload provider" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function uploadProviderColumns({
  canManage,
  onEdit,
}: {
  canManage: boolean;
  onEdit: (provider: UploadProviderRuntimeStatus) => void;
}): ColumnDef<UploadProviderRuntimeStatus>[] {
  const columns: ColumnDef<UploadProviderRuntimeStatus>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.original.displayName}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.provider}</div>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.target ?? "-"}</span>
      ),
      header: "Target",
      id: "target",
    },
    {
      cell: ({ row }) => (
        <Badge className={uploadProviderStatusClass(row.original.status)} variant="outline">
          {row.original.status}
        </Badge>
      ),
      header: "Status",
      id: "status",
    },
  ];

  columns.push({
    cell: ({ row }) => (
      <div className="flex justify-end">
        <Button
          disabled={!canManage}
          onClick={() => onEdit(row.original)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Pencil className="size-4" />
          Edit
        </Button>
      </div>
    ),
    header: () => <span className="sr-only">Actions</span>,
    id: "actions",
    meta: { cellClassName: "text-right", headClassName: "text-right" },
  });

  return columns;
}
