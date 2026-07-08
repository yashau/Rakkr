import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
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

import { FilterField, FilterToolbar } from "@/components/filter-toolbar";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DatePicker } from "@/components/ui/date-picker";
import { TruncateCell } from "@/components/ui/truncate-cell";
import { Input } from "@/components/ui/input";
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
import { useDocumentTitle } from "@/lib/document-title";
import {
  emptyJobsPageFilters,
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
import { nodePickerFilters } from "@/lib/node-page-helpers";
import { downloadBlob } from "@/lib/recording-page-helpers";
import { defaultPageSize } from "@/lib/server-pagination";
import { useServerPagination } from "@/lib/use-server-pagination";
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
const selectClassName = "w-full";
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
  useDocumentTitle("Jobs");

  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<JobsPageFilters>(emptyJobsPageFilters);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const permissions = jobsPagePermissions(currentUserQuery.data?.data);
  const apiFilters = useMemo(() => recordingJobApiFilters(filters), [filters]);
  const pagination = useServerPagination(apiFilters, { defaultPageSize });
  const jobsQuery = useQuery({
    enabled: permissions.canReadJobs,
    placeholderData: keepPreviousData,
    queryFn: () => api.recordingJobs(pagination.query),
    queryKey: ["recording-jobs", "workbench", pagination.query],
    refetchInterval: 5000,
  });
  pagination.clampToTotal(jobsQuery.data?.meta?.total);
  const nodesQuery = useQuery({
    enabled: permissions.canReadNodes,
    queryFn: () => api.nodes(nodePickerFilters()),
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

  // Filtering + pagination are server-side now; the page renders exactly the
  // returned page of jobs.
  const visibleJobs = jobsQuery.data?.data ?? [];
  const meta = jobsQuery.data?.meta;
  // Free-text search is inline in the toolbar; the slide-out chips/count cover
  // the remaining filters.
  const advancedFilterChips = recordingJobFilterChips(apiFilters).filter(
    (chip) => chip.key !== "search",
  );
  // Prefer the server's summary over the full filtered set; fall back to the
  // page-derived count only before the first response arrives (G74).
  const summary = jobsQuery.data?.summary ?? recordingJobSummary(visibleJobs);
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
  const columns = recordingJobColumns({
    canControl: permissions.canControlJobs,
    lookups: {
      nodes: nodesQuery.data?.data,
      recordings: recordingsQuery.data?.data,
    },
    onRetry: (jobId) => retryJobMutation.mutate(jobId),
    onStop: (recordingId) => stopJobMutation.mutate(recordingId),
    onToggleSelected: (jobId, selected) => setJobSelected(setSelectedJobIds, jobId, selected),
    retryPending: retryJobMutation.isPending,
    selectedJobIds: selectedVisibleJobIds,
    stopPending: stopJobMutation.isPending,
  });

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ListChecks className="size-5 text-primary" />
              <h2 className="text-lg font-semibold">Recording Jobs</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {meta?.total ?? visibleJobs.length} matching jobs
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
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

        <div className="mt-4">
          <FilterToolbar
            actions={
              <>
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
              </>
            }
            chips={advancedFilterChips}
            onClearAll={() => setFilters(emptyJobsPageFilters)}
            onClearChip={(key) => clearRecordingJobFilter(key as RecordingJobFilterKey)}
            onSearchChange={(value) => setFilters((current) => ({ ...current, search: value }))}
            search={filters.search}
            searchPlaceholder="job, node, recording, device, output, failure"
            sheetDescription="Filter by status, backend, capture interface, node, and created window."
            sheetTitle="Filter recording jobs"
          >
            <FilterField label="Status">
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
            </FilterField>
            <FilterField label="Backend">
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
            </FilterField>
            <FilterField label="Node">
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
            </FilterField>
            <FilterField label="Interface">
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
            </FilterField>
            <FilterField label="Created From">
              <DatePicker
                aria-label="Created from"
                onChange={(value) => setFilters((current) => ({ ...current, createdFrom: value }))}
                value={filters.createdFrom}
              />
            </FilterField>
            <FilterField label="Created To">
              <DatePicker
                aria-label="Created to"
                onChange={(value) => setFilters((current) => ({ ...current, createdTo: value }))}
                value={filters.createdTo}
              />
            </FilterField>
          </FilterToolbar>
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-transparent p-3 md:flex-row md:items-center md:justify-between">
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
              <TooltipTrigger
                render={
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
                }
              />
              <TooltipContent>
                {selectedVisibleJobIds.length > 0
                  ? "Export selected visible jobs"
                  : "Select visible jobs to export"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
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
                }
              />
              <TooltipContent>
                {bulkRetryTargets.length > 0
                  ? "Retry selected failed or cancelled jobs"
                  : "Select failed or cancelled jobs without active retries"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
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
                }
              />
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

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={visibleJobs}
          emptyMessage="No recording jobs match the current filters."
          getRowId={(job) => job.id}
          isLoading={jobsQuery.isPending}
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

  function clearRecordingJobFilter(key: RecordingJobFilterKey) {
    setFilters((current) => ({ ...current, [recordingJobFilterDraftKeys[key]]: "" }));
  }
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

interface RecordingJobColumnOptions {
  canControl: boolean;
  lookups: Parameters<typeof recordingJobRelationshipLabel>[1];
  onRetry: (jobId: string) => void;
  onStop: (recordingId: string) => void;
  onToggleSelected: (jobId: string, selected: boolean) => void;
  retryPending: boolean;
  selectedJobIds: string[];
  stopPending: boolean;
}

function recordingJobColumns({
  canControl,
  lookups,
  onRetry,
  onStop,
  onToggleSelected,
  retryPending,
  selectedJobIds,
  stopPending,
}: RecordingJobColumnOptions): ColumnDef<RecordingJob>[] {
  const columns: ColumnDef<RecordingJob>[] = [
    {
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select job"
          checked={selectedJobIds.includes(row.original.id)}
          onCheckedChange={(value) => onToggleSelected(row.original.id, value === true)}
        />
      ),
      header: () => <span className="sr-only">Select</span>,
      id: "select",
      meta: { cellClassName: "w-8", headClassName: "w-8" },
    },
    {
      cell: ({ row }) => (
        <Badge className={recordingJobStatusClass(row.original.status)} variant="outline">
          {row.original.status}
        </Badge>
      ),
      header: "Status",
      id: "status",
    },
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <TruncateCell className="max-w-72 font-medium">
            {recordingJobRelationshipLabel(row.original, lookups)}
          </TruncateCell>
          <TruncateCell className="max-w-72 font-mono text-xs text-muted-foreground">
            {row.original.id}
          </TruncateCell>
          {row.original.failureReason ? (
            <TruncateCell className="mt-1 max-w-72 text-sm text-destructive">
              {row.original.failureReason}
            </TruncateCell>
          ) : null}
        </div>
      ),
      header: "Job",
      id: "job",
    },
    {
      cell: ({ row }) => (
        <div className="text-xs whitespace-nowrap text-muted-foreground">
          <div>Created {formatDateTime(row.original.createdAt)}</div>
          {row.original.startedAt ? (
            <div>Started {formatDateTime(row.original.startedAt)}</div>
          ) : null}
          {row.original.completedAt ? (
            <div>Completed {formatDateTime(row.original.completedAt)}</div>
          ) : null}
        </div>
      ),
      header: "Timeline",
      id: "timeline",
    },
    {
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.claimedBy ? (
            <Badge className="gap-1" variant="outline">
              <span className="text-muted-foreground">claimed</span>
              <span className="truncate font-mono">{row.original.claimedBy}</span>
            </Badge>
          ) : null}
          {recordingJobCaptureDetails(row.original).map((item) => (
            <Badge className="gap-1" key={`${row.original.id}-${item.label}`} variant="outline">
              <span className="text-muted-foreground">{item.label}</span>
              <span className="truncate font-mono">{item.value}</span>
            </Badge>
          ))}
        </div>
      ),
      header: "Capture",
      id: "capture",
    },
  ];

  if (canControl) {
    columns.push({
      cell: ({ row }) => {
        const retryAction = recordingJobRetryActionState(row.original, canControl);
        const stopAction = recordingJobStopActionState(row.original, canControl);

        return (
          <div className="flex justify-end gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      disabled={!retryAction.canRetry || retryPending}
                      onClick={() => onRetry(row.original.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <RotateCcw className="size-4" />
                      Retry
                    </Button>
                  </span>
                }
              />
              <TooltipContent>{retryAction.title}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      disabled={!stopAction.canStop || stopPending}
                      onClick={() => onStop(row.original.recordingId)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Square className="size-4" />
                      Stop
                    </Button>
                  </span>
                }
              />
              <TooltipContent>{stopAction.title}</TooltipContent>
            </Tooltip>
          </div>
        );
      },
      header: "Actions",
      id: "actions",
      meta: { cellClassName: "text-right", headClassName: "text-right" },
    });
  }

  return columns;
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
