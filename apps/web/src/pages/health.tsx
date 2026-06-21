import { type ReactNode, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HealthEvent } from "@rakkr/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HeartPulse,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
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
} from "@/lib/node-page-helpers";
import { downloadBlob } from "@/lib/recording-page-helpers";

const statuses: Array<"" | HealthEvent["status"]> = [
  "",
  "open",
  "acknowledged",
  "suppressed",
  "resolved",
];
const severities: Array<"" | HealthEvent["severity"]> = ["", "critical", "warning", "info"];
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
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
  const healthQuery = useQuery({
    enabled: permissions.canReadHealth,
    queryFn: () => api.healthEvents(apiFilters),
    queryKey: ["health-events", "workbench", apiFilters],
    refetchInterval: 5000,
  });
  const nodesQuery = useQuery({
    enabled: permissions.canReadNodes,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const schedulesQuery = useQuery({
    enabled: permissions.canReadSchedules,
    queryFn: () => api.schedules(),
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
    onSuccess: downloadBlob,
  });
  const selectedExportMutation = useMutation({
    mutationFn: (eventIds: string[]) => api.healthEventsExportSelected({ eventIds }),
    onSuccess: downloadBlob,
  });

  if (currentUserQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading health events.</p>;
  }

  if (!permissions.canReadHealth) {
    return (
      <Card className="rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Health Events</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Health events are unavailable.</p>
      </Card>
    );
  }

  const events = healthQuery.data?.data ?? [];
  const activeFilterChips = healthEventFilterChips(apiFilters);
  const summary = healthEventSummary(events);
  const visibleEventIds = events.map((event) => event.id);
  const selectedVisibleEventIds = selectedEventIds.filter((eventId) =>
    visibleEventIds.includes(eventId),
  );
  const lifecyclePending =
    healthLifecycleMutation.isPending || healthBulkLifecycleMutation.isPending;

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <HeartPulse className="size-5 text-teal-700" />
              <h2 className="text-lg font-semibold">Health Events</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{summary.total} visible events</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={exportMutation.isPending}
              onClick={() => exportMutation.mutate()}
              type="button"
              variant="outline"
            >
              <Download className="size-4" />
              Export CSV
            </Button>
            <Button
              onClick={() => setFilters(emptyHealthPageFilters)}
              type="button"
              variant="outline"
            >
              <RotateCcw className="size-4" />
              Reset
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
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

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label="Status">
            <select
              className={selectClassName}
              onChange={(event) =>
                setFilter("status", event.target.value as HealthPageFilterDraft["status"])
              }
              value={filters.status}
            >
              {statuses.map((status) => (
                <option key={status || "all"} value={status}>
                  {status || "all statuses"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select
              className={selectClassName}
              onChange={(event) =>
                setFilter("severity", event.target.value as HealthPageFilterDraft["severity"])
              }
              value={filters.severity}
            >
              {severities.map((severity) => (
                <option key={severity || "all"} value={severity}>
                  {severity || "all severities"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <Input
              onChange={(event) => setFilter("search", event.target.value)}
              placeholder="too quiet, node, recording"
              value={filters.search}
            />
          </Field>
          <Field label="Opened From">
            <Input
              onChange={(event) => setFilter("openedFromDate", event.target.value)}
              type="date"
              value={filters.openedFromDate}
            />
          </Field>
          <Field label="Opened To">
            <Input
              onChange={(event) => setFilter("openedToDate", event.target.value)}
              type="date"
              value={filters.openedToDate}
            />
          </Field>
          <Field label="Resolved From">
            <Input
              onChange={(event) => setFilter("resolvedFromDate", event.target.value)}
              type="date"
              value={filters.resolvedFromDate}
            />
          </Field>
          <Field label="Resolved To">
            <Input
              onChange={(event) => setFilter("resolvedToDate", event.target.value)}
              type="date"
              value={filters.resolvedToDate}
            />
          </Field>
          <Field label="Type">
            <Input
              onChange={(event) => setFilter("type", event.target.value)}
              placeholder="watchdog.node_offline"
              value={filters.type}
            />
          </Field>
          <Field label="Limit">
            <Input
              min={1}
              onChange={(event) => setFilter("limit", event.target.value)}
              type="number"
              value={filters.limit}
            />
          </Field>
          <Field label="Node">
            <Input
              onChange={(event) => setFilter("nodeId", event.target.value)}
              value={filters.nodeId}
            />
          </Field>
          <Field label="Schedule">
            <Input
              onChange={(event) => setFilter("scheduleId", event.target.value)}
              value={filters.scheduleId}
            />
          </Field>
          <Field label="Recording">
            <Input
              onChange={(event) => setFilter("recordingId", event.target.value)}
              value={filters.recordingId}
            />
          </Field>
        </div>

        {activeFilterChips.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {activeFilterChips.map((filter) => (
              <Badge
                className="max-w-full gap-1 overflow-hidden bg-background pr-1"
                key={filter.key}
                variant="outline"
              >
                <span className="shrink-0 text-muted-foreground">{filter.label}</span>
                <span className="truncate font-mono">{filter.value}</span>
                <button
                  aria-label={`Clear ${filter.label} filter`}
                  className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => clearActiveFilter(filter.key)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : null}

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

      <section className="grid gap-3">
        {events.map((event) => (
          <HealthEventRow
            canManage={permissions.canAcknowledgeHealth}
            event={event}
            key={event.id}
            lookups={{
              nodes: nodesQuery.data?.data,
              recordings: recordingsQuery.data?.data,
              schedules: schedulesQuery.data?.data,
            }}
            onAction={(action) =>
              healthLifecycleMutation.mutate(nodeHealthLifecycleInput(event.id, action))
            }
            onSelectionChange={(checked) => toggleSelectedEvent(event.id, checked)}
            pending={healthLifecycleMutation.isPending}
            selected={selectedVisibleEventIds.includes(event.id)}
          />
        ))}
        {!healthQuery.isPending && events.length === 0 ? (
          <Card className="rounded-lg p-4 text-sm text-muted-foreground shadow-sm">
            No health events match the current filters.
          </Card>
        ) : null}
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

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
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
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          checked={allSelected}
          className="size-4 rounded border-border"
          disabled={selectionPending || events.length === 0}
          onChange={(event) => onToggleAll(event.target.checked)}
          type="checkbox"
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

function HealthEventRow({
  canManage,
  event,
  lookups,
  onAction,
  onSelectionChange,
  pending,
  selected,
}: {
  canManage: boolean;
  event: HealthEvent;
  lookups: Parameters<typeof healthEventTargetLabel>[1];
  onAction: (action: HealthLifecycleAction) => void;
  onSelectionChange: (checked: boolean) => void;
  pending: boolean;
  selected: boolean;
}) {
  const target = healthEventTargetLabel(event, lookups);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="flex gap-3">
        <input
          checked={selected}
          className="mt-1 size-4 rounded border-border"
          disabled={pending}
          onChange={(input) => onSelectionChange(input.target.checked)}
          type="checkbox"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={severityClass(event.severity)} variant="outline">
                  {event.severity}
                </Badge>
                <span className="font-medium">{readableHealthEventType(event.type)}</span>
                <Badge variant={event.status === "resolved" ? "secondary" : "outline"}>
                  {event.status}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>{formatDateTime(event.openedAt)}</span>
                {event.acknowledgedAt ? (
                  <span>Ack {formatDateTime(event.acknowledgedAt)}</span>
                ) : null}
                {event.suppressedUntil ? (
                  <span>Muted until {formatDateTime(event.suppressedUntil)}</span>
                ) : null}
                {event.resolvedAt ? <span>Resolved {formatDateTime(event.resolvedAt)}</span> : null}
              </div>
              <div className="mt-2 text-sm wrap-break-word text-muted-foreground">
                {target || event.id}
              </div>
              <div className="mt-2 font-mono text-xs text-muted-foreground">{event.id}</div>
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2 lg:justify-end">
                {healthLifecycleActions(event.status).map((action) => (
                  <Button
                    disabled={pending}
                    key={action}
                    onClick={() => onAction(action)}
                    size="sm"
                    title={
                      action === "suppress" ? "Suppress this health event for one hour" : action
                    }
                    variant="outline"
                  >
                    <HealthActionIcon action={action} />
                    {actionLabel(action)}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
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
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (severity === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-sky-200 bg-sky-50 text-sky-700";
}

function summaryToneClass(tone: "critical" | "healthy" | "neutral" | "warning") {
  if (tone === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }

  if (tone === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }

  if (tone === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }

  return "border-border bg-background text-foreground";
}
