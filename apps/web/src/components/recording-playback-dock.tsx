import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import type { RecordingPlaybackPreview } from "@/lib/recording-page-helpers";

/** A docked audio player fixed to the bottom of the viewport so it stays reachable. */
export function RecordingPlaybackDock({
  onClose,
  preview,
}: {
  onClose: () => void;
  preview: RecordingPlaybackPreview;
}) {
  return (
    <section className="fixed inset-x-4 bottom-4 z-30 rounded-lg border border-border bg-panel px-4 py-3 shadow-lg lg:left-68">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{preview.fileName}</div>
          <div className="text-xs text-muted-foreground">
            Session {preview.sessionId} started {formatDateTime(preview.startedAt)}
          </div>
        </div>
        <Button aria-label="Close playback" onClick={onClose} size="icon" variant="ghost">
          <X className="size-4" />
        </Button>
      </div>
      <audio className="w-full" controls src={preview.objectUrl}>
        <track kind="captions" />
      </audio>
    </section>
  );
}
