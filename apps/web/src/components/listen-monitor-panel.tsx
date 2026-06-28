import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Radio, RefreshCcw, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type ListenMonitorSession } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { listenMonitorModeLabel, listenMonitorPollInterval } from "@/lib/node-page-helpers";

export interface ListenMonitorPreview {
  nodeAlias: string;
  session: ListenMonitorSession;
}

interface ListenMonitorPanelProps {
  onClose: () => void;
  preview: ListenMonitorPreview;
}

export function ListenMonitorPanel({ onClose, preview }: ListenMonitorPanelProps) {
  const pollInterval = listenMonitorPollInterval(preview.session.targetLatencyMs);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [refreshedAt, setRefreshedAt] = useState<string>();
  const stopMutation = useMutation({
    mutationFn: () => api.stopListen(preview.session),
    onError: () =>
      toast.error("Stop listen failed", {
        description: "The monitor session may still be active on the recorder node.",
      }),
    onSettled: onClose,
  });
  const streamQuery = useQuery({
    queryFn: () => api.listenStream(preview.session.streamUrl),
    queryKey: ["nodes", "listen-monitor", preview.session.nodeId, preview.session.sessionId],
    refetchInterval: pollInterval,
    refetchIntervalInBackground: true,
    retry: 1,
    staleTime: 0,
  });

  useEffect(() => {
    if (!streamQuery.data) {
      return undefined;
    }

    const nextUrl = URL.createObjectURL(streamQuery.data.blob);
    setAudioUrl(nextUrl);
    setRefreshedAt(new Date().toISOString());

    return () => URL.revokeObjectURL(nextUrl);
  }, [streamQuery.data]);

  return (
    <section className="rounded-lg border border-border bg-panel px-4 py-3 shadow-sm">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Radio className="size-4 text-accent" />
            <h2 className="text-sm font-semibold">{preview.nodeAlias}</h2>
            <Badge variant="outline">{listenMonitorModeLabel(preview.session.mode)}</Badge>
            <Badge variant="secondary">{pollInterval}ms</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {preview.session.sessionId} / started {formatDateTime(preview.session.startedAt)}
            {refreshedAt ? ` / refreshed ${formatDateTime(refreshedAt)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  disabled={streamQuery.isFetching}
                  onClick={() => void streamQuery.refetch()}
                  size="icon"
                  variant="outline"
                >
                  <RefreshCcw className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Refresh monitor audio</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  disabled={stopMutation.isPending}
                  onClick={() => stopMutation.mutate()}
                  size="icon"
                  variant="outline"
                >
                  <X className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Stop listen monitor</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {streamQuery.isError ? (
        <p className="mb-2 text-sm text-destructive">Monitor audio unavailable.</p>
      ) : null}
      {audioUrl ? (
        <audio autoPlay className="w-full" controls src={audioUrl}>
          <track kind="captions" />
        </audio>
      ) : (
        <Skeleton aria-label="Loading monitor audio" className="h-10 w-full" />
      )}
    </section>
  );
}
