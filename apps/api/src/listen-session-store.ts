export interface ListenSessionInput {
  mode: "agent_audio_chunk" | "controller_meter_preview";
  nodeId: string;
  sessionId: string;
  startedAt: string;
  stopUrl: string;
  streamUrl: string;
  targetLatencyMs: number;
}

export interface ListenSessionRecord extends ListenSessionInput {
  endedAt?: string;
}

export interface ListenSessionStore {
  find(nodeId: string, sessionId: string): Promise<ListenSessionRecord | undefined>;
  start(input: ListenSessionInput): Promise<ListenSessionRecord>;
  stop(nodeId: string, sessionId: string): Promise<ListenSessionRecord | undefined>;
}

export function createListenSessionStore(): ListenSessionStore {
  return new MemoryListenSessionStore();
}

class MemoryListenSessionStore implements ListenSessionStore {
  private readonly sessions = new Map<string, ListenSessionRecord>();

  async find(nodeId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);

    return session?.nodeId === nodeId ? session : undefined;
  }

  async start(input: ListenSessionInput) {
    const session = { ...input };
    this.sessions.set(input.sessionId, session);

    return session;
  }

  async stop(nodeId: string, sessionId: string) {
    const session = await this.find(nodeId, sessionId);

    if (!session) {
      return undefined;
    }

    this.sessions.delete(sessionId);

    return {
      ...session,
      endedAt: new Date().toISOString(),
    };
  }
}
