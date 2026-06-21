import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UploadProvider, UploadQueueItem, UploadQueueStatus } from "@rakkr/shared";
import { Play, RefreshCw, RotateCcw, UploadCloud, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  emptyUploadQueueFilterDraft,
  uploadQueueFilterChips,
  uploadQueueFiltersFromDraft,
  uploadRunnerPanelPermissions,
  type UploadQueueFilterDraft,
  type UploadQueueFilterKey,
} from "@/lib/upload-runner-panel-helpers";

const uploadQueueStatuses: UploadQueueStatus[] = [
  "queued",
  "retrying",
  "failed",
  "succeeded",
  "cancelled",
];
const uploadProviders: UploadProvider[] = ["stub", "smb", "s3"];

export function UploadRunnerPanel() {
  const queryClient = useQueryClient();
  const [queueFilterDraft, setQueueFilterDraft] = useState(emptyUploadQueueFilterDraft);
  const queueFilters = uploadQueueFiltersFromDraft(queueFilterDraft);
  const queueFilterChips = uploadQueueFilterChips(queueFilters);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const permissions = uploadRunnerPanelPermissions(currentUserQuery.data?.data);
  const statusQuery = useQuery({
    enabled: permissions.canRead,
    queryFn: api.uploadRunner,
    queryKey: ["upload-runner"],
    refetchInterval: 5_000,
  });
  const queueQuery = useQuery({
    enabled: permissions.canRead,
    queryFn: () => api.uploadQueue(queueFilters),
    queryKey: ["upload-queue", queueFilters],
    refetchInterval: 10_000,
  });
  const runMutation = useMutation({
    mutationFn: api.runUploadRunner,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["upload-runner"] });
      void queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
    },
  });
  const retryMutation = useMutation({
    mutationFn: api.retryUploadQueueItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["upload-runner"] });
    },
  });
  const status = statusQuery.data?.data;
  const summary = status?.lastSummary;
  const queueItems = queueQuery.data?.data ?? [];
  const statusLabel = !permissions.canRead
    ? "unavailable"
    : status?.running
      ? "running"
      : status?.started
        ? "started"
        : "stopped";

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <UploadCloud className="size-4" />
            <h3 className="text-base font-semibold">Upload Runner</h3>
            <Badge
              className={runnerStatusClass(status?.started, status?.running, permissions.canRead)}
              variant="outline"
            >
              {statusLabel}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {permissions.canRead
              ? `Batch ${status?.batchSize ?? "-"} / every ${status?.intervalSeconds ?? "-"}s`
              : "Runner status unavailable."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={!permissions.canRead || statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
            variant="outline"
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Button
            disabled={runMutation.isPending || !permissions.canRun}
            onClick={() => runMutation.mutate()}
            title={permissions.canRun ? "Run upload queue now" : "Requires recording control"}
          >
            <Play className="size-4" />
            Run now
          </Button>
        </div>
      </div>

      <div className="grid gap-3 text-sm md:grid-cols-5">
        <Metric
          label="Last run"
          value={status?.lastRunAt ? formatDateTime(status.lastRunAt) : "-"}
        />
        <Metric label="Attempted" value={summary?.attempted ?? 0} />
        <Metric label="Succeeded" value={summary?.succeeded ?? 0} />
        <Metric label="Deferred" value={summary?.deferred ?? 0} />
        <Metric label="Failed" value={summary?.failed ?? 0} />
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h4 className="text-sm font-semibold">Upload Queue</h4>
            <p className="text-xs text-muted-foreground">
              {permissions.canRead ? `${queueItems.length} visible items` : "Queue unavailable."}
            </p>
          </div>
          <Button
            disabled={!permissions.canRead || queueQuery.isFetching}
            onClick={() => void queueQuery.refetch()}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-4" />
            Refresh Queue
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-[160px_160px_1fr]">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!permissions.canRead}
            onChange={(event) =>
              setQueueFilterDraft((current) => ({
                ...current,
                status: event.target.value as UploadQueueFilterDraft["status"],
              }))
            }
            value={queueFilterDraft.status}
          >
            <option value="">All statuses</option>
            {uploadQueueStatuses.map((queueStatus) => (
              <option key={queueStatus} value={queueStatus}>
                {queueStatus}
              </option>
            ))}
          </select>
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!permissions.canRead}
            onChange={(event) =>
              setQueueFilterDraft((current) => ({
                ...current,
                provider: event.target.value as UploadQueueFilterDraft["provider"],
              }))
            }
            value={queueFilterDraft.provider}
          >
            <option value="">All providers</option>
            {uploadProviders.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
          <Input
            disabled={!permissions.canRead}
            onChange={(event) =>
              setQueueFilterDraft((current) => ({
                ...current,
                recordingId: event.target.value,
              }))
            }
            placeholder="Recording ID"
            value={queueFilterDraft.recordingId}
          />
        </div>

        {queueFilterChips.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {queueFilterChips.map((chip) => (
              <Button
                className="h-8 gap-1 rounded-full px-3 text-xs"
                key={chip.key}
                onClick={() => setQueueFilterDraft(removeQueueFilter(queueFilterDraft, chip.key))}
                type="button"
                variant="outline"
              >
                {chip.label}: {chip.value}
                <X className="size-3" />
              </Button>
            ))}
            <Button
              className="h-8 rounded-full px-3 text-xs"
              onClick={() => setQueueFilterDraft(emptyUploadQueueFilterDraft)}
              type="button"
              variant="ghost"
            >
              Clear
            </Button>
          </div>
        ) : null}

        <div className="mt-3 grid gap-2">
          {queueQuery.isPending && permissions.canRead ? (
            <p className="text-sm text-muted-foreground">Loading upload queue.</p>
          ) : null}
          {!queueQuery.isPending && permissions.canRead && queueItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No upload queue items match.</p>
          ) : null}
          {queueItems.slice(0, 8).map((item) => (
            <UploadQueueRow
              canRetry={permissions.canRun}
              isRetrying={retryMutation.isPending}
              item={item}
              key={item.id}
              onRetry={(itemId) => retryMutation.mutate(itemId)}
            />
          ))}
          {queueItems.length > 8 ? (
            <p className="text-xs text-muted-foreground">
              Showing 8 of {queueItems.length} matching items.
            </p>
          ) : null}
        </div>
      </div>

      {runMutation.isError ? (
        <p className="mt-3 text-sm text-destructive">Runner request failed.</p>
      ) : null}
      {queueQuery.isError || retryMutation.isError ? (
        <p className="mt-3 text-sm text-destructive">Upload queue request failed.</p>
      ) : null}
      {currentUserQuery.isPending ? (
        <p className="mt-3 text-sm text-muted-foreground">Checking runner permissions.</p>
      ) : null}
    </Card>
  );
}

function UploadQueueRow({
  canRetry,
  isRetrying,
  item,
  onRetry,
}: {
  canRetry: boolean;
  isRetrying: boolean;
  item: UploadQueueItem;
  onRetry: (itemId: string) => void;
}) {
  const retryable = item.status === "failed" || item.status === "cancelled";

  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm md:grid-cols-[1fr_120px_120px_150px_auto] md:items-center">
      <div className="min-w-0">
        <div className="truncate font-medium">{item.fileName ?? item.recordingId}</div>
        <div className="truncate text-xs text-muted-foreground">{item.recordingId}</div>
        {item.lastError ? (
          <div className="truncate text-xs text-muted-foreground">{item.lastError}</div>
        ) : null}
      </div>
      <Badge className={uploadQueueStatusClass(item.status)} variant="outline">
        {item.status}
      </Badge>
      <div className="text-xs text-muted-foreground">{item.provider}</div>
      <div className="text-xs text-muted-foreground">Next {formatDateTime(item.nextAttemptAt)}</div>
      <Button
        disabled={!retryable || !canRetry || isRetrying}
        onClick={() => onRetry(item.id)}
        size="sm"
        title={canRetry ? "Retry upload queue item" : "Requires recording control"}
        type="button"
        variant="outline"
      >
        <RotateCcw className="size-4" />
        Retry
      </Button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  );
}

function removeQueueFilter(draft: UploadQueueFilterDraft, key: UploadQueueFilterKey) {
  return {
    ...draft,
    [key]: "",
  };
}

function uploadQueueStatusClass(status: UploadQueueStatus) {
  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (status === "retrying") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (status === "queued") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function runnerStatusClass(
  started: boolean | undefined,
  running: boolean | undefined,
  canRead: boolean,
) {
  if (!canRead) {
    return "border-slate-200 bg-slate-50 text-slate-700";
  }

  if (running) {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  return started
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-slate-200 bg-slate-50 text-slate-700";
}
