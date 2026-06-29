export type ListenMonitorRendition = "enhanced" | "raw";

export interface ListenMonitorChunkInput {
  audio: Uint8Array;
  capturedAt: string;
  contentType: "audio/wav";
  durationMs: number;
  nodeId: string;
  rendition?: ListenMonitorRendition;
}

export interface StoredListenMonitorChunk extends ListenMonitorChunkInput {
  receivedAt: string;
  rendition: ListenMonitorRendition;
  source: "agent_audio_chunk";
}

export interface ListenMonitorStore {
  all(): Promise<StoredListenMonitorChunk[]>;
  latest(
    nodeId: string,
    rendition?: ListenMonitorRendition,
  ): Promise<StoredListenMonitorChunk | undefined>;
  save(input: ListenMonitorChunkInput): Promise<StoredListenMonitorChunk>;
}

export function createListenMonitorStore(): ListenMonitorStore {
  return new MemoryListenMonitorStore();
}

class MemoryListenMonitorStore implements ListenMonitorStore {
  // Keyed by `${nodeId}:${rendition}` so raw and enhanced chunks are kept apart.
  private readonly chunks = new Map<string, StoredListenMonitorChunk>();

  async all() {
    return Array.from(this.chunks.values());
  }

  async latest(nodeId: string, rendition: ListenMonitorRendition = "raw") {
    return this.chunks.get(`${nodeId}:${rendition}`);
  }

  async save(input: ListenMonitorChunkInput) {
    const rendition = input.rendition ?? "raw";
    const stored: StoredListenMonitorChunk = {
      ...input,
      audio: Uint8Array.from(input.audio),
      receivedAt: new Date().toISOString(),
      rendition,
      source: "agent_audio_chunk",
    };

    this.chunks.set(`${input.nodeId}:${rendition}`, stored);

    return stored;
  }
}
