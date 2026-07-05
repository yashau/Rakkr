import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { ChannelMapTemplate, RecorderNode } from "@rakkr/shared";
import { Pencil, PlusCircle } from "lucide-react";
import { toast } from "sonner";

import { ChannelMapTemplateCard } from "@/components/channel-map-template-card";
import { HintButton } from "@/components/hint-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { TruncateCell } from "@/components/ui/truncate-cell";
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

export function SettingsChannelMapsSection({
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
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ChannelMapTemplate>();
  const templatesQuery = useQuery({
    enabled: canRead,
    queryFn: api.channelMapTemplates,
    queryKey: ["channel-map-templates"],
  });
  const assignmentsQuery = useQuery({
    enabled: canRead,
    queryFn: api.channelMapAssignments,
    queryKey: ["channel-map-assignments"],
  });
  const plansQuery = useQuery({
    enabled: canRead,
    queryFn: api.channelMapAssignmentPlans,
    queryKey: ["channel-map-assignment-plans"],
  });
  const createMutation = useMutation({
    mutationFn: () => api.createChannelMapTemplate(defaultChannelMapTemplate()),
    onError: () =>
      toast.error("Create failed", {
        description: "The channel map template could not be created.",
      }),
    onSuccess: ({ data }) => {
      toast.success("Channel map created");
      void queryClient.invalidateQueries({ queryKey: ["channel-map-templates"] });
      setEditing(data);
    },
  });
  const templates = templatesQuery.data?.data ?? [];
  const assignments = assignmentsQuery.data?.data ?? [];
  const plans = plansQuery.data?.data ?? [];
  const columns = channelMapColumns({ assignmentCount, canManage, onEdit: setEditing });

  function assignmentCount(template: ChannelMapTemplate) {
    return assignments.filter((assignment) => assignment.templateId === template.id).length;
  }

  // Keep the dialog body bound to the freshest template revision after a
  // promote so assignment history and revision counters stay in sync.
  const editingTemplate = editing
    ? (templates.find((template) => template.id === editing.id) ?? editing)
    : undefined;

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Channel Maps</h2>
          <p className="text-sm text-muted-foreground">Reusable node and interface routing.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
            {templates.length} templates
          </Badge>
          <HintButton
            disabled={createMutation.isPending || !canManage}
            hint={canManage ? "Create channel map" : "Requires settings manage"}
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
          data={templates}
          emptyMessage="No channel map templates are configured."
          getRowId={(template) => template.id}
          isLoading={templatesQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        open={Boolean(editingTemplate)}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Channel Map</DialogTitle>
            <DialogDescription>
              Edit channel routing, promote revisions, and manage target assignments.
            </DialogDescription>
          </DialogHeader>
          {editingTemplate ? (
            <ChannelMapTemplateCard
              assignments={assignments}
              canManage={canManage}
              canReadNodes={canReadNodes}
              nodes={nodes}
              plans={plans}
              template={editingTemplate}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function channelMapColumns({
  assignmentCount,
  canManage,
  onEdit,
}: {
  assignmentCount: (template: ChannelMapTemplate) => number;
  canManage: boolean;
  onEdit: (template: ChannelMapTemplate) => void;
}): ColumnDef<ChannelMapTemplate>[] {
  const columns: ColumnDef<ChannelMapTemplate>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <TruncateCell className="max-w-64 font-medium text-foreground">
            {row.original.name}
          </TruncateCell>
          <TruncateCell className="max-w-64 font-mono text-xs text-muted-foreground">
            {row.original.id}
          </TruncateCell>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => <span className="text-sm">{row.original.channelMode}</span>,
      header: "Mode",
      id: "mode",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {row.original.entries.filter((entry) => entry.included).length} active
        </span>
      ),
      header: "Channels",
      id: "channels",
    },
    {
      cell: ({ row }) => (
        <Badge className={toneBadgeClass("info")} variant="outline">
          {assignmentCount(row.original)} targets
        </Badge>
      ),
      header: "Assignments",
      id: "assignments",
    },
    {
      cell: ({ row }) => (
        <Badge className={toneBadgeClass("neutral")} variant="outline">
          rev {row.original.revision}
        </Badge>
      ),
      header: "Revision",
      id: "revision",
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

function defaultChannelMapTemplate() {
  return {
    channelMode: "mono_to_stereo_mix" as const,
    entries: [
      {
        included: true,
        label: "Voice Channel 1",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    name: "Voice Mono To Stereo",
    tags: ["voice"],
  };
}
