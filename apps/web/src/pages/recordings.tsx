import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Pencil, Play, Radio, RotateCcw, Search, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { HealthEvent, RecordingJob, RecordingSummary } from "@rakkr/shared";

import { QualityTimeline } from "@/components/quality-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type RecordingFilters, type RecordingMetadataUpdate } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/dates";

interface RecordingMetadataDraft {
  folder: string;
  name: string;
  tags: string;
}

interface RecordingFilterDraft {
  folder: string;
  healthStatus: "" | RecordingSummary["healthStatus"];
  nodeId: string;
  scheduleId: string;
  search: string;
  status: "" | RecordingSummary["status"];
  tag: string;
}

const emptyRecordingFilterDraft: RecordingFilterDraft = {
  folder: "",
  healthStatus: "",
  nodeId: "",
  scheduleId: "",
  search: "",
  status: "",
  tag: "",
};

const healthStatuses: Array<RecordingSummary["healthStatus"]> = [
  "healthy",
  "warning",
  "critical",
  "unknown",
];

const recordingStatuses: Array<RecordingSummary["status"]> = [
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
];

const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const [audioPreview, setAudioPreview] = useState<{ name: string; url: string }>();
  const [filterDraft, setFilterDraft] = useState<RecordingFilterDraft>(emptyRecordingFilterDraft);
  const [recordingFilters, setRecordingFilters] = useState<RecordingFilters>({});
  const [notice, setNotice] = useState<{ detail: string; title: string }>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const recordingsQuery = useQuery({
    queryFn: () => api.recordings(recordingFilters),
    queryKey: ["recordings", recordingFilters],
  });
  const recordingJobsQuery = useQuery({
    queryFn: api.recordingJobs,
    queryKey: ["recording-jobs"],
    refetchInterval: 3000,
  });
  const healthEventsQuery = useQuery({
    queryFn: () => api.healthEvents({ limit: 500 }),
    queryKey: ["health-events", "recordings"],
    refetchInterval: 5000,
  });
  const startMutation = useMutation({
    mutationFn: api.startRecording,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const stopMutation = useMutation({
    mutationFn: api.stopRecording,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const playbackMutation = useMutation({
    mutationFn: async (recordingId: string) => {
      const playback = await api.startPlayback(recordingId);
      const stream = await api.recordingStream(recordingId);

      return {
        playback: playback.data,
        stream,
      };
    },
    onError: () =>
      setNotice({
        detail: "The selected recording could not be opened for playback.",
        title: "Playback unavailable",
      }),
    onSuccess: (response) => {
      const url = URL.createObjectURL(response.stream.blob);

      setAudioPreview({
        name: response.stream.fileName,
        url,
      });
      setNotice({
        detail: `${response.playback.sessionId} started at ${formatDateTime(response.playback.startedAt)}`,
        title: "Playback ready",
      });
    },
  });
  const downloadMutation = useMutation({
    mutationFn: async (recordingId: string) => {
      const ticket = await api.prepareRecordingDownload(recordingId);
      const file = await api.recordingFile(recordingId);

      return {
        file,
        ticket: ticket.data,
      };
    },
    onError: () =>
      setNotice({
        detail: "The selected recording could not be prepared for download.",
        title: "Download unavailable",
      }),
    onSuccess: (response) => {
      downloadBlob(response.file);
      setNotice({
        detail: `${response.ticket.fileName} prepared until ${formatDateTime(response.ticket.expiresAt)}`,
        title: "Download prepared",
      });
    },
  });
  const updateMetadataMutation = useMutation({
    mutationFn: ({ input, recordingId }: { input: RecordingMetadataUpdate; recordingId: string }) =>
      api.updateRecordingMetadata(recordingId, input),
    onError: () =>
      setNotice({
        detail: "The selected recording metadata could not be saved.",
        title: "Update failed",
      }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
      setNotice({
        detail: `${response.data.name} was saved.`,
        title: "Recording updated",
      });
    },
  });

  const canEditRecordings =
    currentUserQuery.data?.data.permissions.includes("recording:edit") ?? false;
  const recordings = recordingsQuery.data?.data ?? [];
  const healthEventsByRecording = groupHealthEventsByRecording(healthEventsQuery.data?.data ?? []);
  const activeFilterCount = Object.values(recordingFilters).filter(Boolean).length;

  useEffect(
    () => () => {
      if (audioPreview?.url) {
        URL.revokeObjectURL(audioPreview.url);
      }
    },
    [audioPreview?.url],
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Recordings</h2>
        <Button disabled={startMutation.isPending} onClick={() => startMutation.mutate()}>
          <Radio className="size-4" />
          Start
        </Button>
      </div>

      {notice ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <div className="font-medium">{notice.title}</div>
          <div className="text-emerald-700">{notice.detail}</div>
        </section>
      ) : null}

      {audioPreview ? (
        <section className="rounded-lg border border-border bg-panel px-4 py-3 shadow-sm">
          <div className="mb-2 text-sm font-medium">{audioPreview.name}</div>
          <audio className="w-full" controls src={audioPreview.url}>
            <track kind="captions" />
          </audio>
        </section>
      ) : null}

      <form
        className="grid gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          setRecordingFilters(filtersFromDraft(filterDraft));
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Library filters</h3>
            <p className="text-xs text-muted-foreground">
              {recordings.length} result{recordings.length === 1 ? "" : "s"}
              {activeFilterCount > 0 ? `, ${activeFilterCount} filter active` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">
              <Search className="size-4" />
              Search
            </Button>
            <Button
              onClick={() => {
                setFilterDraft(emptyRecordingFilterDraft);
                setRecordingFilters({});
              }}
              type="button"
              variant="outline"
            >
              <RotateCcw className="size-4" />
              Clear
            </Button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="recording-search">Search</Label>
            <Input
              id="recording-search"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, search: event.target.value }))
              }
              placeholder="Name, folder, tag, ID, node, schedule"
              value={filterDraft.search}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-folder-filter">Folder</Label>
            <Input
              id="recording-folder-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, folder: event.target.value }))
              }
              value={filterDraft.folder}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-tag-filter">Tag</Label>
            <Input
              id="recording-tag-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, tag: event.target.value }))
              }
              value={filterDraft.tag}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-node-filter">Node</Label>
            <Input
              id="recording-node-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, nodeId: event.target.value }))
              }
              value={filterDraft.nodeId}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-schedule-filter">Schedule</Label>
            <Input
              id="recording-schedule-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, scheduleId: event.target.value }))
              }
              value={filterDraft.scheduleId}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-status-filter">Status</Label>
            <select
              className={selectClassName}
              id="recording-status-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  status: event.target.value as RecordingFilterDraft["status"],
                }))
              }
              value={filterDraft.status}
            >
              <option value="">Any status</option>
              {recordingStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-health-filter">Health</Label>
            <select
              className={selectClassName}
              id="recording-health-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  healthStatus: event.target.value as RecordingFilterDraft["healthStatus"],
                }))
              }
              value={filterDraft.healthStatus}
            >
              <option value="">Any health</option>
              {healthStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </div>
      </form>

      {!recordingsQuery.isPending && recordings.length === 0 ? (
        <section className="rounded-lg border border-border bg-panel px-4 py-8 text-center text-sm text-muted-foreground">
          No recordings match the current filters.
        </section>
      ) : null}

      {recordings.map((recording) => {
        const jobs =
          recordingJobsQuery.data?.data.filter((job) => job.recordingId === recording.id) ?? [];

        return (
          <RecordingCard
            downloadPending={downloadMutation.isPending}
            events={healthEventsByRecording.get(recording.id) ?? []}
            canEdit={canEditRecordings}
            editPending={updateMetadataMutation.isPending}
            jobs={jobs}
            key={recording.id}
            onDownload={() => downloadMutation.mutate(recording.id)}
            onPlayback={() => playbackMutation.mutate(recording.id)}
            onStop={() => stopMutation.mutate(recording.id)}
            onUpdate={(input) =>
              updateMetadataMutation.mutateAsync({
                input,
                recordingId: recording.id,
              })
            }
            playbackPending={playbackMutation.isPending}
            recording={recording}
            stopPending={stopMutation.isPending}
          />
        );
      })}
    </div>
  );
}

function downloadBlob(file: Awaited<ReturnType<typeof api.recordingFile>>) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function filtersFromDraft(draft: RecordingFilterDraft): RecordingFilters {
  return {
    folder: textOrUndefined(draft.folder),
    healthStatus: draft.healthStatus || undefined,
    nodeId: textOrUndefined(draft.nodeId),
    scheduleId: textOrUndefined(draft.scheduleId),
    search: textOrUndefined(draft.search),
    status: draft.status || undefined,
    tag: textOrUndefined(draft.tag),
  };
}

function textOrUndefined(value: string) {
  const trimmed = value.trim();

  return trimmed || undefined;
}

function groupHealthEventsByRecording(events: HealthEvent[]) {
  const grouped = new Map<string, HealthEvent[]>();

  for (const event of events) {
    if (!event.recordingId) {
      continue;
    }

    grouped.set(event.recordingId, [...(grouped.get(event.recordingId) ?? []), event]);
  }

  return grouped;
}

function RecordingCard({
  canEdit,
  downloadPending,
  editPending,
  events,
  jobs,
  onDownload,
  onPlayback,
  onStop,
  onUpdate,
  playbackPending,
  recording,
  stopPending,
}: {
  canEdit: boolean;
  downloadPending: boolean;
  editPending: boolean;
  events: HealthEvent[];
  jobs: RecordingJob[];
  onDownload: () => void;
  onPlayback: () => void;
  onStop: () => void;
  onUpdate: (input: RecordingMetadataUpdate) => Promise<unknown>;
  playbackPending: boolean;
  recording: RecordingSummary;
  stopPending: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const fileReady =
    recording.cached || recording.status === "cached" || recording.status === "uploaded";
  const [draft, setDraft] = useState<RecordingMetadataDraft>(() => draftFromRecording(recording));

  useEffect(() => {
    if (!isEditing) {
      setDraft(draftFromRecording(recording));
    }
  }, [isEditing, recording]);

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
              {recording.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {recording.tags.map((tag) => (
                    <Badge className="bg-background" key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </>
          )}
          {jobs.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {jobs.map((job) => (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs"
                  key={job.id}
                >
                  <Badge className={jobStatusClass(job.status)} variant="outline">
                    {job.status}
                  </Badge>
                  <span className="font-mono break-all text-muted-foreground">{job.id}</span>
                  <span className="text-muted-foreground">{job.claimedBy ?? job.nodeId}</span>
                  {job.leaseExpiresAt ? (
                    <span className="text-muted-foreground">
                      Lease {formatDateTime(job.leaseExpiresAt)}
                    </span>
                  ) : null}
                  {job.failureReason ? (
                    <span className="text-destructive">{job.failureReason}</span>
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
          {recording.status === "recording" ? (
            <Button disabled={stopPending} onClick={onStop} variant="outline">
              <Square className="size-4" />
              Stop
            </Button>
          ) : null}
          <Button disabled={!fileReady || playbackPending} onClick={onPlayback} variant="outline">
            <Play className="size-4" />
            Play
          </Button>
          <Button disabled={!fileReady || downloadPending} onClick={onDownload} variant="outline">
            <Download className="size-4" />
            Download
          </Button>
        </div>
      </div>
    </Card>
  );
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

function tagsFromText(value: string) {
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
