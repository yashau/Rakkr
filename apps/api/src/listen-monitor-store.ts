export interface ListenMonitorChunkInput {
  audio: Uint8Array;
  capturedAt: string;
  contentType: "audio/wav";
  durationMs: number;
  nodeId: string;
}

export interface StoredListenMonitorChunk extends ListenMonitorChunkInput {
  receivedAt: string;
  source: "agent_audio_chunk";
}

export interface ListenMonitorStore {
  all(): Promise<StoredListenMonitorChunk[]>;
  latest(nodeId: string): Promise<StoredListenMonitorChunk | undefined>;
  save(input: ListenMonitorChunkInput): Promise<StoredListenMonitorChunk>;
}

export function createListenMonitorStore(): ListenMonitorStore {
  return new MemoryListenMonitorStore();
}

class MemoryListenMonitorStore implements ListenMonitorStore {
  private readonly chunks = new Map<string, StoredListenMonitorChunk>();

  async all() {
    return Array.from(this.chunks.values());
  }

  async latest(nodeId: string) {
    return this.chunks.get(nodeId);
  }

  async save(input: ListenMonitorChunkInput) {
    const stored: StoredListenMonitorChunk = {
      ...input,
      audio: Uint8Array.from(input.audio),
      receivedAt: new Date().toISOString(),
      source: "agent_audio_chunk",
    };

    this.chunks.set(input.nodeId, stored);

    return stored;
  }
}
