import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { UploadPolicy } from "@rakkr/shared";
import { Pencil, PlusCircle } from "lucide-react";
import { toast } from "sonner";

import { HintButton } from "@/components/hint-button";
import { UploadPolicyEditor, defaultUploadPolicyInput } from "@/components/upload-policy-panel";
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
import { api } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

export function SettingsUploadPoliciesSection({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<UploadPolicy>();
  const policiesQuery = useQuery({
    enabled: canRead,
    queryFn: api.uploadPolicies,
    queryKey: ["upload-policies"],
  });
  const createMutation = useMutation({
    mutationFn: () => api.createUploadPolicy(defaultUploadPolicyInput()),
    onError: () =>
      toast.error("Create failed", {
        description: "The upload policy could not be created.",
      }),
    onSuccess: ({ data }) => {
      toast.success("Upload policy created");
      void queryClient.invalidateQueries({ queryKey: ["upload-policies"] });
      setEditing(data);
    },
  });
  const policies = policiesQuery.data?.data ?? [];
  const columns = uploadPolicyColumns({ canManage, onEdit: setEditing });

  return (
    <div className="grid gap-4">
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
          <HintButton
            disabled={createMutation.isPending || !canManage}
            hint={canManage ? "Create upload policy" : "Requires settings manage"}
            onClick={() => createMutation.mutate()}
            variant="outline"
          >
            <PlusCircle className="size-4" />
            New
          </HintButton>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={policies}
          emptyMessage="No upload policies are configured."
          getRowId={(policy) => policy.id}
          isLoading={policiesQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        open={Boolean(editing)}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Upload Policy</DialogTitle>
            <DialogDescription>
              Choose the provider, trigger, retry attempts, and cache cleanup behavior.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <UploadPolicyEditor
              canManage={canManage}
              onSaved={() => setEditing(undefined)}
              policy={editing}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function uploadPolicyColumns({
  canManage,
  onEdit,
}: {
  canManage: boolean;
  onEdit: (policy: UploadPolicy) => void;
}): ColumnDef<UploadPolicy>[] {
  const columns: ColumnDef<UploadPolicy>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.original.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.id}</div>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm">{row.original.destinationId ?? "queue only"}</span>
      ),
      header: "Destination",
      id: "destination",
    },
    {
      cell: ({ row }) => <span className="text-sm">{row.original.trigger}</span>,
      header: "Trigger",
      id: "trigger",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">{row.original.maxAttempts} attempts</span>
      ),
      header: "Attempts",
      id: "attempts",
    },
    {
      cell: ({ row }) => (
        <Badge variant={row.original.enabled ? "secondary" : "outline"}>
          {row.original.enabled ? "enabled" : "disabled"}
        </Badge>
      ),
      header: "Enabled",
      id: "enabled",
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
