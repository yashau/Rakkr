import { useQuery } from "@tanstack/react-query";
import type { RecordingChunk, RecordingChunkStatus, UploadQueueStatus } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/dates";
import { toneBadgeClass, type StatusTone } from "@/lib/status-colors";

// Per-chunk view for a chunked recording job: each chunk is captured, cached on
// the controller, and uploaded to its destinations as its own object. The list
// live-refreshes so operators can watch parts land while a recording is running.
export function RecordingJobChunks({ enabled, jobId }: { enabled: boolean; jobId: string }) {
  const chunksQuery = useQuery({
    enabled,
    queryFn: () => api.recordingJobChunks(jobId),
    queryKey: ["recording-job-chunks", jobId],
    refetchInterval: 5000,
  });
  const chunks = chunksQuery.data?.data ?? [];

  if (chunks.length === 0) {
    return null;
  }

  const total = chunks.find((chunk) => chunk.total)?.total ?? chunks.length;

  return (
    <div className="mt-3 grid gap-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>Chunks</span>
        <Badge variant="secondary">
          {chunks.length}/{total}
        </Badge>
      </div>
      {chunks.map((chunk) => (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs"
          key={chunk.id}
        >
          <Badge variant="outline">#{chunk.index}</Badge>
          <Badge
            className={toneBadgeClass(recordingChunkStatusTone(chunk.status))}
            variant="outline"
          >
            {chunk.status}
          </Badge>
          <span className="text-muted-foreground">{chunkTimeRange(chunk)}</span>
          <span className="text-muted-foreground">{formatDuration(chunk.durationSeconds)}</span>
          {typeof chunk.sizeBytes === "number" ? (
            <span className="text-muted-foreground">{formatBytes(chunk.sizeBytes)}</span>
          ) : null}
          {(chunk.uploads ?? []).map((upload, index) => (
            <Badge
              className={`gap-1 ${toneBadgeClass(uploadStatusTone(upload.status))}`}
              key={`${chunk.id}-${upload.destinationId ?? upload.provider}-${index}`}
              variant="outline"
            >
              <span className="text-muted-foreground">{upload.provider}</span>
              <span>{upload.status}</span>
            </Badge>
          ))}
        </div>
      ))}
    </div>
  );
}

export function recordingChunkStatusTone(status: RecordingChunkStatus): StatusTone {
  if (status === "uploaded") {
    return "healthy";
  }

  if (status === "failed") {
    return "critical";
  }

  if (status === "partial") {
    return "warning";
  }

  if (status === "uploading") {
    return "info";
  }

  return "neutral";
}

function uploadStatusTone(status: UploadQueueStatus): StatusTone {
  if (status === "succeeded") {
    return "healthy";
  }

  if (status === "failed") {
    return "critical";
  }

  if (status === "retrying") {
    return "warning";
  }

  return "neutral";
}

function chunkTimeRange(chunk: RecordingChunk) {
  return `${formatDuration(chunk.offsetSeconds)}–${formatDuration(chunk.offsetSeconds + chunk.durationSeconds)}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
