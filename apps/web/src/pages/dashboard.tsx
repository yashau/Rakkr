import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Network,
  Radio,
  ShieldCheck,
  Square,
} from "lucide-react";

import { HintButton } from "@/components/hint-button";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { RecordingStartPanel } from "@/components/recording-start-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  dashboardActiveRecordingJobs,
  dashboardActiveHealthEvents,
  dashboardIncidentActions,
  dashboardPagePermissions,
  type DashboardIncidentAction,
} from "@/lib/dashboard-page-helpers";
import { formatDateTime } from "@/lib/dates";
import { healthEventTargetLabel, readableHealthEventType } from "@/lib/health-page-helpers";
import { recordingJobStatusClass, recordingJobStopActionState } from "@/lib/jobs-page-helpers";
import { nodePickerFilters } from "@/lib/node-page-helpers";
import { nodeStatusBadgeClass } from "@/lib/node-status";
import { toneBadgeClass } from "@/lib/status-colors";

export function DashboardPage() {
  const queryClient = useQueryClient();
  const setNotice = (next: { detail: string; title: string }) =>
    toast(next.title, { description: next.detail });
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const pagePermissions = dashboardPagePermissions(currentUserQuery.data?.data);
  const statusQuery = useQuery({
    enabled: pagePermissions.canRead,
    queryFn: api.status,
    queryKey: ["status"],
    refetchInterval: 5000,
  });
  const nodesQuery = useQuery({
    enabled: pagePermissions.canRead,
    queryFn: () => api.nodes(nodePickerFilters()),
    queryKey: ["nodes"],
    refetchInterval: 5000,
  });
  const healthEventsQuery = useQuery({
    enabled: pagePermissions.canRead && pagePermissions.canReadHealth,
    queryFn: () => api.healthEvents({ limit: 50 }),
    queryKey: ["health-events", "dashboard"],
    refetchInterval: 5000,
  });
  const recordingJobsQuery = useQuery({
    enabled: pagePermissions.canReadRecordings,
    queryFn: () => api.recordingJobs(),
    queryKey: ["recording-jobs", "dashboard"],
    refetchInterval: 3000,
  });
  const incidentActionMutation = useMutation({
    mutationFn: ({ action, eventId }: { action: DashboardIncidentAction; eventId: string }) =>
      api.updateHealthEventLifecycle(eventId, action, {}),
    onError: () =>
      toast.error("Update failed", {
        description: "The incident could not be updated.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });
  const stopRecordingMutation = useMutation({
    mutationFn: api.stopRecording,
    onError: () =>
      setNotice({
        detail: "The selected recording job could not be stopped.",
        title: "Stop failed",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      setNotice({
        detail: "A stop request was sent to the recorder node.",
        title: "Stop requested",
      });
    },
  });

  const status = statusQuery.data;
  const nodes = nodesQuery.data?.data ?? [];
  const activeNodes = nodes.filter((node) => node.status !== "offline");
  const activeHealthEvents = dashboardActiveHealthEvents(healthEventsQuery.data?.data ?? []);
  const activeRecordingJobs = dashboardActiveRecordingJobs(recordingJobsQuery.data?.data ?? []);
  const nodeAlias = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.alias ?? nodeId;

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading dashboard" />;
  }

  if (!pagePermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Dashboard</AlertTitle>
        <AlertDescription>Dashboard is unavailable.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<CheckCircle2 className="size-7 text-emerald-600 dark:text-emerald-400" />}
          label="Online nodes"
          to="/nodes"
          value={`${status?.onlineNodes ?? 0}/${status?.nodeCount ?? 0}`}
        />
        <StatCard
          icon={<Radio className="size-7 text-teal-600 dark:text-teal-400" />}
          label="Active recordings"
          to="/jobs"
          value={String(status?.activeRecordings ?? 0)}
        />
        <StatCard
          icon={<HardDrive className="size-7 text-zinc-700 dark:text-zinc-300" />}
          label="Cached recordings"
          to="/recordings"
          value={String(status?.cachedRecordings ?? 0)}
        />
        <StatCard
          icon={<AlertTriangle className="size-7 text-amber-600 dark:text-amber-400" />}
          label="Critical alerts"
          to="/health"
          value={String(status?.criticalAlerts ?? 0)}
        />
      </div>

      {pagePermissions.canCreateRecordings ? (
        <RecordingStartPanel
          canReadNodes={pagePermissions.canRead}
          canReadSettings={pagePermissions.canReadSettings}
          onNotice={setNotice}
        />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Active Nodes</h2>
              <p className="text-xs text-muted-foreground">
                {activeNodes.length} of {nodes.length} reporting
              </p>
            </div>
            <Network className="size-5 text-teal-700 dark:text-teal-400" />
          </div>

          {activeNodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No nodes are currently online.</p>
          ) : (
            <div className="grid gap-2">
              {activeNodes.map((node) => (
                <Link
                  className="block rounded-md border border-border bg-muted/20 p-2 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  key={node.id}
                  to="/nodes"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{node.alias}</span>
                    <Badge className={nodeStatusBadgeClass(node.status)} variant="outline">
                      {node.status}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {node.location.room}
                      {node.location.site ? ` · ${node.location.site}` : ""}
                    </span>
                    <span className="shrink-0">{formatDateTime(node.lastSeenAt)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <div className="grid gap-5">
          <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Active Recordings</h2>
                <p className="text-xs text-muted-foreground">
                  {pagePermissions.canReadRecordings
                    ? `${activeRecordingJobs.length} in progress`
                    : "Recording jobs unavailable"}
                </p>
              </div>
              <Radio className="size-5 text-teal-700 dark:text-teal-400" />
            </div>

            {!pagePermissions.canReadRecordings ? (
              <p className="text-sm text-muted-foreground">Requires recording read permission.</p>
            ) : activeRecordingJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active recordings.</p>
            ) : (
              <div className="grid gap-2">
                {activeRecordingJobs.map((job) => {
                  const stopAction = recordingJobStopActionState(
                    job,
                    pagePermissions.canControlRecordings,
                  );

                  return (
                    <div
                      className="rounded-md border border-border bg-muted/20 p-2 text-sm"
                      key={job.id}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge className={recordingJobStatusClass(job.status)} variant="outline">
                          {job.status}
                        </Badge>
                        <span className="truncate font-medium">{nodeAlias(job.nodeId)}</span>
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {job.recordingId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {job.startedAt
                          ? `Started ${formatDateTime(job.startedAt)}`
                          : `Created ${formatDateTime(job.createdAt)}`}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge className="bg-background" variant="outline">
                          {job.command.captureBackend ?? "alsa"}
                        </Badge>
                        {pagePermissions.canControlRecordings ? (
                          <HintButton
                            disabled={!stopAction.canStop || stopRecordingMutation.isPending}
                            hint={stopAction.title}
                            onClick={() => stopRecordingMutation.mutate(job.recordingId)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Square className="size-4" />
                            Stop
                          </HintButton>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Active Incidents</h2>
                <p className="text-xs text-muted-foreground">
                  {pagePermissions.canReadHealth
                    ? `${activeHealthEvents.length} highlighted`
                    : "Health events unavailable"}
                </p>
              </div>
              <AlertTriangle className="size-5 text-amber-600 dark:text-amber-400" />
            </div>

            {!pagePermissions.canReadHealth ? (
              <p className="text-sm text-muted-foreground">Requires health read permission.</p>
            ) : activeHealthEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active health incidents.</p>
            ) : (
              <div className="grid gap-2">
                {activeHealthEvents.map((event) => (
                  <div
                    className="rounded-md border border-border bg-muted/20 p-2 text-sm"
                    key={event.id}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge className={healthSeverityClass(event.severity)} variant="outline">
                        {event.severity}
                      </Badge>
                      <Badge variant="secondary">{event.status}</Badge>
                    </div>
                    <div className="font-medium">{readableHealthEventType(event.type)}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {healthEventTargetLabel(event, { nodes }) || "Unscoped"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Opened {formatDateTime(event.openedAt)}
                    </div>
                    {pagePermissions.canAcknowledgeHealth ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {dashboardIncidentActions(event.status).map((action) => (
                          <Button
                            disabled={incidentActionMutation.isPending}
                            key={action}
                            onClick={() =>
                              incidentActionMutation.mutate({ action, eventId: event.id })
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {incidentActionLabel(action)}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {incidentActionMutation.isError ? (
              <p className="mt-2 text-sm text-destructive">Incident update failed.</p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  to,
  value,
}: {
  icon: ReactNode;
  label: string;
  to: "/health" | "/jobs" | "/nodes" | "/recordings";
  value: string;
}) {
  return (
    <Link
      className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      to={to}
    >
      <Card className="rounded-lg p-4 shadow-sm transition-colors hover:bg-muted/40">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold">{value}</p>
          </div>
          {icon}
        </div>
      </Card>
    </Link>
  );
}

function healthSeverityClass(severity: "critical" | "info" | "warning") {
  return toneBadgeClass(severity);
}

function incidentActionLabel(action: DashboardIncidentAction) {
  return action === "acknowledge" ? "Acknowledge" : "Resolve";
}
