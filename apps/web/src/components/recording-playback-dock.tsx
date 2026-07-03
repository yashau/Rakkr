import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
            <ToggleGroup
              className="gap-0 overflow-hidden rounded-md border border-border"
              onValueChange={(value) => {
                const next = value[0] as RecordingRendition | undefined;
                if (next) onSelectRendition(next);
              }}
              size="sm"
              value={preview.rendition ? [preview.rendition] : []}
            >
              {availableRenditions.map((rendition) => (
                <ToggleGroupItem
                  className="rounded-none border-0 px-2.5 text-xs font-medium"
                  key={rendition}
                  value={rendition}
                >
                  {renditionLabels[rendition]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
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
