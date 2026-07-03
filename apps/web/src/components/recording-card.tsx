import {
  ChevronDown,
  ChevronRight,
  Download,
  Fingerprint,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash2,
  UploadCloud,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  HealthEvent,
  RecordingJob,
  RecordingSummary,
  UploadPolicy,
  UploadQueueItem,
} from "@rakkr/shared";

import { ConfirmButton } from "@/components/confirm-button";
import { QualityTimeline } from "@/components/quality-timeline";
import { RecordingJobChunks } from "@/components/recording-job-chunks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime, formatDuration } from "@/lib/dates";
import { toneBadgeClass } from "@/lib/status-colors";
import {
  isCachedRecording,
  isTerminalRecording,
  recordingRelationshipBadges,
  type RecordingRelationshipReferences,
  waveformBarHeightPercent,
  waveformPreviewSummary,
} from "@/lib/recording-page-helpers";

export function RecordingCard({
  canControl,
  canDelete,
  canDownload,
  canEdit,
  canPlayback,
  canReadHealth,
  deletePending,
  downloadPending,
  editPending,
  events,
  jobs,
  onDelete,
  onDownload,
  onEdit,
  onPlayback,
  onQueueUpload,
  onRetryUpload,
  onSelectedChange,
  onStop,
  playbackPending,
  recording,
  relationshipReferences,
  retryUploadPending,
  selected = false,
  stopPending,
  uploadItems,
  uploadPolicies,
  uploadPending,
}: {
  canControl: boolean;
  canDelete: boolean;
  canDownload: boolean;
  canEdit: boolean;
  canPlayback: boolean;
  canReadHealth: boolean;
  deletePending: boolean;
  downloadPending: boolean;
  editPending: boolean;
  events: HealthEvent[];
  jobs: RecordingJob[];
  onDelete: () => void;
  onDownload: () => void;
  onEdit: () => void;
  onPlayback: () => void;
  onQueueUpload: (uploadPolicyId?: string) => void;
  onRetryUpload: (itemId: string) => void;
  onSelectedChange?: (selected: boolean) => void;
  onStop: () => void;
  playbackPending: boolean;
  recording: RecordingSummary;
  relationshipReferences?: RecordingRelationshipReferences;
  retryUploadPending: boolean;
  selected?: boolean;
  stopPending: boolean;
  uploadItems: UploadQueueItem[];
  uploadPolicies: UploadPolicy[];
  uploadPending: boolean;
}) {
  const fileReady = isCachedRecording(recording);
  const deleteDisabled = deletePending || !isTerminalRecording(recording);
  const [expanded, setExpanded] = useState(false);
  const [selectedUploadPolicyId, setSelectedUploadPolicyId] = useState(
    recording.uploadPolicyIds?.[0] ?? uploadPolicies[0]?.id ?? "",
  );
  const relationships = recordingRelationshipBadges(recording, relationshipReferences);

  useEffect(() => {
    setSelectedUploadPolicyId(recording.uploadPolicyIds?.[0] ?? uploadPolicies[0]?.id ?? "");
  }, [recording.uploadPolicyIds, uploadPolicies]);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="grid gap-4">
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            {onSelectedChange ? (
              <Checkbox
                aria-label={`Select ${recording.name}`}
                checked={selected}
                className="mt-1"
                onCheckedChange={(value) => onSelectedChange(value === true)}
              />
            ) : null}
            <button
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${recording.name}`}
              className="flex min-w-0 flex-1 items-start gap-2 text-left"
              onClick={() => setExpanded((value) => !value)}
              type="button"
            >
              <div className="grid min-w-0 flex-1 gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold">{recording.name}</h2>
                  <Badge
                    className={toneBadgeClass(
                      recording.healthStatus === "healthy" ? "healthy" : "warning",
                    )}
                    variant="outline"
                  >
                    {recording.healthStatus}
                  </Badge>
                  <Badge variant="secondary">{recording.status}</Badge>
                </div>
                <p className="truncate text-sm text-muted-foreground">{recording.folder}</p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{formatDateTime(recording.recordedAt)}</span>
                  <span>{formatDuration(recording.durationSeconds)}</span>
                  <span>{recording.source}</span>
                </div>
              </div>
              {expanded ? (
                <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          </div>
          {expanded && relationships.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {relationships.map((item) => (
                <Badge
                  className="max-w-full gap-1 overflow-hidden bg-transparent"
                  key={`${item.label}-${item.value}`}
                  variant="outline"
                >
                  <span className="text-muted-foreground">{item.label}</span>
                  <span className="truncate font-mono">{item.value}</span>
                </Badge>
              ))}
            </div>
          ) : null}
          {expanded && recording.tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {recording.tags.map((tag) => (
                <Badge className="bg-transparent" key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
          {expanded && recording.notes ? (
            <p className="mt-3 rounded-md border border-border bg-muted/20 p-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {recording.notes}
            </p>
          ) : null}
          {expanded && recording.transcriptSnippets?.length ? (
            <div className="mt-3 grid gap-1.5 rounded-md border border-border bg-muted/20 p-2 text-sm text-muted-foreground">
              {recording.transcriptSnippets.slice(0, 3).map((snippet) => (
                <p className="max-h-10 overflow-hidden" key={snippet}>
                  {snippet}
                </p>
              ))}
              {recording.transcriptSnippets.length > 3 ? (
                <span className="text-xs">
                  +{recording.transcriptSnippets.length - 3} more snippets
                </span>
              ) : null}
            </div>
          ) : null}
          {expanded && (recording.checksum || recording.waveformPreview) ? (
            <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/20 p-2">
              {recording.checksum ? (
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <Fingerprint className="size-4 shrink-0" />
                  <span className="font-mono break-all">{shortChecksum(recording.checksum)}</span>
                </div>
              ) : null}
              {recording.waveformPreview ? (
                <div className="flex items-center gap-2">
                  <Waves className="size-4 shrink-0 text-muted-foreground" />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <WaveformPreview recording={recording} />
                    <span className="truncate text-xs text-muted-foreground">
                      {waveformPreviewSummary(recording.waveformPreview)}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {expanded && jobs.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {jobs.map((job) => {
                const captureDetails = recordingJobCaptureDetails(job);

                return (
                  <div className="grid gap-2" key={job.id}>
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
                      <Badge className={jobStatusClass(job.status)} variant="outline">
                        {job.status}
                      </Badge>
                      <span className="font-mono break-all text-muted-foreground">{job.id}</span>
                      <span className="text-muted-foreground">{job.claimedBy ?? job.nodeId}</span>
                      {captureDetails.map((item) => (
                        <Badge
                          className="max-w-full gap-1 overflow-hidden bg-transparent"
                          key={`${job.id}-${item.label}`}
                          variant="outline"
                        >
                          <span className="text-muted-foreground">{item.label}</span>
                          <span className="truncate font-mono">{item.value}</span>
                        </Badge>
                      ))}
                      {job.leaseExpiresAt ? (
                        <span className="text-muted-foreground">
                          Lease {formatDateTime(job.leaseExpiresAt)}
                        </span>
                      ) : null}
                      {job.failureReason ? (
                        <span className="text-destructive">{job.failureReason}</span>
                      ) : null}
                    </div>
                    {job.command.chunkSeconds ? (
                      <RecordingJobChunks enabled={expanded} jobId={job.id} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {expanded && uploadItems.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {uploadItems.map((item) => (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs"
                  key={item.id}
                >
                  <Badge className={uploadStatusClass(item.status)} variant="outline">
                    {item.status}
                  </Badge>
                  <span className="font-mono text-muted-foreground">{item.provider}</span>
                  <span className="text-muted-foreground">
                    Attempts {item.attemptCount}/{item.maxAttempts}
                  </span>
                  <span className="text-muted-foreground">
                    Next {formatDateTime(item.nextAttemptAt)}
                  </span>
                  {item.lastError ? (
                    <span className="text-destructive">{item.lastError}</span>
                  ) : null}
                  {canControl ? (
                    <Button
                      disabled={retryUploadPending}
                      onClick={() => onRetryUpload(item.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <RefreshCw className="size-4" />
                      Retry
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {expanded ? (
            canReadHealth ? (
              <QualityTimeline events={events} recording={recording} />
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">Quality timeline unavailable.</p>
            )
          ) : null}
        </div>
        {expanded ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {canEdit ? (
              <Button disabled={editPending} onClick={onEdit} variant="outline">
                <Pencil className="size-4" />
                Edit
              </Button>
            ) : null}
            {canControl && recording.status === "recording" ? (
              <Button disabled={stopPending} onClick={onStop} variant="outline">
                <Square className="size-4" />
                Stop
              </Button>
            ) : null}
            {canPlayback ? (
              <Button
                disabled={!fileReady || playbackPending}
                onClick={onPlayback}
                variant="outline"
              >
                <Play className="size-4" />
                Play
              </Button>
            ) : null}
            {canDownload ? (
              <Button
                disabled={!fileReady || downloadPending}
                onClick={onDownload}
                variant="outline"
              >
                <Download className="size-4" />
                Download
              </Button>
            ) : null}
            {canDelete ? (
              <ConfirmButton
                confirmLabel="Delete"
                description="This permanently deletes the recording metadata and its cached file."
                disabled={deleteDisabled}
                onConfirm={onDelete}
                title={`Delete "${recording.name}"?`}
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Delete
              </ConfirmButton>
            ) : null}
            {canControl ? (
              <>
                {uploadPolicies.length > 0 ? (
                  <Select onValueChange={setSelectedUploadPolicyId} value={selectedUploadPolicyId}>
                    <SelectTrigger className="h-9 w-44">
                      <SelectValue placeholder="Upload policy" />
                    </SelectTrigger>
                    <SelectContent>
                      {uploadPolicies.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <Button
                  disabled={!fileReady || uploadPending}
                  onClick={() => onQueueUpload(selectedUploadPolicyId || undefined)}
                  variant="outline"
                >
                  <UploadCloud className="size-4" />
                  Queue Upload
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function WaveformPreview({ recording }: { recording: RecordingSummary }) {
  const peaks = recording.waveformPreview?.peaks ?? [];

  return (
    <div
      aria-label={`Waveform preview for ${recording.name}`}
      className="flex h-8 min-w-0 flex-1 items-center gap-px overflow-hidden rounded bg-transparent px-1"
    >
      {peaks.map((peak, index) => (
        <span
          className="w-1 shrink-0 rounded-full bg-primary"
          key={`${recording.id}-${index}`}
          style={{ height: waveformBarHeightPercent(peak) }}
        />
      ))}
    </div>
  );
}

function shortChecksum(checksum: string) {
  const withoutPrefix = checksum.replace(/^sha256:/, "");

  return `sha256:${withoutPrefix.slice(0, 16)}`;
}

function jobStatusClass(status: RecordingJob["status"]) {
  if (status === "running") {
    return toneBadgeClass("info");
  }

  if (status === "completed") {
    return toneBadgeClass("healthy");
  }

  if (status === "failed" || status === "cancelled") {
    return toneBadgeClass("critical");
  }

  if (status === "stop_requested") {
    return toneBadgeClass("warning");
  }

  return toneBadgeClass("neutral");
}

function uploadStatusClass(status: UploadQueueItem["status"]) {
  if (status === "queued" || status === "retrying") {
    return toneBadgeClass("info");
  }

  if (status === "succeeded") {
    return toneBadgeClass("healthy");
  }

  if (status === "failed" || status === "cancelled") {
    return toneBadgeClass("critical");
  }

  return toneBadgeClass("neutral");
}

function recordingJobCaptureDetails(job: RecordingJob) {
  const items: Array<{ label: string; value: string }> = [];

  if (job.command.captureInterfaceId) {
    items.push({ label: "interface", value: job.command.captureInterfaceId });
  }

  if (job.command.channelMap) {
    const channels = job.command.channelMap.entries
      .filter((entry) => entry.included)
      .map((entry) => entry.sourceChannelIndex)
      .sort((left, right) => left - right);

    items.push({ label: "map", value: job.command.channelMap.templateName });
    items.push({ label: "mode", value: job.command.channelMap.channelMode });
    items.push({
      label: "channels",
      value: channels.length > 0 ? channels.join(",") : `${job.command.channelMap.sourceChannels}`,
    });
  }

  return items;
}
