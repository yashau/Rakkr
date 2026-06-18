import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, UploadCloud } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

export function UploadRunnerPanel() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryFn: api.uploadRunner,
    queryKey: ["upload-runner"],
    refetchInterval: 5_000,
  });
  const runMutation = useMutation({
    mutationFn: api.runUploadRunner,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["upload-runner"] });
      void queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
    },
  });
  const status = statusQuery.data?.data;
  const summary = status?.lastSummary;

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <UploadCloud className="size-4" />
            <h3 className="text-base font-semibold">Upload Runner</h3>
            <Badge
              className={runnerStatusClass(status?.started, status?.running)}
              variant="outline"
            >
              {status?.running ? "running" : status?.started ? "started" : "stopped"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Batch {status?.batchSize ?? "-"} / every {status?.intervalSeconds ?? "-"}s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
            variant="outline"
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Button disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
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

      {runMutation.isError ? (
        <p className="mt-3 text-sm text-destructive">Runner request failed.</p>
      ) : null}
    </Card>
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

function runnerStatusClass(started: boolean | undefined, running: boolean | undefined) {
  if (running) {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  return started
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-slate-200 bg-slate-50 text-slate-700";
}
