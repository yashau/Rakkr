import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HardDrive, Radio, ShieldCheck, Square } from "lucide-react";

import { HintButton } from "@/components/hint-button";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { MeterBank } from "@/components/meter-bank";
import { RecordingStartPanel } from "@/components/recording-start-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  dashboardActiveRecordingJobs,
  dashboardActiveHealthEvents,
  dashboardIncidentActions,
  dashboardPagePermissions,
  dashboardSelectedNodeId,
  type DashboardIncidentAction,
} from "@/lib/dashboard-page-helpers";
import { formatDateTime } from "@/lib/dates";
import { healthEventTargetLabel, readableHealthEventType } from "@/lib/health-page-helpers";
import { recordingJobStatusClass, recordingJobStopActionState } from "@/lib/jobs-page-helpers";
import { nodeStatusBadgeClass } from "@/lib/node-status";
import { toneBadgeClass } from "@/lib/status-colors";

export function DashboardPage() {
  const queryClient = useQueryClient();
  const setNotice = (next: { detail: string; title: string }) =>
    toast(next.title, { description: next.detail });
  const [selectedNodeId, setSelectedNodeId] = useState("");
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
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
    refetchInterval: 5000,
  });
  const healthEventsQuery = useQuery({
    enabled: pagePermissions.canRead && pagePermissions.canReadHealth,
    queryFn: () => api.healthEvents({ limit: 50 }),
    queryKey: ["health-events", "dashboard"],
    refetchInterval: 5000,
  });

  const nodes = nodesQuery.data?.data ?? [];
  const visibleSelectedNodeId = dashboardSelectedNodeId(selectedNodeId, nodes);
  const node = nodes.find((candidate) => candidate.id === visibleSelectedNodeId);
  const recordingJobsQuery = useQuery({
    enabled: pagePermissions.canReadRecordings && Boolean(visibleSelectedNodeId),
    queryFn: () => api.recordingJobs({ nodeId: visibleSelectedNodeId }),
    queryKey: ["recording-jobs", "dashboard", visibleSelectedNodeId],
    refetchInterval: 3000,
  });
  const meterQuery = useQuery({
    enabled: pagePermissions.canReadMeters && Boolean(visibleSelectedNodeId),
    queryFn: () => api.meterFrame(visibleSelectedNodeId),
    queryKey: ["meters", visibleSelectedNodeId],
    refetchInterval: 1000,
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
  const levels = meterQuery.data?.data.levels ?? [];
  const activeHealthEvents = dashboardActiveHealthEvents(healthEventsQuery.data?.data ?? []);
  const activeRecordingJobs = dashboardActiveRecordingJobs(recordingJobsQuery.data?.data ?? []);

  useEffect(() => {
    if (visibleSelectedNodeId !== selectedNodeId) {
      setSelectedNodeId(visibleSelectedNodeId);
    }
  }, [selectedNodeId, visibleSelectedNodeId]);

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
        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Online nodes</p>
              <p className="mt-2 text-3xl font-semibold">
                {status?.onlineNodes ?? 0}/{status?.nodeCount ?? 0}
              </p>
            </div>
            <CheckCircle2 className="size-7 text-emerald-600" />
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Active recordings</p>
              <p className="mt-2 text-3xl font-semibold">{status?.activeRecordings ?? 0}</p>
            </div>
            <Radio className="size-7 text-teal-600" />
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Cached recordings</p>
              <p className="mt-2 text-3xl font-semibold">{status?.cachedRecordings ?? 0}</p>
            </div>
            <HardDrive className="size-7 text-zinc-700" />
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Critical alerts</p>
              <p className="mt-2 text-3xl font-semibold">{status?.criticalAlerts ?? 0}</p>
            </div>
            <AlertTriangle className="size-7 text-amber-600" />
          </div>
        </Card>
      </div>

      {pagePermissions.canCreateRecordings ? (
        <RecordingStartPanel
          canReadNodes={pagePermissions.canRead}
          canReadSettings={pagePermissions.canReadSettings}
          fixedNodeId={visibleSelectedNodeId}
          onNotice={setNotice}
        />
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <section className="grid gap-3">
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3 shadow-sm md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold">Meter Source</h2>
              <p className="text-xs text-muted-foreground">
                {nodes.length} visible recorder {nodes.length === 1 ? "node" : "nodes"}
              </p>
            </div>
            <Select
              disabled={nodes.length === 0}
              onValueChange={(value) => setSelectedNodeId(value === "__all__" ? "" : value)}
              value={visibleSelectedNodeId || "__all__"}
            >
              <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm md:min-w-64">
                <SelectValue placeholder="No visible nodes" />
              </SelectTrigger>
              <SelectContent>
                {nodes.length === 0 ? (
                  <SelectItem value="__all__">No visible nodes</SelectItem>
                ) : null}
                {nodes.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.alias} / {candidate.location.room || candidate.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <MeterBank levels={levels} title={node ? `${node.alias} Meters` : "Meters"} />
        </section>

        <div className="grid gap-5">
          <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Node</h2>
                <p className="text-xs text-muted-foreground">{node?.location.room ?? "No node"}</p>
              </div>
              <Badge className={nodeStatusBadgeClass(node?.status)} variant="outline">
                {node?.status ?? "offline"}
              </Badge>
            </div>

            <dl className="grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Alias</dt>
                <dd className="font-medium">{node?.alias ?? "Unknown"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Address</dt>
                <dd className="font-mono text-xs">{node?.ipAddresses.join(", ") ?? "n/a"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>{node ? formatDateTime(node.lastSeenAt) : "n/a"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Profile</dt>
                <dd>{status?.recordingProfile?.name ?? "n/a"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Watchdog</dt>
                <dd>{status?.watchdogPolicy?.name ?? "n/a"}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Active Recording Jobs</h2>
                <p className="text-xs text-muted-foreground">
                  {pagePermissions.canReadRecordings
                    ? `${activeRecordingJobs.length} on selected node`
                    : "Recording jobs unavailable"}
                </p>
              </div>
              <Radio className="size-5 text-teal-700" />
            </div>

            {!pagePermissions.canReadRecordings ? (
              <p className="text-sm text-muted-foreground">Requires recording read permission.</p>
            ) : activeRecordingJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active jobs for this node.</p>
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
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {job.recordingId}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Created {formatDateTime(job.createdAt)}
                      </div>
                      {job.startedAt ? (
                        <div className="text-xs text-muted-foreground">
                          Started {formatDateTime(job.startedAt)}
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge className="bg-background" variant="outline">
                          {job.command.captureBackend ?? "alsa"}
                        </Badge>
                        {job.command.captureInterfaceId ? (
                          <Badge className="max-w-full bg-background" variant="outline">
                            <span className="truncate">{job.command.captureInterfaceId}</span>
                          </Badge>
                        ) : null}
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
              <AlertTriangle className="size-5 text-amber-600" />
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

function healthSeverityClass(severity: "critical" | "info" | "warning") {
  return toneBadgeClass(severity);
}

function incidentActionLabel(action: DashboardIncidentAction) {
  return action === "acknowledge" ? "Acknowledge" : "Resolve";
}
