import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { RetentionPolicy } from "@rakkr/shared";
import { Pencil, PlusCircle } from "lucide-react";
import { toast } from "sonner";

import { HintButton } from "@/components/hint-button";
import {
  RetentionPolicyEditor,
  defaultRetentionPolicyInput,
} from "@/components/retention-policy-panel";
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

export function SettingsRetentionPoliciesSection({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RetentionPolicy>();
  const policiesQuery = useQuery({
    enabled: canRead,
    queryFn: api.retentionPolicies,
    queryKey: ["retention-policies"],
  });
  const createMutation = useMutation({
    mutationFn: () => api.createRetentionPolicy(defaultRetentionPolicyInput()),
    onError: () =>
      toast.error("Create failed", {
        description: "The retention policy could not be created.",
      }),
    onSuccess: ({ data }) => {
      toast.success("Retention policy created");
      void queryClient.invalidateQueries({ queryKey: ["retention-policies"] });
      setEditing(data);
    },
  });
  const policies = policiesQuery.data?.data ?? [];
  const columns = retentionPolicyColumns({ canManage, onEdit: setEditing });

  return (
    <div className="grid gap-4">
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
          <HintButton
            disabled={createMutation.isPending || !canManage}
            hint={canManage ? "Create retention policy" : "Requires settings manage"}
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
          emptyMessage="No retention policies are configured."
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
            <DialogTitle>Edit Retention Policy</DialogTitle>
            <DialogDescription>
              Set scope, action, size and age thresholds, and preservation rules.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <RetentionPolicyEditor
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

function retentionPolicyColumns({
  canManage,
  onEdit,
}: {
  canManage: boolean;
  onEdit: (policy: RetentionPolicy) => void;
}): ColumnDef<RetentionPolicy>[] {
  const columns: ColumnDef<RetentionPolicy>[] = [
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
      cell: ({ row }) => <span className="text-sm">{row.original.scope}</span>,
      header: "Scope",
      id: "scope",
    },
    {
      cell: ({ row }) => <span className="text-sm">{row.original.action}</span>,
      header: "Action",
      id: "action",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {row.original.maxAgeDays ? `${row.original.maxAgeDays}d` : "no age"}
        </span>
      ),
      header: "Max Age",
      id: "max-age",
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
