import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Play, Radio, Square } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/dates";

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ detail: string; title: string }>();
  const recordingsQuery = useQuery({
    queryFn: api.recordings,
    queryKey: ["recordings"],
  });
  const startMutation = useMutation({
    mutationFn: api.startRecording,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recordings"] }),
  });
  const stopMutation = useMutation({
    mutationFn: api.stopRecording,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recordings"] }),
  });
  const playbackMutation = useMutation({
    mutationFn: api.startPlayback,
    onError: () =>
      setNotice({
        detail: "The selected recording could not be opened for playback.",
        title: "Playback unavailable",
      }),
    onSuccess: (response) =>
      setNotice({
        detail: `${response.data.sessionId} started at ${formatDateTime(response.data.startedAt)}`,
        title: "Playback ready",
      }),
  });
  const downloadMutation = useMutation({
    mutationFn: api.prepareRecordingDownload,
    onError: () =>
      setNotice({
        detail: "The selected recording could not be prepared for download.",
        title: "Download unavailable",
      }),
    onSuccess: (response) =>
      setNotice({
        detail: `${response.data.fileName} prepared until ${formatDateTime(response.data.expiresAt)}`,
        title: "Download prepared",
      }),
  });

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

      {recordingsQuery.data?.data.map((recording) => (
        <RecordingCard
          downloadPending={downloadMutation.isPending}
          key={recording.id}
          onDownload={() => downloadMutation.mutate(recording.id)}
          onPlayback={() => playbackMutation.mutate(recording.id)}
          onStop={() => stopMutation.mutate(recording.id)}
          playbackPending={playbackMutation.isPending}
          recording={recording}
          stopPending={stopMutation.isPending}
        />
      ))}
    </div>
  );
}

function RecordingCard({
  downloadPending,
  onDownload,
  onPlayback,
  onStop,
  playbackPending,
  recording,
  stopPending,
}: {
  downloadPending: boolean;
  onDownload: () => void;
  onPlayback: () => void;
  onStop: () => void;
  playbackPending: boolean;
  recording: Awaited<ReturnType<typeof api.recordings>>["data"][number];
  stopPending: boolean;
}) {
  const fileReady =
    recording.cached || recording.status === "cached" || recording.status === "uploaded";

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
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
        </div>
        <div className="flex items-center gap-2">
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
