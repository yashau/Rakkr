import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import type { RecordingPlaybackPreview, RecordingRendition } from "@/lib/recording-page-helpers";

const renditionLabels: Record<RecordingRendition, string> = {
  enhanced: "Enhanced",
  raw: "Raw",
};

/** A docked audio player fixed to the bottom of the viewport so it stays reachable. */
export function RecordingPlaybackDock({
  availableRenditions,
  onClose,
  onSelectRendition,
  preview,
}: {
  availableRenditions: RecordingRendition[];
  onClose: () => void;
  onSelectRendition: (rendition: RecordingRendition) => void;
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
        <div className="flex items-center gap-2">
          {availableRenditions.length > 1 ? (
            <div className="flex overflow-hidden rounded-md border border-border">
              {availableRenditions.map((rendition) => (
                <button
                  aria-pressed={preview.rendition === rendition}
                  className={`px-2.5 py-1 text-xs font-medium ${
                    preview.rendition === rendition
                      ? "bg-zinc-950 text-white"
                      : "bg-background text-stone-600 hover:bg-stone-100"
                  }`}
                  key={rendition}
                  onClick={() => onSelectRendition(rendition)}
                  type="button"
                >
                  {renditionLabels[rendition]}
                </button>
              ))}
            </div>
          ) : null}
          <Button aria-label="Close playback" onClick={onClose} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <audio className="w-full" controls src={preview.objectUrl}>
        <track kind="captions" />
      </audio>
    </section>
  );
}
