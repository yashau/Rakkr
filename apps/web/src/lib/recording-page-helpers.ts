import type { HealthEvent, RecordingSummary, UploadQueueItem } from "@rakkr/shared";

export interface DownloadableRecordingFile {
  blob: Blob;
  fileName: string;
}

export function downloadBlob(file: DownloadableRecordingFile) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function groupHealthEventsByRecording(events: HealthEvent[]) {
  const grouped = new Map<string, HealthEvent[]>();

  for (const event of events) {
    if (!event.recordingId) {
      continue;
    }

    grouped.set(event.recordingId, [...(grouped.get(event.recordingId) ?? []), event]);
  }

  return grouped;
}

export function groupUploadItemsByRecording(items: UploadQueueItem[]) {
  const grouped = new Map<string, UploadQueueItem[]>();

  for (const item of items) {
    grouped.set(item.recordingId, [...(grouped.get(item.recordingId) ?? []), item]);
  }

  return grouped;
}

export function isTerminalRecording(recording: RecordingSummary) {
  return recording.status !== "queued" && recording.status !== "recording";
}
