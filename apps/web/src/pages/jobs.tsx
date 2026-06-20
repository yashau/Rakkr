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
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  emptyJobsPageFilters,
  filterRecordingJobs,
  jobsPagePermissions,
  recordingJobBulkRetryTargets,
  recordingJobBulkStopTargets,
  recordingJobCaptureDetails,
  recordingJobRelationshipLabel,
  recordingJobRetryActionState,
  recordingJobStopActionState,
  recordingJobStatusClass,
  recordingJobSummary,
  type JobsPageFilters,
} from "@/lib/jobs-page-helpers";
import { downloadBlob } from "@/lib/recording-page-helpers";

const statuses: Array<"" | RecordingJob["status"]> = [
  "",
  "queued",
  "running",
  "stop_requested",
  "completed",
  "failed",
  "cancelled",
];
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

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
    queryFn: api.recordingJobs,
    queryKey: ["recording-jobs", "workbench"],
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const retryJobMutation = useMutation({
    mutationFn: api.retryRecordingJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const bulkStopJobMutation = useMutation({
    mutationFn: api.stopRecordingJobs,
    onSuccess: () => {
      setSelectedJobIds([]);
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const bulkRetryJobMutation = useMutation({
    mutationFn: api.retryRecordingJobs,
    onSuccess: () => {
      setSelectedJobIds([]);
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const exportMutation = useMutation({
    mutationFn: () =>
      api.recordingJobsExport({
        search: filters.search.trim() || undefined,
        status: filters.status || undefined,
      }),
    onSuccess: downloadBlob,
  });

  if (currentUserQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading recording jobs.</p>;
  }

  if (!permissions.canReadJobs) {
    return (
      <Card className="rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <ListChecks className="size-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Recording Jobs</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Recording jobs are unavailable.</p>
      </Card>
    );
  }

  const jobs = jobsQuery.data?.data ?? [];
  const visibleJobs = filterRecordingJobs(jobs, filters);
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

        <div className="mt-4 grid gap-3 md:grid-cols-[220px_1fr]">
          <Field label="Status">
            <select
              className={selectClassName}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value as JobsPageFilters["status"],
                }))
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

        <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={allVisibleSelected}
              className="size-4"
              onChange={(event) => setSelectedJobIds(event.target.checked ? visibleJobIds : [])}
              type="checkbox"
            />
            <span>{selectedVisibleJobIds.length} selected</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={bulkRetryTargets.length === 0 || bulkRetryJobMutation.isPending}
              onClick={() => bulkRetryJobMutation.mutate({ jobIds: bulkRetryTargets })}
              title={
                bulkRetryTargets.length > 0
                  ? "Retry selected failed or cancelled jobs"
                  : "Select failed or cancelled jobs without active retries"
              }
              type="button"
              variant="outline"
            >
              <RotateCcw className="size-4" />
              Retry selected
            </Button>
            <Button
              disabled={bulkStopTargets.length === 0 || bulkStopJobMutation.isPending}
              onClick={() => bulkStopJobMutation.mutate({ jobIds: bulkStopTargets })}
              title={
                bulkStopTargets.length > 0
                  ? "Request stop for selected active jobs"
                  : "Select queued or running jobs"
              }
              type="button"
              variant="outline"
            >
              <Square className="size-4" />
              Stop selected
            </Button>
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
          <Card className="rounded-lg p-4 text-sm text-muted-foreground shadow-sm">
            No recording jobs match the current filters.
          </Card>
        ) : null}
      </section>
    </div>
  );
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
            <input
              checked={selected}
              className="size-4"
              onChange={(event) => onSelectedChange(event.target.checked)}
              title="Select job"
              type="checkbox"
            />
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
              <Button
                disabled={!retryAction.canRetry || retryPending}
                onClick={() => onRetry(job.id)}
                title={retryAction.title}
                type="button"
                variant="outline"
              >
                <RotateCcw className="size-4" />
                Retry
              </Button>
              <Button
                disabled={!stopAction.canStop || stopPending}
                onClick={() => onStop(job.recordingId)}
                title={stopAction.title}
                type="button"
                variant="outline"
              >
                <Square className="size-4" />
                Stop
              </Button>
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

function summaryToneClass(tone: "active" | "critical" | "healthy" | "neutral") {
  if (tone === "active") {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }

  if (tone === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }

  if (tone === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }

  return "border-border bg-background text-foreground";
}
