import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Play, Radio, Square } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/dates";

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const [audioPreview, setAudioPreview] = useState<{ name: string; url: string }>();
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

function downloadBlob(file: Awaited<ReturnType<typeof api.recordingFile>>) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
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
