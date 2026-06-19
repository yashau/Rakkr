import {
  Check,
  Download,
  Fingerprint,
  Pencil,
  Play,
  RefreshCw,
  Square,
  UploadCloud,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  HealthEvent,
  RecordingJob,
  RecordingSummary,
  UploadPolicy,
  UploadQueueItem,
} from "@rakkr/shared";

import { QualityTimeline } from "@/components/quality-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RecordingMetadataUpdate } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/dates";

interface RecordingMetadataDraft {
  folder: string;
  name: string;
  tags: string;
}

export function RecordingCard({
  canControl,
  canDownload,
  canEdit,
  canPlayback,
  downloadPending,
  editPending,
  events,
  jobs,
  onDownload,
  onPlayback,
  onQueueUpload,
  onRetryUpload,
  onStop,
  onUpdate,
  playbackPending,
  recording,
  retryUploadPending,
  stopPending,
  uploadItems,
  uploadPolicies,
  uploadPending,
}: {
  canControl: boolean;
  canDownload: boolean;
  canEdit: boolean;
  canPlayback: boolean;
  downloadPending: boolean;
  editPending: boolean;
  events: HealthEvent[];
  jobs: RecordingJob[];
  onDownload: () => void;
  onPlayback: () => void;
  onQueueUpload: (uploadPolicyId?: string) => void;
  onRetryUpload: (itemId: string) => void;
  onStop: () => void;
  onUpdate: (input: RecordingMetadataUpdate) => Promise<unknown>;
  playbackPending: boolean;
  recording: RecordingSummary;
  retryUploadPending: boolean;
  stopPending: boolean;
  uploadItems: UploadQueueItem[];
  uploadPolicies: UploadPolicy[];
  uploadPending: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const fileReady =
    recording.cached || recording.status === "cached" || recording.status === "uploaded";
  const [draft, setDraft] = useState<RecordingMetadataDraft>(() => draftFromRecording(recording));
  const [selectedUploadPolicyId, setSelectedUploadPolicyId] = useState(
    recording.uploadPolicyId ?? uploadPolicies[0]?.id ?? "",
  );
  const relationships = recordingRelationships(recording);

  useEffect(() => {
    if (!isEditing) {
      setDraft(draftFromRecording(recording));
    }
  }, [isEditing, recording]);

  useEffect(() => {
    setSelectedUploadPolicyId(recording.uploadPolicyId ?? uploadPolicies[0]?.id ?? "");
  }, [recording.uploadPolicyId, uploadPolicies]);

  const resetDraft = () => {
    setDraft(draftFromRecording(recording));
    setIsEditing(false);
  };
  const saveDisabled = editPending || !draft.name.trim() || !draft.folder.trim();

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void onUpdate({
                  folder: draft.folder.trim(),
                  name: draft.name.trim(),
                  tags: tagsFromText(draft.tags),
                })
                  .then(() => setIsEditing(false))
                  .catch(() => undefined);
              }}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${recording.id}-name`}>Name</Label>
                  <Input
                    id={`${recording.id}-name`}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    value={draft.name}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${recording.id}-folder`}>Folder</Label>
                  <Input
                    id={`${recording.id}-folder`}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, folder: event.target.value }))
                    }
                    value={draft.folder}
                  />
                </div>
                <div className="grid gap-1.5 md:col-span-2">
                  <Label htmlFor={`${recording.id}-tags`}>Tags</Label>
                  <Input
                    id={`${recording.id}-tags`}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, tags: event.target.value }))
                    }
                    value={draft.tags}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={saveDisabled} type="submit">
                  <Check className="size-4" />
                  Save
                </Button>
                <Button onClick={resetDraft} type="button" variant="outline">
                  <X className="size-4" />
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-semibold">{recording.name}</h2>
                <Badge
                  className={
                    recording.healthStatus === "healthy"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700"
                  }
                  variant="outline"
                >
                  {recording.healthStatus}
                </Badge>
                <Badge variant="secondary">{recording.status}</Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">{recording.folder}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>{formatDateTime(recording.recordedAt)}</span>
                <span>{formatDuration(recording.durationSeconds)}</span>
                <span>{recording.source}</span>
              </div>
              {relationships.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {relationships.map((item) => (
                    <Badge
                      className="max-w-full gap-1 overflow-hidden bg-background"
                      key={`${item.label}-${item.value}`}
                      variant="outline"
                    >
                      <span className="text-muted-foreground">{item.label}</span>
                      <span className="truncate font-mono">{item.value}</span>
                    </Badge>
                  ))}
                </div>
              ) : null}
              {recording.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {recording.tags.map((tag) => (
                    <Badge className="bg-background" key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {recording.checksum || recording.waveformPreview ? (
                <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/20 p-2">
                  {recording.checksum ? (
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <Fingerprint className="size-4 shrink-0" />
                      <span className="font-mono break-all">
                        {shortChecksum(recording.checksum)}
                      </span>
                    </div>
                  ) : null}
                  {recording.waveformPreview ? (
                    <div className="flex items-center gap-2">
                      <Waves className="size-4 shrink-0 text-muted-foreground" />
                      <WaveformPreview recording={recording} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          {jobs.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {jobs.map((job) => {
                const captureDetails = recordingJobCaptureDetails(job);

                return (
                  <div
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs"
                    key={job.id}
                  >
                    <Badge className={jobStatusClass(job.status)} variant="outline">
                      {job.status}
                    </Badge>
                    <span className="font-mono break-all text-muted-foreground">{job.id}</span>
                    <span className="text-muted-foreground">{job.claimedBy ?? job.nodeId}</span>
                    {captureDetails.map((item) => (
                      <Badge
                        className="max-w-full gap-1 overflow-hidden bg-background"
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
                );
              })}
            </div>
          ) : null}
          {uploadItems.length > 0 ? (
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
          <QualityTimeline events={events} recording={recording} />
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {canEdit && !isEditing ? (
            <Button disabled={editPending} onClick={() => setIsEditing(true)} variant="outline">
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
            <Button disabled={!fileReady || playbackPending} onClick={onPlayback} variant="outline">
              <Play className="size-4" />
              Play
            </Button>
          ) : null}
          {canDownload ? (
            <Button disabled={!fileReady || downloadPending} onClick={onDownload} variant="outline">
              <Download className="size-4" />
              Download
            </Button>
          ) : null}
          {canControl ? (
            <>
              {uploadPolicies.length > 0 ? (
                <select
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  onChange={(event) => setSelectedUploadPolicyId(event.target.value)}
                  value={selectedUploadPolicyId}
                >
                  {uploadPolicies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                    </option>
                  ))}
                </select>
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
      </div>
    </Card>
  );
}

function WaveformPreview({ recording }: { recording: RecordingSummary }) {
  const peaks = recording.waveformPreview?.peaks ?? [];

  return (
    <div
      aria-label={`Waveform preview for ${recording.name}`}
      className="flex h-8 min-w-0 flex-1 items-center gap-px overflow-hidden rounded bg-background px-1"
    >
      {peaks.map((peak, index) => (
        <span
          className="w-1 shrink-0 rounded-full bg-sky-500"
          key={`${recording.id}-${index}`}
          style={{ height: `${Math.max(10, Math.round(peak * 100))}%` }}
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
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "failed" || status === "cancelled") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (status === "stop_requested") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function uploadStatusClass(status: UploadQueueItem["status"]) {
  if (status === "queued" || status === "retrying") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "failed" || status === "cancelled") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function recordingRelationships(recording: RecordingSummary) {
  const items: Array<{ label: string; value: string }> = [];

  if (recording.nodeId) {
    items.push({ label: "node", value: recording.nodeId });
  }

  if (recording.scheduleId) {
    items.push({ label: "schedule", value: recording.scheduleId });
  }

  if (recording.recordingProfileId) {
    items.push({ label: "profile", value: recording.recordingProfileId });
  }

  if (recording.uploadPolicyId) {
    items.push({ label: "upload", value: recording.uploadPolicyId });
  }

  if (recording.trackIndex && recording.trackTotal) {
    items.push({ label: "track", value: `${recording.trackIndex}/${recording.trackTotal}` });
  }

  if (recording.trackGroupId) {
    items.push({ label: "group", value: recording.trackGroupId });
  }

  return items;
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

function draftFromRecording(recording: RecordingSummary): RecordingMetadataDraft {
  return {
    folder: recording.folder,
    name: recording.name,
    tags: tagsToText(recording.tags),
  };
}

function tagsToText(tags: string[]) {
  return tags.join(", ");
}

export function tagsFromText(value: string) {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const tag of value.split(",")) {
    const trimmed = tag.trim();
    const key = trimmed.toLocaleLowerCase();

    if (trimmed && !seen.has(key)) {
      seen.add(key);
      tags.push(trimmed);
    }
  }

  return tags;
}
