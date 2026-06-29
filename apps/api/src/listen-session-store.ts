export interface ListenSessionInput {
  enhance: boolean;
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
  lastSeenAt: string;
}

export interface ListenSessionStore {
  find(nodeId: string, sessionId: string): Promise<ListenSessionRecord | undefined>;
  start(input: ListenSessionInput): Promise<ListenSessionRecord>;
  stop(nodeId: string, sessionId: string): Promise<ListenSessionRecord | undefined>;
  // Whether any live (recently polled) session for the node requested enhanced
  // audio. Drives on-demand monitor enhancement via the agent node-config poll.
  nodeWantsEnhanced(nodeId: string, maxAgeMs: number): Promise<boolean>;
}

export function createListenSessionStore(): ListenSessionStore {
  return new MemoryListenSessionStore();
}

class MemoryListenSessionStore implements ListenSessionStore {
  private readonly sessions = new Map<string, ListenSessionRecord>();

  async find(nodeId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (session?.nodeId !== nodeId) {
      return undefined;
    }

    // Touch on access so a session stays "live" while the browser polls /stream.
    session.lastSeenAt = new Date().toISOString();

    return session;
  }

  async start(input: ListenSessionInput) {
    const session = { ...input, lastSeenAt: new Date().toISOString() };
    this.sessions.set(input.sessionId, session);

    return session;
  }

  async stop(nodeId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (session?.nodeId !== nodeId) {
      return undefined;
    }

    this.sessions.delete(sessionId);

    return {
      ...session,
      endedAt: new Date().toISOString(),
    };
  }

  async nodeWantsEnhanced(nodeId: string, maxAgeMs: number) {
    const oldest = Date.now() - maxAgeMs;

    for (const session of this.sessions.values()) {
      if (
        session.nodeId === nodeId &&
        session.enhance &&
        !session.endedAt &&
        Date.parse(session.lastSeenAt) >= oldest
      ) {
        return true;
      }
    }

    return false;
  }
}
