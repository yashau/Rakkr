import type { MeterFrame } from "@rakkr/shared";

interface StoredMeterFrame {
  frame: MeterFrame;
  receivedAt: string;
}

export interface MeterFrameStore {
  history(nodeId: string, limit?: number): Promise<MeterFrame[]>;
  latest(nodeId: string): Promise<MeterFrame | undefined>;
  save(frame: MeterFrame): Promise<StoredMeterFrame>;
}

export function createMeterFrameStore(): MeterFrameStore {
  return new MemoryMeterFrameStore();
}

class MemoryMeterFrameStore implements MeterFrameStore {
  private readonly frames = new Map<string, StoredMeterFrame>();
  private readonly histories = new Map<string, MeterFrame[]>();

  async history(nodeId: string, limit = meterHistoryLimit()) {
    return (this.histories.get(nodeId) ?? []).slice(0, limit);
  }

  async latest(nodeId: string) {
    return this.frames.get(nodeId)?.frame;
  }

  async save(frame: MeterFrame) {
    const stored = {
      frame,
      receivedAt: new Date().toISOString(),
    };

    this.frames.set(frame.nodeId, stored);
    const history = [frame, ...(this.histories.get(frame.nodeId) ?? [])].slice(
      0,
      meterHistoryLimit(),
    );

    this.histories.set(frame.nodeId, history);

    return stored;
  }
}

function meterHistoryLimit() {
  const parsed = Number(process.env.RAKKR_METER_HISTORY_LIMIT);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 600;
}
