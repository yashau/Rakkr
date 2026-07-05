import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { HealthEvent } from "@rakkr/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HeartPulse,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";

import { FilterField, FilterToolbar } from "@/components/filter-toolbar";
import { HintButton } from "@/components/hint-button";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { TruncateCell } from "@/components/ui/truncate-cell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { useDocumentTitle } from "@/lib/document-title";
import { toneBadgeClass, toneTileClass } from "@/lib/status-colors";
import {
  emptyHealthPageFilters,
  healthEventBulkActionTargets,
  healthEventFilterChips,
  healthEventFiltersFromDraft,
  healthEventSummary,
  healthEventTargetLabel,
  healthLifecycleActions,
  healthPagePermissions,
  readableHealthEventType,
  type HealthEventFilterKey,
  type HealthLifecycleAction,
  type HealthPageFilterDraft,
} from "@/lib/health-page-helpers";
import {
  defaultNodeHealthSuppressedUntil,
  nodeHealthLifecycleInput,
  nodePickerFilters,
} from "@/lib/node-page-helpers";
import { downloadBlob } from "@/lib/recording-page-helpers";
import { schedulePickerFilters } from "@/lib/schedule-page-helpers";
import { defaultPageSize } from "@/lib/server-pagination";
import { useServerPagination } from "@/lib/use-server-pagination";

const statuses: Array<"" | HealthEvent["status"]> = [
  "",
  "open",
  "acknowledged",
  "suppressed",
  "resolved",
];
const severities: Array<"" | HealthEvent["severity"]> = ["", "critical", "warning", "info"];
const selectClassName = "w-full";
const healthFilterDraftKeys: Record<HealthEventFilterKey, keyof HealthPageFilterDraft> = {
  nodeId: "nodeId",
  openedFrom: "openedFromDate",
  openedTo: "openedToDate",
  recordingId: "recordingId",
  resolvedFrom: "resolvedFromDate",
  resolvedTo: "resolvedToDate",
  scheduleId: "scheduleId",
  search: "search",
  severity: "severity",
  status: "status",
  type: "type",
};

export function HealthPage() {
  useDocumentTitle("Health");

  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<HealthPageFilterDraft>(emptyHealthPageFilters);
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const permissions = healthPagePermissions(currentUserQuery.data?.data);
  const apiFilters = useMemo(() => healthEventFiltersFromDraft(filters), [filters]);
  const pagination = useServerPagination(apiFilters, { defaultPageSize });
  const healthQuery = useQuery({
    enabled: permissions.canReadHealth,
    placeholderData: keepPreviousData,
    queryFn: () => api.healthEvents(pagination.query),
    queryKey: ["health-events", "workbench", pagination.query],
    refetchInterval: 5000,
  });
  const nodesQuery = useQuery({
    enabled: permissions.canReadNodes,
    queryFn: () => api.nodes(nodePickerFilters()),
    queryKey: ["nodes"],
  });
  const schedulesQuery = useQuery({
    enabled: permissions.canReadSchedules,
    queryFn: () => api.schedules(schedulePickerFilters()),
    queryKey: ["schedules"],
  });
  const recordingsQuery = useQuery({
    enabled: permissions.canReadRecordings,
    queryFn: () => api.recordings({ limit: 500 }),
    queryKey: ["recordings", "health-workbench"],
  });
  const healthLifecycleMutation = useMutation({
    mutationFn: ({
      action,
      eventId,
      suppressedUntil,
    }: {
      action: HealthLifecycleAction;
      eventId: string;
      suppressedUntil?: string;
    }) => api.updateHealthEventLifecycle(eventId, action, { suppressedUntil }),
    onError: () =>
      toast.error("Update failed", {
        description: "The health event could not be updated.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["node-health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    },
  });
  const healthBulkLifecycleMutation = useMutation({
    mutationFn: ({
      action,
      eventIds,
      suppressedUntil,
    }: {
      action: HealthLifecycleAction;
      eventIds: string[];
      suppressedUntil?: string;
    }) => api.updateHealthEventsLifecycle({ action, eventIds, suppressedUntil }),
    onError: () =>
      toast.error("Update failed", {
        description: "The selected health events could not be updated.",
      }),
    onSuccess: () => {
      setSelectedEventIds([]);
      void queryClient.invalidateQueries({ queryKey: ["health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["node-health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    },
  });
  const exportMutation = useMutation({
    mutationFn: () => api.healthEventsExport(apiFilters),
    onError: () =>
      toast.error("Export failed", {
        description: "The health event CSV export could not be generated.",
      }),
    onSuccess: downloadBlob,
  });
  const selectedExportMutation = useMutation({
    mutationFn: (eventIds: string[]) => api.healthEventsExportSelected({ eventIds }),
    onError: () =>
      toast.error("Export failed", {
        description: "The selected health event CSV export could not be generated.",
      }),
    onSuccess: downloadBlob,
  });

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading health events" />;
  }

  if (!permissions.canReadHealth) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Health Events</AlertTitle>
        <AlertDescription>Health events are unavailable.</AlertDescription>
      </Alert>
    );
  }

  const events = healthQuery.data?.data ?? [];
  const meta = healthQuery.data?.meta;
  // Free-text search is inline in the toolbar; the slide-out chips/count cover
  // the remaining filters.
  const advancedFilterChips = healthEventFilterChips(apiFilters).filter(
    (chip) => chip.key !== "search",
  );
  // Prefer the server-computed summary over the FULL filtered set; the
  // client-side count over `events` is only the current page and undercounts
  // once matches exceed the page size (it stays as a pre-first-response fallback).
  const summary = healthQuery.data?.summary ?? healthEventSummary(events);
  const visibleEventIds = events.map((event) => event.id);
  const selectedVisibleEventIds = selectedEventIds.filter((eventId) =>
    visibleEventIds.includes(eventId),
  );
  const lifecyclePending =
    healthLifecycleMutation.isPending || healthBulkLifecycleMutation.isPending;
  const columns = healthEventColumns({
    canManage: permissions.canAcknowledgeHealth,
    lifecyclePending: healthLifecycleMutation.isPending,
    lookups: {
      nodes: nodesQuery.data?.data,
      recordings: recordingsQuery.data?.data,
      schedules: schedulesQuery.data?.data,
    },
    onAction: (eventId, action) =>
      healthLifecycleMutation.mutate(nodeHealthLifecycleInput(eventId, action)),
    onToggleSelected: toggleSelectedEvent,
    selectedEventIds: selectedVisibleEventIds,
    selectionDisabled: lifecyclePending,
  });

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <HeartPulse className="size-5 text-primary" />
              <h2 className="text-lg font-semibold">Health Events</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {meta?.total ?? summary.total} matching events
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryTile
            icon={AlertTriangle}
            label="Active Critical"
            tone="critical"
            value={summary.activeCritical}
          />
          <SummaryTile icon={HeartPulse} label="Open" tone="warning" value={summary.open} />
          <SummaryTile icon={ShieldOff} label="Muted" tone="neutral" value={summary.suppressed} />
          <SummaryTile
            icon={CheckCircle2}
            label="Resolved"
            tone="healthy"
            value={summary.resolved}
          />
        </div>

        <div className="mt-4">
          <FilterToolbar
            actions={
              <Button
                disabled={exportMutation.isPending}
                onClick={() => exportMutation.mutate()}
                type="button"
                variant="outline"
              >
                <Download className="size-4" />
                Export CSV
              </Button>
            }
            chips={advancedFilterChips}
            onClearAll={() => setFilters(emptyHealthPageFilters)}
            onClearChip={(key) => clearActiveFilter(key as HealthEventFilterKey)}
            onSearchChange={(value) => setFilter("search", value)}
            search={filters.search}
            searchPlaceholder="too quiet, node, recording"
            sheetDescription="Filter by lifecycle state, severity, time windows, and related resources."
            sheetTitle="Filter health events"
          >
            <FilterField label="Status">
              <Select
                onValueChange={(value) =>
                  setFilter(
                    "status",
                    (value === "__all__" ? "" : value) as HealthPageFilterDraft["status"],
                  )
                }
                value={filters.status || "__all__"}
              >
                <SelectTrigger className={selectClassName}>
                  <SelectValue placeholder="all statuses" />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((status) => (
                    <SelectItem key={status || "all"} value={status || "__all__"}>
                      {status || "all statuses"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
            <FilterField label="Severity">
              <Select
                onValueChange={(value) =>
                  setFilter(
                    "severity",
                    (value === "__all__" ? "" : value) as HealthPageFilterDraft["severity"],
                  )
                }
                value={filters.severity || "__all__"}
              >
                <SelectTrigger className={selectClassName}>
                  <SelectValue placeholder="all severities" />
                </SelectTrigger>
                <SelectContent>
                  {severities.map((severity) => (
                    <SelectItem key={severity || "all"} value={severity || "__all__"}>
                      {severity || "all severities"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
            <FilterField label="Opened From">
              <DatePicker
                aria-label="Opened from"
                onChange={(value) => setFilter("openedFromDate", value)}
                value={filters.openedFromDate}
              />
            </FilterField>
            <FilterField label="Opened To">
              <DatePicker
                aria-label="Opened to"
                onChange={(value) => setFilter("openedToDate", value)}
                value={filters.openedToDate}
              />
            </FilterField>
            <FilterField label="Resolved From">
              <DatePicker
                aria-label="Resolved from"
                onChange={(value) => setFilter("resolvedFromDate", value)}
                value={filters.resolvedFromDate}
              />
            </FilterField>
            <FilterField label="Resolved To">
              <DatePicker
                aria-label="Resolved to"
                onChange={(value) => setFilter("resolvedToDate", value)}
                value={filters.resolvedToDate}
              />
            </FilterField>
            <FilterField label="Type">
              <Input
                onChange={(event) => setFilter("type", event.target.value)}
                placeholder="watchdog.node_offline"
                value={filters.type}
              />
            </FilterField>
            <FilterField label="Node">
              <Input
                onChange={(event) => setFilter("nodeId", event.target.value)}
                value={filters.nodeId}
              />
            </FilterField>
            <FilterField label="Schedule">
              <Input
                onChange={(event) => setFilter("scheduleId", event.target.value)}
                value={filters.scheduleId}
              />
            </FilterField>
            <FilterField label="Recording">
              <Input
                onChange={(event) => setFilter("recordingId", event.target.value)}
                value={filters.recordingId}
              />
            </FilterField>
          </FilterToolbar>
        </div>

        <BulkHealthActions
          canManage={permissions.canAcknowledgeHealth}
          events={events}
          exportPending={selectedExportMutation.isPending}
          onAction={runBulkAction}
          onExport={() => selectedExportMutation.mutate(selectedVisibleEventIds)}
          onToggleAll={(checked) => setSelectedEventIds(checked ? visibleEventIds : [])}
          pending={lifecyclePending}
          selectedEventIds={selectedVisibleEventIds}
        />
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={events}
          emptyMessage="No health events match the current filters."
          getRowId={(event) => event.id}
          isLoading={healthQuery.isPending}
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
    </div>
  );

  function setFilter<Key extends keyof HealthPageFilterDraft>(
    key: Key,
    value: HealthPageFilterDraft[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clearActiveFilter(key: HealthEventFilterKey) {
    setFilters((current) => ({ ...current, [healthFilterDraftKeys[key]]: "" }));
  }

  function toggleSelectedEvent(eventId: string, checked: boolean) {
    setSelectedEventIds((current) => {
      if (checked) {
        return current.includes(eventId) ? current : [...current, eventId];
      }

      return current.filter((candidate) => candidate !== eventId);
    });
  }

  function runBulkAction(action: HealthLifecycleAction) {
    const targets = healthEventBulkActionTargets(events, selectedVisibleEventIds, action);

    if (targets.length === 0) {
      return;
    }

    healthBulkLifecycleMutation.mutate({
      action,
      eventIds: targets.map((event) => event.id),
      suppressedUntil: action === "suppress" ? defaultNodeHealthSuppressedUntil() : undefined,
    });
  }
}

function SummaryTile({
  icon: Icon,
  label,
  tone,
  value,
}: {
  icon: typeof HeartPulse;
  label: string;
  tone: "critical" | "healthy" | "neutral" | "warning";
  value: number;
}) {
  return (
    <div className={`rounded-md border p-3 ${summaryToneClass(tone)}`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4" />
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function BulkHealthActions({
  canManage,
  events,
  exportPending,
  onAction,
  onExport,
  onToggleAll,
  pending,
  selectedEventIds,
}: {
  canManage: boolean;
  events: HealthEvent[];
  exportPending: boolean;
  onAction: (action: HealthLifecycleAction) => void;
  onExport: () => void;
  onToggleAll: (checked: boolean) => void;
  pending: boolean;
  selectedEventIds: string[];
}) {
  const allSelected = events.length > 0 && selectedEventIds.length === events.length;
  const actions: HealthLifecycleAction[] = ["acknowledge", "suppress", "resolve", "reopen"];
  const selectionPending = pending || exportPending;

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-transparent p-3 md:flex-row md:items-center md:justify-between">
      <label
        className="flex items-center gap-2 text-sm text-muted-foreground"
        htmlFor="health-bulk-select-all"
      >
        <Checkbox
          checked={allSelected}
          disabled={selectionPending || events.length === 0}
          id="health-bulk-select-all"
          onCheckedChange={(value) => onToggleAll(value === true)}
        />
        {selectedEventIds.length} selected
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={exportPending || selectedEventIds.length === 0}
          onClick={onExport}
          size="sm"
          type="button"
          variant="outline"
        >
          <Download className="size-4" />
          Export {selectedEventIds.length}
        </Button>
        {canManage
          ? actions.map((action) => {
              const targetCount = healthEventBulkActionTargets(
                events,
                selectedEventIds,
                action,
              ).length;

              return (
                <Button
                  disabled={pending || targetCount === 0}
                  key={action}
                  onClick={() => onAction(action)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <HealthActionIcon action={action} />
                  {actionLabel(action)} {targetCount}
                </Button>
              );
            })
          : null}
      </div>
    </div>
  );
}

interface HealthEventColumnOptions {
  canManage: boolean;
  lifecyclePending: boolean;
  lookups: Parameters<typeof healthEventTargetLabel>[1];
  onAction: (eventId: string, action: HealthLifecycleAction) => void;
  onToggleSelected: (eventId: string, checked: boolean) => void;
  selectedEventIds: string[];
  selectionDisabled: boolean;
}

function healthEventColumns({
  canManage,
  lifecyclePending,
  lookups,
  onAction,
  onToggleSelected,
  selectedEventIds,
  selectionDisabled,
}: HealthEventColumnOptions): ColumnDef<HealthEvent>[] {
  const columns: ColumnDef<HealthEvent>[] = [
    {
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select event"
          checked={selectedEventIds.includes(row.original.id)}
          disabled={selectionDisabled}
          onCheckedChange={(value) => onToggleSelected(row.original.id, value === true)}
        />
      ),
      header: () => <span className="sr-only">Select</span>,
      id: "select",
      meta: { cellClassName: "w-8", headClassName: "w-8" },
    },
    {
      cell: ({ row }) => (
        <Badge className={severityClass(row.original.severity)} variant="outline">
          {row.original.severity}
        </Badge>
      ),
      header: "Severity",
      id: "severity",
    },
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <TruncateCell className="max-w-64 font-medium">
            {readableHealthEventType(row.original.type)}
          </TruncateCell>
          <TruncateCell className="max-w-64 font-mono text-xs text-muted-foreground">
            {row.original.id}
          </TruncateCell>
        </div>
      ),
      header: "Type",
      id: "type",
    },
    {
      cell: ({ row }) => (
        <Badge variant={row.original.status === "resolved" ? "secondary" : "outline"}>
          {row.original.status}
        </Badge>
      ),
      header: "Status",
      id: "status",
    },
    {
      cell: ({ row }) => (
        <div className="text-xs whitespace-nowrap text-muted-foreground">
          <div>{formatDateTime(row.original.openedAt)}</div>
          {row.original.suppressedUntil ? (
            <div>Muted until {formatDateTime(row.original.suppressedUntil)}</div>
          ) : null}
          {row.original.resolvedAt ? (
            <div>Resolved {formatDateTime(row.original.resolvedAt)}</div>
          ) : null}
        </div>
      ),
      header: "Opened",
      id: "opened",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {healthEventTargetLabel(row.original, lookups) || row.original.id}
        </span>
      ),
      header: "Target",
      id: "target",
      meta: { truncateClassName: "max-w-56" },
    },
  ];

  if (canManage) {
    columns.push({
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          {healthLifecycleActions(row.original.status).map((action) => (
            <HintButton
              disabled={lifecyclePending}
              hint={action === "suppress" ? "Suppress this health event for one hour" : action}
              key={action}
              onClick={() => onAction(row.original.id, action)}
              size="sm"
              variant="outline"
            >
              <HealthActionIcon action={action} />
              {actionLabel(action)}
            </HintButton>
          ))}
        </div>
      ),
      header: "Actions",
      id: "actions",
      meta: { cellClassName: "text-right", headClassName: "text-right" },
    });
  }

  return columns;
}

function HealthActionIcon({ action }: { action: HealthLifecycleAction }) {
  if (action === "reopen") {
    return <RotateCcw className="size-4" />;
  }

  if (action === "suppress") {
    return <ShieldOff className="size-4" />;
  }

  return <CheckCircle2 className="size-4" />;
}

function actionLabel(action: HealthLifecycleAction) {
  if (action === "acknowledge") {
    return "Ack";
  }

  if (action === "suppress") {
    return "Mute 1h";
  }

  return action.charAt(0).toUpperCase() + action.slice(1);
}

function severityClass(severity: HealthEvent["severity"]) {
  if (severity === "critical") {
    return toneBadgeClass("critical");
  }

  if (severity === "warning") {
    return toneBadgeClass("warning");
  }

  return toneBadgeClass("info");
}

function summaryToneClass(tone: "critical" | "healthy" | "neutral" | "warning") {
  return toneTileClass(tone);
}
