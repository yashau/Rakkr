import type { MeterFrame } from "@rakkr/shared";

interface StoredMeterFrame {
  frame: MeterFrame;
  receivedAt: string;
}

export interface MeterFrameStore {
  latest(nodeId: string): Promise<MeterFrame | undefined>;
  save(frame: MeterFrame): Promise<StoredMeterFrame>;
}

export function createMeterFrameStore(): MeterFrameStore {
  return new MemoryMeterFrameStore();
}

class MemoryMeterFrameStore implements MeterFrameStore {
  private readonly frames = new Map<string, StoredMeterFrame>();

  async latest(nodeId: string) {
    return this.frames.get(nodeId)?.frame;
  }

  async save(frame: MeterFrame) {
    const stored = {
      frame,
      receivedAt: new Date().toISOString(),
    };

    this.frames.set(frame.nodeId, stored);

    return stored;
  }
}
