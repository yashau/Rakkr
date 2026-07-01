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

export function createListenSessionStore(now: () => number = () => Date.now()): ListenSessionStore {
  return new MemoryListenSessionStore(now);
}

// A live-listen browser polls /stream continuously; a session not polled for
// this long has been abandoned (tab closed / network dropped without a DELETE)
// and is evicted so the store cannot grow without bound.
function listenSessionTtlMs(): number {
  const parsed = Number(process.env.RAKKR_LISTEN_SESSION_TTL_SECONDS);

  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 300) * 1_000;
}

class MemoryListenSessionStore implements ListenSessionStore {
  private readonly sessions = new Map<string, ListenSessionRecord>();

  constructor(private readonly now: () => number) {}

  async find(nodeId: string, sessionId: string) {
    this.evictAbandoned();
    const session = this.sessions.get(sessionId);

    if (session?.nodeId !== nodeId) {
      return undefined;
    }

    // Touch on access so a session stays "live" while the browser polls /stream.
    session.lastSeenAt = new Date(this.now()).toISOString();

    return session;
  }

  async start(input: ListenSessionInput) {
    this.evictAbandoned();
    const session = { ...input, lastSeenAt: new Date(this.now()).toISOString() };
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
      endedAt: new Date(this.now()).toISOString(),
    };
  }

  async nodeWantsEnhanced(nodeId: string, maxAgeMs: number) {
    this.evictAbandoned();
    const oldest = this.now() - maxAgeMs;

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

  // Drop sessions whose last poll is older than the TTL. Called on every access
  // so an abandoned session cannot linger for the process lifetime.
  private evictAbandoned() {
    const oldest = this.now() - listenSessionTtlMs();

    for (const [sessionId, session] of this.sessions) {
      if (Date.parse(session.lastSeenAt) < oldest) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
