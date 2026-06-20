import { type ReactNode, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HealthEvent } from "@rakkr/shared";
import {
  AlertTriangle,
  CheckCircle2,
  HeartPulse,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
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
  healthEventFiltersFromDraft,
  healthEventSummary,
  healthEventTargetLabel,
  healthPagePermissions,
  readableHealthEventType,
  type HealthPageFilterDraft,
} from "@/lib/health-page-helpers";
import {
  nodeHealthLifecycleActions,
  nodeHealthLifecycleInput,
  type NodeHealthLifecycleAction,
} from "@/lib/node-page-helpers";

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

export function HealthPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<HealthPageFilterDraft>(emptyHealthPageFilters);
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
    queryFn: api.schedules,
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
      action: NodeHealthLifecycleAction;
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
  const summary = healthEventSummary(events);

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
          <Button
            onClick={() => setFilters(emptyHealthPageFilters)}
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-4" />
            Reset
          </Button>
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
            pending={healthLifecycleMutation.isPending}
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

function HealthEventRow({
  canManage,
  event,
  lookups,
  onAction,
  pending,
}: {
  canManage: boolean;
  event: HealthEvent;
  lookups: Parameters<typeof healthEventTargetLabel>[1];
  onAction: (action: NodeHealthLifecycleAction) => void;
  pending: boolean;
}) {
  const target = healthEventTargetLabel(event, lookups);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
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
            {event.acknowledgedAt ? <span>Ack {formatDateTime(event.acknowledgedAt)}</span> : null}
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
            {nodeHealthLifecycleActions(event.status).map((action) => (
              <Button
                disabled={pending}
                key={action}
                onClick={() => onAction(action)}
                size="sm"
                title={action === "suppress" ? "Suppress this health event for one hour" : action}
                variant="outline"
              >
                <HealthActionIcon action={action} />
                {actionLabel(action)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function HealthActionIcon({ action }: { action: NodeHealthLifecycleAction }) {
  if (action === "reopen") {
    return <RotateCcw className="size-4" />;
  }

  if (action === "suppress") {
    return <ShieldOff className="size-4" />;
  }

  return <CheckCircle2 className="size-4" />;
}

function actionLabel(action: NodeHealthLifecycleAction) {
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
