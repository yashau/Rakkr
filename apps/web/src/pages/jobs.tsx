import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecordingJob } from "@rakkr/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from "lucide-react";

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDateTime, localDateBoundaryIso } from "@/lib/dates";
import {
  emptyJobsPageFilters,
  filterRecordingJobs,
  jobsPagePermissions,
  recordingJobBulkRetryTargets,
  recordingJobBulkStopTargets,
  recordingJobCaptureDetails,
  recordingJobFilterChips,
  recordingJobRelationshipLabel,
  recordingJobRetryActionState,
  recordingJobStopActionState,
  recordingJobStatusClass,
  recordingJobSummary,
  type JobsPageFilters,
  type RecordingJobFilterKey,
} from "@/lib/jobs-page-helpers";
import { downloadBlob } from "@/lib/recording-page-helpers";
import { toneTileClass } from "@/lib/status-colors";

const statuses: Array<"" | RecordingJob["status"]> = [
  "",
  "queued",
  "running",
  "stop_requested",
  "completed",
  "failed",
  "cancelled",
];
const captureBackends: JobsPageFilters["captureBackend"][] = ["", "alsa", "jack", "pipewire"];
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const recordingJobFilterDraftKeys: Record<RecordingJobFilterKey, keyof JobsPageFilters> = {
  captureBackend: "captureBackend",
  captureInterfaceId: "captureInterfaceId",
  createdFrom: "createdFrom",
  createdTo: "createdTo",
  nodeId: "nodeId",
  search: "search",
  status: "status",
};

export function JobsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<JobsPageFilters>(emptyJobsPageFilters);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const permissions = jobsPagePermissions(currentUserQuery.data?.data);
  const jobsQuery = useQuery({
    enabled: permissions.canReadJobs,
    queryFn: () => api.recordingJobs(recordingJobApiFilters(filters)),
    queryKey: ["recording-jobs", "workbench", filters],
    refetchInterval: 5000,
  });
  const nodesQuery = useQuery({
    enabled: permissions.canReadNodes,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const recordingsQuery = useQuery({
    enabled: permissions.canReadRecordings,
    queryFn: () => api.recordings({ limit: 500 }),
    queryKey: ["recordings", "jobs-workbench"],
  });
  const stopJobMutation = useMutation({
    mutationFn: api.stopRecording,
    onError: () =>
      toast.error("Stop failed", {
        description: "The recording job could not be stopped.",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const retryJobMutation = useMutation({
    mutationFn: api.retryRecordingJob,
    onError: () =>
      toast.error("Retry failed", {
        description: "The recording job could not be retried.",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const bulkStopJobMutation = useMutation({
    mutationFn: api.stopRecordingJobs,
    onError: () =>
      toast.error("Stop failed", {
        description: "The selected recording jobs could not be stopped.",
      }),
    onSuccess: () => {
      setSelectedJobIds([]);
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const bulkRetryJobMutation = useMutation({
    mutationFn: api.retryRecordingJobs,
    onError: () =>
      toast.error("Retry failed", {
        description: "The selected recording jobs could not be retried.",
      }),
    onSuccess: () => {
      setSelectedJobIds([]);
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const exportMutation = useMutation({
    mutationFn: () => api.recordingJobsExport(recordingJobApiFilters(filters)),
    onError: () =>
      toast.error("Export failed", {
        description: "The recording job CSV export could not be generated.",
      }),
    onSuccess: downloadBlob,
  });
  const selectedExportMutation = useMutation({
    mutationFn: (jobIds: string[]) => api.recordingJobsExportSelected({ jobIds }),
    onError: () =>
      toast.error("Export failed", {
        description: "The selected recording job CSV export could not be generated.",
      }),
    onSuccess: downloadBlob,
  });

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading recording jobs" />;
  }

  if (!permissions.canReadJobs) {
    return (
      <Alert>
        <ListChecks className="size-4" />
        <AlertTitle>Recording Jobs</AlertTitle>
        <AlertDescription>Recording jobs are unavailable.</AlertDescription>
      </Alert>
    );
  }

  const jobs = jobsQuery.data?.data ?? [];
  const visibleJobs = filterRecordingJobs(jobs, filters);
  const activeFilterChips = recordingJobFilterChips(recordingJobApiFilters(filters));
  const summary = recordingJobSummary(visibleJobs);
  const visibleJobIds = visibleJobs.map((job) => job.id);
  const selectedVisibleJobIds = selectedJobIds.filter((jobId) => visibleJobIds.includes(jobId));
  const allVisibleSelected =
    visibleJobIds.length > 0 && visibleJobIds.every((jobId) => selectedJobIds.includes(jobId));
  const bulkRetryTargets = recordingJobBulkRetryTargets(
    visibleJobs,
    selectedVisibleJobIds,
    permissions.canControlJobs,
  );
  const bulkStopTargets = recordingJobBulkStopTargets(
    visibleJobs,
    selectedVisibleJobIds,
    permissions.canControlJobs,
  );

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ListChecks className="size-5 text-teal-700" />
              <h2 className="text-lg font-semibold">Recording Jobs</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{visibleJobs.length} visible jobs</p>
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
              disabled={jobsQuery.isFetching}
              onClick={() => void jobsQuery.refetch()}
              type="button"
              variant="outline"
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Button
              onClick={() => setFilters(emptyJobsPageFilters)}
              type="button"
              variant="outline"
            >
              Reset
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <SummaryTile icon={Clock3} label="Active" tone="active" value={summary.active} />
          <SummaryTile icon={ListChecks} label="Queued" tone="neutral" value={summary.queued} />
          <SummaryTile
            icon={CheckCircle2}
            label="Completed"
            tone="healthy"
            value={summary.completed}
          />
          <SummaryTile icon={AlertTriangle} label="Failed" tone="critical" value={summary.failed} />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[160px_160px_180px_180px_220px_220px_1fr]">
          <Field label="Status">
            <Select
              onValueChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  status: (value === "__all__" ? "" : value) as JobsPageFilters["status"],
                }))
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
          </Field>
          <Field label="Backend">
            <Select
              onValueChange={(value) =>
                setFilters((current) => ({
                  ...current,
                  captureBackend: (value === "__all__"
                    ? ""
                    : value) as JobsPageFilters["captureBackend"],
                }))
              }
              value={filters.captureBackend || "__all__"}
            >
              <SelectTrigger className={selectClassName}>
                <SelectValue placeholder="all backends" />
              </SelectTrigger>
              <SelectContent>
                {captureBackends.map((backend) => (
                  <SelectItem key={backend || "all"} value={backend || "__all__"}>
                    {backend || "all backends"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Created From">
            <Input
              onChange={(event) =>
                setFilters((current) => ({ ...current, createdFrom: event.target.value }))
              }
              type="date"
              value={filters.createdFrom}
            />
          </Field>
          <Field label="Created To">
            <Input
              onChange={(event) =>
                setFilters((current) => ({ ...current, createdTo: event.target.value }))
              }
              type="date"
              value={filters.createdTo}
            />
          </Field>
          <Field label="Node">
            {permissions.canReadNodes && (nodesQuery.data?.data.length ?? 0) > 0 ? (
              <Select
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    nodeId: value === "__all__" ? "" : value,
                  }))
                }
                value={filters.nodeId || "__all__"}
              >
                <SelectTrigger className={selectClassName}>
                  <SelectValue placeholder="all nodes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">all nodes</SelectItem>
                  {nodesQuery.data?.data.map((recorderNode) => (
                    <SelectItem key={recorderNode.id} value={recorderNode.id}>
                      {recorderNode.alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                onChange={(event) =>
                  setFilters((current) => ({ ...current, nodeId: event.target.value }))
                }
                placeholder="node id"
                value={filters.nodeId}
              />
            )}
          </Field>
          <Field label="Interface">
            <Input
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  captureInterfaceId: event.target.value,
                }))
              }
              placeholder="interface id"
              value={filters.captureInterfaceId}
            />
          </Field>
          <Field label="Search">
            <Input
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
              placeholder="job, node, recording, device, output, failure"
              value={filters.search}
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
                  onClick={() => clearRecordingJobFilter(filter.key)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => setFilters(emptyJobsPageFilters)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear all
            </Button>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
          <label className="flex items-center gap-2 text-sm" htmlFor="jobs-bulk-select-all">
            <Checkbox
              checked={allVisibleSelected}
              id="jobs-bulk-select-all"
              onCheckedChange={(value) => setSelectedJobIds(value === true ? visibleJobIds : [])}
            />
            <span>{selectedVisibleJobIds.length} selected</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    disabled={
                      selectedVisibleJobIds.length === 0 || selectedExportMutation.isPending
                    }
                    onClick={() => selectedExportMutation.mutate(selectedVisibleJobIds)}
                    type="button"
                    variant="outline"
                  >
                    <Download className="size-4" />
                    Export selected
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {selectedVisibleJobIds.length > 0
                  ? "Export selected visible jobs"
                  : "Select visible jobs to export"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    disabled={bulkRetryTargets.length === 0 || bulkRetryJobMutation.isPending}
                    onClick={() => bulkRetryJobMutation.mutate({ jobIds: bulkRetryTargets })}
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw className="size-4" />
                    Retry selected
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {bulkRetryTargets.length > 0
                  ? "Retry selected failed or cancelled jobs"
                  : "Select failed or cancelled jobs without active retries"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    disabled={bulkStopTargets.length === 0 || bulkStopJobMutation.isPending}
                    onClick={() => bulkStopJobMutation.mutate({ jobIds: bulkStopTargets })}
                    type="button"
                    variant="outline"
                  >
                    <Square className="size-4" />
                    Stop selected
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {bulkStopTargets.length > 0
                  ? "Request stop for selected active jobs"
                  : "Select queued or running jobs"}
              </TooltipContent>
            </Tooltip>
            <Button
              disabled={selectedVisibleJobIds.length === 0}
              onClick={() => setSelectedJobIds([])}
              type="button"
              variant="outline"
            >
              Clear
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-3">
        {visibleJobs.map((job) => (
          <JobRow
            canControl={permissions.canControlJobs}
            job={job}
            key={job.id}
            lookups={{
              nodes: nodesQuery.data?.data,
              recordings: recordingsQuery.data?.data,
            }}
            onStop={(recordingId) => stopJobMutation.mutate(recordingId)}
            onRetry={(jobId) => retryJobMutation.mutate(jobId)}
            onSelectedChange={(selected) => setJobSelected(setSelectedJobIds, job.id, selected)}
            retryPending={retryJobMutation.isPending}
            selected={selectedVisibleJobIds.includes(job.id)}
            stopPending={stopJobMutation.isPending}
          />
        ))}
        {!jobsQuery.isPending && visibleJobs.length === 0 ? (
          <Alert>
            <AlertDescription>No recording jobs match the current filters.</AlertDescription>
          </Alert>
        ) : null}
      </section>
    </div>
  );

  function clearRecordingJobFilter(key: RecordingJobFilterKey) {
    setFilters((current) => ({ ...current, [recordingJobFilterDraftKeys[key]]: "" }));
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
  icon: typeof ListChecks;
  label: string;
  tone: "active" | "critical" | "healthy" | "neutral";
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

function JobRow({
  canControl,
  job,
  lookups,
  onStop,
  onRetry,
  onSelectedChange,
  retryPending,
  selected,
  stopPending,
}: {
  canControl: boolean;
  job: RecordingJob;
  lookups: Parameters<typeof recordingJobRelationshipLabel>[1];
  onStop: (recordingId: string) => void;
  onRetry: (jobId: string) => void;
  onSelectedChange: (selected: boolean) => void;
  retryPending: boolean;
  selected: boolean;
  stopPending: boolean;
}) {
  const details = recordingJobCaptureDetails(job);
  const retryAction = recordingJobRetryActionState(job, canControl);
  const stopAction = recordingJobStopActionState(job, canControl);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Checkbox
                  checked={selected}
                  onCheckedChange={(value) => onSelectedChange(value === true)}
                />
              </TooltipTrigger>
              <TooltipContent>Select job</TooltipContent>
            </Tooltip>
            <Badge className={recordingJobStatusClass(job.status)} variant="outline">
              {job.status}
            </Badge>
            <span className="font-medium">{recordingJobRelationshipLabel(job, lookups)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>Created {formatDateTime(job.createdAt)}</span>
            {job.startedAt ? <span>Started {formatDateTime(job.startedAt)}</span> : null}
            {job.lastHeartbeatAt ? (
              <span>Heartbeat {formatDateTime(job.lastHeartbeatAt)}</span>
            ) : null}
            {job.leaseExpiresAt ? <span>Lease {formatDateTime(job.leaseExpiresAt)}</span> : null}
            {job.stopRequestedAt ? <span>Stop {formatDateTime(job.stopRequestedAt)}</span> : null}
            {job.completedAt ? <span>Completed {formatDateTime(job.completedAt)}</span> : null}
          </div>
          <div className="mt-2 font-mono text-xs wrap-break-word text-muted-foreground">
            {job.id}
          </div>
          {job.failureReason ? (
            <p className="mt-2 text-sm text-destructive">{job.failureReason}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 lg:max-w-xl lg:justify-end">
          {canControl ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      disabled={!retryAction.canRetry || retryPending}
                      onClick={() => onRetry(job.id)}
                      type="button"
                      variant="outline"
                    >
                      <RotateCcw className="size-4" />
                      Retry
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{retryAction.title}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      disabled={!stopAction.canStop || stopPending}
                      onClick={() => onStop(job.recordingId)}
                      type="button"
                      variant="outline"
                    >
                      <Square className="size-4" />
                      Stop
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{stopAction.title}</TooltipContent>
              </Tooltip>
            </>
          ) : null}
          {job.claimedBy ? (
            <Badge className="max-w-full gap-1 overflow-hidden bg-background" variant="outline">
              <span className="text-muted-foreground">claimed</span>
              <span className="truncate font-mono">{job.claimedBy}</span>
            </Badge>
          ) : null}
          {details.map((item) => (
            <Badge
              className="max-w-full gap-1 overflow-hidden bg-background"
              key={`${job.id}-${item.label}`}
              variant="outline"
            >
              <span className="text-muted-foreground">{item.label}</span>
              <span className="truncate font-mono">{item.value}</span>
            </Badge>
          ))}
        </div>
      </div>
    </Card>
  );
}

function setJobSelected(
  setSelectedJobIds: (value: (current: string[]) => string[]) => void,
  jobId: string,
  selected: boolean,
) {
  setSelectedJobIds((current) =>
    selected
      ? current.includes(jobId)
        ? current
        : [...current, jobId]
      : current.filter((candidate) => candidate !== jobId),
  );
}

function recordingJobApiFilters(filters: JobsPageFilters) {
  return {
    captureBackend: filters.captureBackend || undefined,
    captureInterfaceId: filters.captureInterfaceId.trim() || undefined,
    createdFrom: localDateBoundaryIso(filters.createdFrom, "start"),
    createdTo: localDateBoundaryIso(filters.createdTo, "end"),
    nodeId: filters.nodeId.trim() || undefined,
    search: filters.search.trim() || undefined,
    status: filters.status || undefined,
  };
}

function summaryToneClass(tone: "active" | "critical" | "healthy" | "neutral") {
  return toneTileClass(tone === "active" ? "info" : tone);
}
