import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CalendarDays,
  CalendarPlus,
  FileSearch,
  Pencil,
  PlusCircle,
  ShieldCheck,
  SkipForward,
  Trash2,
} from "lucide-react";
import { type RecorderNode, type ScheduleInput, type ScheduleSummary } from "@rakkr/shared";

import { FilterToolbar } from "@/components/filter-toolbar";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { ScheduleFormDialog } from "@/components/schedule-form-dialog";
import { ScheduleFilterFields } from "@/components/schedule-filters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { useDocumentTitle } from "@/lib/document-title";
import { nodePickerFilters } from "@/lib/node-page-helpers";
import {
  emptySchedulePageFilters,
  scheduleActionState,
  scheduleFilterChips,
  scheduleFiltersFromDraft,
  schedulePageActionPermissions,
  type ScheduleFilterKey,
  type SchedulePageActionPermissions,
  type SchedulePageFilterDraft,
} from "@/lib/schedule-page-helpers";
import {
  defaultDraft,
  draftToInput,
  recurrenceSummary,
  scheduleToDraft,
  type ScheduleDraft,
} from "@/lib/schedule-draft";
import { defaultPageSize } from "@/lib/server-pagination";
import { useServerPagination } from "@/lib/use-server-pagination";

const scheduleFilterDraftKeys: Record<ScheduleFilterKey, keyof SchedulePageFilterDraft> = {
  captureBackend: "captureBackend",
  captureInterfaceId: "captureInterfaceId",
  enabled: "enabled",
  nodeId: "nodeId",
  search: "search",
};

export function SchedulesPage() {
  useDocumentTitle("Schedules");

  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<ScheduleDraft>(() => defaultDraft());
  const [scheduleFilterDraft, setScheduleFilterDraft] =
    useState<SchedulePageFilterDraft>(emptySchedulePageFilters);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = schedulePageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const apiFilters = useMemo(
    () => scheduleFiltersFromDraft(scheduleFilterDraft),
    [scheduleFilterDraft],
  );
  const pagination = useServerPagination(apiFilters, { defaultPageSize });
  const schedulesQuery = useQuery({
    enabled: actionPermissions.canRead,
    placeholderData: keepPreviousData,
    queryFn: () => api.schedules(pagination.query),
    queryKey: ["schedules", pagination.query],
  });
  const nodesQuery = useQuery({
    enabled: actionPermissions.canReadNodes,
    queryFn: () => api.nodes(nodePickerFilters()),
    queryKey: ["nodes"],
  });
  const nodes = useMemo(() => nodesQuery.data?.data ?? [], [nodesQuery.data?.data]);
  const firstNode = nodes[0];
  const saveScheduleMutation = useMutation({
    mutationFn: ({ input, scheduleId }: { input: ScheduleInput; scheduleId?: string }) =>
      scheduleId ? api.updateSchedule(scheduleId, input) : api.createSchedule(input),
    onError: () =>
      toast.error("Save failed", {
        description: "The schedule could not be saved.",
      }),
    onSuccess: () => {
      toast.success(editingId ? "Schedule updated" : "Schedule created");
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      closeDialog();
    },
  });
  const runNowMutation = useMutation({
    mutationFn: api.runScheduleNow,
    onError: () =>
      toast.error("Run failed", {
        description: "The schedule could not be run now.",
      }),
    onSuccess: () => {
      toast.success("Schedule run started");
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
    },
  });
  const skipNextMutation = useMutation({
    mutationFn: api.skipScheduleNext,
    onError: () =>
      toast.error("Skip failed", {
        description: "The next scheduled run could not be skipped.",
      }),
    onSuccess: () => {
      toast.success("Next run skipped");
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });
  const deleteScheduleMutation = useMutation({
    mutationFn: api.deleteSchedule,
    onError: () =>
      toast.error("Delete failed", {
        description: "The schedule could not be deleted.",
      }),
    onSuccess: () => {
      toast.success("Schedule deleted");
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
  });

  // Seed the create draft with the first available node once nodes load, but
  // never clobber a node the operator already chose.
  useEffect(() => {
    if (draft.nodeId || !firstNode) {
      return;
    }

    setDraft((current) =>
      current.nodeId
        ? current
        : {
            ...current,
            nodeId: firstNode.id,
            room: firstNode.location.room,
          },
    );
  }, [draft.nodeId, firstNode]);

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading schedules" />;
  }

  if (!actionPermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Schedules</AlertTitle>
        <AlertDescription>Schedules are unavailable.</AlertDescription>
      </Alert>
    );
  }

  const schedules = schedulesQuery.data?.data ?? [];
  const meta = schedulesQuery.data?.meta;
  // Free-text search is inline in the toolbar; the slide-out chips/count cover
  // the remaining filters.
  const advancedFilterChips = scheduleFilterChips(apiFilters).filter(
    (chip) => chip.key !== "search",
  );
  const columns = scheduleColumns({
    nodes,
    onDelete: (scheduleId) => deleteScheduleMutation.mutate(scheduleId),
    onEdit: editSchedule,
    onRunNow: (scheduleId) => runNowMutation.mutate(scheduleId),
    onSkipNext: (scheduleId) => skipNextMutation.mutate(scheduleId),
    permissions: actionPermissions,
    pending: {
      delete: deleteScheduleMutation.isPending,
      runNow: runNowMutation.isPending,
      skipNext: skipNextMutation.isPending,
    },
  });

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Schedules</h2>
            <p className="text-sm text-muted-foreground">
              {meta?.total ?? schedules.length} matching schedules
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/schedules/calendar">
                  <CalendarDays className="size-4" />
                  Calendar
                </Link>
              }
            />
            {actionPermissions.canManage ? (
              <Button onClick={openCreate} type="button">
                <PlusCircle className="size-4" />
                Add schedule
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-4">
          <FilterToolbar
            chips={advancedFilterChips}
            onClearAll={() => setScheduleFilterDraft(emptySchedulePageFilters)}
            onClearChip={(key) => clearScheduleFilter(key as ScheduleFilterKey)}
            onSearchChange={(value) =>
              setScheduleFilterDraft((current) => ({ ...current, search: value }))
            }
            search={scheduleFilterDraft.search}
            searchPlaceholder="name, room, tag, policy"
            sheetDescription="Filter schedules by state, node, capture backend, and interface."
            sheetTitle="Filter schedules"
          >
            <ScheduleFilterFields
              filters={scheduleFilterDraft}
              nodes={nodes}
              onChange={setScheduleFilterDraft}
            />
          </FilterToolbar>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={schedules}
          emptyMessage="No schedules match the current filters."
          getRowId={(schedule) => schedule.id}
          isLoading={schedulesQuery.isPending}
        />
        <DataTablePagination
          meta={meta}
          onNext={pagination.nextPage}
          onPageSizeChange={pagination.setPageSize}
          onPrevious={pagination.previousPage}
          pageSize={pagination.pageSize}
          pageSizes={pagination.pageSizes}
        />
      </section>

      {actionPermissions.canManage ? (
        <ScheduleFormDialog
          draft={draft}
          editing={Boolean(editingId)}
          nodes={nodes}
          onDraftChange={setDraft}
          onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
          onSubmit={submitSchedule}
          open={dialogOpen}
          saving={saveScheduleMutation.isPending}
        />
      ) : null}
    </div>
  );

  function openCreate() {
    setEditingId(undefined);
    setDraft(defaultDraft(firstNode));
    setDialogOpen(true);
  }

  function editSchedule(schedule: ScheduleSummary) {
    setEditingId(schedule.id);
    setDraft(scheduleToDraft(schedule));
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(undefined);
    setDraft(defaultDraft(firstNode));
  }

  function submitSchedule() {
    saveScheduleMutation.mutate({
      input: draftToInput(draft),
      scheduleId: editingId,
    });
  }

  function clearScheduleFilter(key: ScheduleFilterKey) {
    setScheduleFilterDraft((current) => ({ ...current, [scheduleFilterDraftKeys[key]]: "" }));
  }
}

interface ScheduleColumnOptions {
  nodes: RecorderNode[];
  onDelete: (scheduleId: string) => void;
  onEdit: (schedule: ScheduleSummary) => void;
  onRunNow: (scheduleId: string) => void;
  onSkipNext: (scheduleId: string) => void;
  permissions: SchedulePageActionPermissions;
  pending: {
    delete: boolean;
    runNow: boolean;
    skipNext: boolean;
  };
}

function scheduleColumns({
  nodes,
  onDelete,
  onEdit,
  onRunNow,
  onSkipNext,
  permissions,
  pending,
}: ScheduleColumnOptions): ColumnDef<ScheduleSummary>[] {
  const columns: ColumnDef<ScheduleSummary>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <Link
            className="font-medium text-foreground hover:underline"
            params={{ scheduleId: row.original.id }}
            to="/schedules/$scheduleId"
          >
            {row.original.name}
          </Link>
          <div className="text-xs text-muted-foreground">
            {row.original.room} / {row.original.timezone}
          </div>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => <span className="text-sm">{nodeLabel(row.original.nodeId, nodes)}</span>,
      header: "Node",
      id: "node",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {recurrenceSummary(row.original.recurrence)}
        </span>
      ),
      header: "Recurrence",
      id: "recurrence",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {row.original.nextRunAt ? formatDateTime(row.original.nextRunAt) : "n/a"}
        </span>
      ),
      header: "Next run",
      id: "next-run",
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
    cell: ({ row }) => {
      const actions = scheduleActionState(row.original, permissions);

      return (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            type="button"
            variant="outline"
            nativeButton={false}
            render={
              <Link params={{ scheduleId: row.original.id }} to="/schedules/$scheduleId">
                <FileSearch className="size-4" />
                Details
              </Link>
            }
          />
          {permissions.canManage ? (
            <>
              <Button
                disabled={pending.runNow || !actions.canRunNow}
                onClick={() => onRunNow(row.original.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                <CalendarPlus className="size-4" />
                Run now
              </Button>
              <Button
                disabled={pending.skipNext || !actions.canSkipNext}
                onClick={() => onSkipNext(row.original.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                <SkipForward className="size-4" />
                Skip next
              </Button>
              <Button
                disabled={!actions.canEdit}
                onClick={() => onEdit(row.original)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Pencil className="size-4" />
                Edit
              </Button>
              <ConfirmButton
                confirmLabel="Delete"
                description={`This permanently deletes the schedule "${row.original.name}".`}
                disabled={pending.delete || !actions.canDelete}
                onConfirm={() => onDelete(row.original.id)}
                size="sm"
                title={`Delete schedule "${row.original.name}"?`}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete
              </ConfirmButton>
            </>
          ) : null}
        </div>
      );
    },
    header: () => <span className="sr-only">Actions</span>,
    id: "actions",
    meta: { cellClassName: "text-right", headClassName: "text-right" },
  });

  return columns;
}

function nodeLabel(nodeId: string, nodes: RecorderNode[]) {
  const node = nodes.find((candidate) => candidate.id === nodeId);

  return node ? node.alias : nodeId;
}
