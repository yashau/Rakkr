import { useQuery } from "@tanstack/react-query";
import { Download, Play } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/dates";

export function RecordingsPage() {
  const recordingsQuery = useQuery({
    queryFn: api.recordings,
    queryKey: ["recordings"],
  });

  return (
    <div className="grid gap-4">
      {recordingsQuery.data?.data.map((recording) => (
        <Card className="rounded-lg p-4 shadow-sm" key={recording.id}>
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
              <Button variant="outline">
                <Play className="size-4" />
                Play
              </Button>
              <Button variant="outline">
                <Download className="size-4" />
                Download
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
