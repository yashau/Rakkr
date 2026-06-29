import { useMutation } from "@tanstack/react-query";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  playbackPreviewFromSession,
  replacePlaybackPreview,
  type RecordingPlaybackPreview,
  type RecordingRendition,
} from "@/lib/recording-page-helpers";

interface PlaybackNotice {
  detail: string;
  title: string;
}

/** Playback mutation: starts a playback session, streams the chosen rendition, and
 * swaps the docked preview. Extracted from the recordings page to keep it lean. */
export function useRecordingPlaybackMutation(deps: {
  audioPreviewRef: MutableRefObject<RecordingPlaybackPreview | undefined>;
  setAudioPreview: Dispatch<SetStateAction<RecordingPlaybackPreview | undefined>>;
  setNotice: (notice: PlaybackNotice) => void;
}) {
  return useMutation({
    mutationFn: async ({
      recordingId,
      rendition,
    }: {
      recordingId: string;
      rendition?: RecordingRendition;
    }) => {
      const playback = await api.startPlayback(recordingId);
      const stream = await api.recordingStream(recordingId, rendition);

      return {
        playback: playback.data,
        rendition: rendition ?? ("enhanced" as RecordingRendition),
        stream,
      };
    },
    onError: () =>
      deps.setNotice({
        detail: "The selected recording could not be opened for playback.",
        title: "Playback unavailable",
      }),
    onSuccess: (response) => {
      const url = URL.createObjectURL(response.stream.blob);
      const preview = playbackPreviewFromSession(
        response.playback,
        response.stream,
        url,
        response.rendition,
      );

      deps.setAudioPreview((current) => {
        const next = replacePlaybackPreview(current, preview);

        deps.audioPreviewRef.current = next;

        return next;
      });
      deps.setNotice({
        detail: `${response.playback.sessionId} started at ${formatDateTime(response.playback.startedAt)}`,
        title: "Playback ready",
      });
    },
  });
}
