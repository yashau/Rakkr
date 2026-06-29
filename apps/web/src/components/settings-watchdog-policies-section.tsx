import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { RecorderNode, WatchdogPolicy } from "@rakkr/shared";
import { Pencil } from "lucide-react";

import { WatchdogPolicyCard } from "@/components/watchdog-policy-card";
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

export function SettingsWatchdogPoliciesSection({
  canManage,
  canRead,
  canReadNodes,
  nodes,
}: {
  canManage: boolean;
  canRead: boolean;
  canReadNodes: boolean;
  nodes: RecorderNode[];
}) {
  const [editing, setEditing] = useState<WatchdogPolicy>();
  const policiesQuery = useQuery({
    enabled: canRead,
    queryFn: api.watchdogPolicies,
    queryKey: ["watchdog-policies"],
  });
  const policies = policiesQuery.data?.data ?? [];
  const columns = watchdogPolicyColumns({ canManage, onEdit: setEditing });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Watchdog Policies</h2>
          <p className="text-sm text-muted-foreground">Scheduled signal health thresholds.</p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {policies.length} policies
        </Badge>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={policies}
          emptyMessage="No watchdog policies are configured."
          getRowId={(policy) => policy.id}
          isLoading={policiesQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        open={Boolean(editing)}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Watchdog Policy</DialogTitle>
            <DialogDescription>
              Tune metric thresholds, quality alerts, and calibrate from room meter history.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <WatchdogPolicyCard
              canManage={canManage}
              canReadNodes={canReadNodes}
              nodes={nodes}
              onSaved={() => setEditing(undefined)}
              policy={editing}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function watchdogPolicyColumns({
  canManage,
  onEdit,
}: {
  canManage: boolean;
  onEdit: (policy: WatchdogPolicy) => void;
}): ColumnDef<WatchdogPolicy>[] {
  const columns: ColumnDef<WatchdogPolicy>[] = [
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
        <span className="text-sm whitespace-nowrap">
          {row.original.metric} below {row.original.thresholdDbfs} dBFS
        </span>
      ),
      header: "Metric",
      id: "metric",
    },
    {
      cell: ({ row }) => <span className="text-sm">{row.original.windowSeconds}s</span>,
      header: "Window",
      id: "window",
    },
    {
      cell: ({ row }) => (
        <Badge className={severityTone(row.original.severity)} variant="outline">
          {row.original.severity}
        </Badge>
      ),
      header: "Severity",
      id: "severity",
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

function severityTone(severity: WatchdogPolicy["severity"]) {
  if (severity === "critical") {
    return toneBadgeClass("critical");
  }

  if (severity === "warning") {
    return toneBadgeClass("warning");
  }

  return toneBadgeClass("info");
}
