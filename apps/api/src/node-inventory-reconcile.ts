import { randomUUID } from "node:crypto";
import { audioChannels, audioInterfaces, createDatabase, eq, inArray } from "@rakkr/db";
import type { AudioInterface } from "@rakkr/shared";

import type { NodeInterfaceInput } from "./node-store.js";

// Reconciles the agent's discovered audio interfaces into the controller's
// record. The agent owns hardware facts (existence, channel count, sample
// rates, system refs); the operator owns labels (interface alias + per-channel
// aliases). Interfaces are matched by a stable identity so the persisted UUID —
// and therefore any channel-map assignment keyed on it — survives across
// restarts. Devices the agent no longer reports are flagged absent rather than
// hard-deleted, preserving channel-map history.

type Database = ReturnType<typeof createDatabase>;
type AudioInterfaceRow = typeof audioInterfaces.$inferSelect;

export interface InterfaceReconcileSummary {
  added: string[];
  absent: string[];
  reactivated: string[];
  unchanged: number;
  updated: string[];
}

export function emptyReconcileSummary(): InterfaceReconcileSummary {
  return { added: [], absent: [], reactivated: [], unchanged: 0, updated: [] };
}

export function reconcileSummaryChanged(summary: InterfaceReconcileSummary): boolean {
  return (
    summary.added.length > 0 ||
    summary.absent.length > 0 ||
    summary.reactivated.length > 0 ||
    summary.updated.length > 0
  );
}

export async function reconcilePersistedInterfaces(
  db: Database,
  nodeId: string,
  incoming: NodeInterfaceInput[],
): Promise<InterfaceReconcileSummary> {
  const summary = emptyReconcileSummary();
  const existingRows = await db
    .select()
    .from(audioInterfaces)
    .where(eq(audioInterfaces.nodeId, nodeId));
  const existingByKey = new Map(existingRows.map((row) => [interfaceRowKey(row), row]));
  const seenKeys = new Set<string>();
  const now = new Date();

  for (const incomingInterface of incoming) {
    const key = incomingInterfaceKey(incomingInterface);

    seenKeys.add(key);

    const existing = existingByKey.get(key);

    if (!existing) {
      const [inserted] = await db
        .insert(audioInterfaces)
        .values(reconcileInsertValues(nodeId, incomingInterface))
        .returning({ id: audioInterfaces.id });

      await insertChannels(db, inserted.id, channelInputs(incomingInterface));
      summary.added.push(incomingInterface.systemName);
      continue;
    }

    const wasAbsent = existing.absentAt !== null;
    const fieldsChanged = interfaceRowChanged(existing, incomingInterface);

    if (!wasAbsent && !fieldsChanged) {
      summary.unchanged += 1;
      continue;
    }

    await db
      .update(audioInterfaces)
      .set({
        absentAt: null,
        backend: incomingInterface.backend,
        channelCount: incomingInterface.channelCount,
        hardwarePath: incomingInterface.hardwarePath ?? null,
        sampleRates: incomingInterface.sampleRates,
        serialNumber: incomingInterface.serialNumber ?? null,
        systemName: incomingInterface.systemName,
        systemRef: incomingInterface.systemRef ?? incomingInterface.systemName,
        updatedAt: now,
      })
      .where(eq(audioInterfaces.id, existing.id));
    await reconcilePersistedChannels(db, existing.id, incomingInterface);

    if (wasAbsent) {
      summary.reactivated.push(incomingInterface.systemName);
    } else {
      summary.updated.push(incomingInterface.systemName);
    }
  }

  for (const row of existingRows) {
    if (seenKeys.has(interfaceRowKey(row))) {
      continue;
    }

    if (row.absentAt !== null) {
      summary.unchanged += 1;
      continue;
    }

    await db
      .update(audioInterfaces)
      .set({ absentAt: now, updatedAt: now })
      .where(eq(audioInterfaces.id, row.id));
    summary.absent.push(row.systemName);
  }

  return summary;
}

export function reconcileSeedInterfaces(
  interfaces: AudioInterface[],
  incoming: NodeInterfaceInput[],
): { interfaces: AudioInterface[]; summary: InterfaceReconcileSummary } {
  const summary = emptyReconcileSummary();
  const existingByKey = new Map(
    interfaces.map((audioInterface) => [seedKey(audioInterface), audioInterface]),
  );
  const seenKeys = new Set<string>();
  const result: AudioInterface[] = [];

  for (const incomingInterface of incoming) {
    const key = incomingInterfaceKey(incomingInterface);

    seenKeys.add(key);

    const existing = existingByKey.get(key);

    if (!existing) {
      result.push(newSeedInterface(incomingInterface));
      summary.added.push(incomingInterface.systemName);
      continue;
    }

    const wasAbsent = existing.absent === true;
    const fieldsChanged = seedInterfaceChanged(existing, incomingInterface);

    if (!wasAbsent && !fieldsChanged) {
      result.push(existing);
      summary.unchanged += 1;
      continue;
    }

    result.push(mergeSeedInterface(existing, incomingInterface));

    if (wasAbsent) {
      summary.reactivated.push(incomingInterface.systemName);
    } else {
      summary.updated.push(incomingInterface.systemName);
    }
  }

  for (const existing of interfaces) {
    if (seenKeys.has(seedKey(existing))) {
      continue;
    }

    if (existing.absent === true) {
      result.push(existing);
      summary.unchanged += 1;
      continue;
    }

    result.push({ ...existing, absent: true });
    summary.absent.push(existing.systemName);
  }

  return { interfaces: result, summary };
}

async function reconcilePersistedChannels(
  db: Database,
  interfaceId: string,
  incomingInterface: NodeInterfaceInput,
) {
  const existing = await db
    .select()
    .from(audioChannels)
    .where(eq(audioChannels.interfaceId, interfaceId));
  const existingIndexes = new Set(existing.map((channel) => channel.index));
  const aliasByIndex = incomingChannelAliases(incomingInterface);
  const staleIds = existing
    .filter((channel) => channel.index > incomingInterface.channelCount)
    .map((channel) => channel.id);

  if (staleIds.length > 0) {
    await db.delete(audioChannels).where(inArray(audioChannels.id, staleIds));
  }

  const missing = channelIndexes(incomingInterface.channelCount)
    .filter((index) => !existingIndexes.has(index))
    .map((index) => ({
      alias: aliasByIndex.get(index) ?? defaultChannelAlias(index),
      index,
      interfaceId,
    }));

  if (missing.length > 0) {
    await db.insert(audioChannels).values(missing);
  }
}

async function insertChannels(
  db: Database,
  interfaceId: string,
  channels: Array<{ alias: string; index: number }>,
) {
  if (channels.length === 0) {
    return;
  }

  await db
    .insert(audioChannels)
    .values(
      channels.map((channel) => ({ alias: channel.alias, index: channel.index, interfaceId })),
    );
}

function reconcileInsertValues(
  nodeId: string,
  incomingInterface: NodeInterfaceInput,
): typeof audioInterfaces.$inferInsert {
  return {
    alias: incomingInterface.alias,
    backend: incomingInterface.backend,
    channelCount: incomingInterface.channelCount,
    hardwarePath: incomingInterface.hardwarePath ?? null,
    nodeId,
    sampleRates: incomingInterface.sampleRates,
    serialNumber: incomingInterface.serialNumber ?? null,
    systemName: incomingInterface.systemName,
    systemRef: incomingInterface.systemRef ?? incomingInterface.systemName,
  };
}

function newSeedInterface(incomingInterface: NodeInterfaceInput): AudioInterface {
  return {
    alias: incomingInterface.alias,
    backend: incomingInterface.backend,
    channelCount: incomingInterface.channelCount,
    channels: channelInputs(incomingInterface),
    hardwarePath: incomingInterface.hardwarePath,
    id: randomUUID(),
    sampleRates: incomingInterface.sampleRates,
    serialNumber: incomingInterface.serialNumber,
    systemName: incomingInterface.systemName,
    systemRef: incomingInterface.systemRef ?? incomingInterface.systemName,
  };
}

function mergeSeedInterface(
  existing: AudioInterface,
  incomingInterface: NodeInterfaceInput,
): AudioInterface {
  const aliasByIndex = new Map(existing.channels.map((channel) => [channel.index, channel.alias]));
  const incomingAliases = incomingChannelAliases(incomingInterface);

  return {
    ...existing,
    absent: undefined,
    backend: incomingInterface.backend,
    channelCount: incomingInterface.channelCount,
    channels: channelIndexes(incomingInterface.channelCount).map((index) => ({
      alias: aliasByIndex.get(index) ?? incomingAliases.get(index) ?? defaultChannelAlias(index),
      index,
    })),
    hardwarePath: incomingInterface.hardwarePath,
    sampleRates: incomingInterface.sampleRates,
    serialNumber: incomingInterface.serialNumber,
    systemName: incomingInterface.systemName,
    systemRef: incomingInterface.systemRef ?? incomingInterface.systemName,
  };
}

function interfaceRowChanged(
  row: AudioInterfaceRow,
  incomingInterface: NodeInterfaceInput,
): boolean {
  return (
    row.backend !== incomingInterface.backend ||
    row.channelCount !== incomingInterface.channelCount ||
    (row.hardwarePath ?? undefined) !== incomingInterface.hardwarePath ||
    (row.serialNumber ?? undefined) !== incomingInterface.serialNumber ||
    row.systemName !== incomingInterface.systemName ||
    row.systemRef !== (incomingInterface.systemRef ?? incomingInterface.systemName) ||
    !sameNumbers(numberArray(row.sampleRates), incomingInterface.sampleRates)
  );
}

function seedInterfaceChanged(
  existing: AudioInterface,
  incomingInterface: NodeInterfaceInput,
): boolean {
  return (
    existing.backend !== incomingInterface.backend ||
    existing.channelCount !== incomingInterface.channelCount ||
    existing.hardwarePath !== incomingInterface.hardwarePath ||
    existing.serialNumber !== incomingInterface.serialNumber ||
    existing.systemName !== incomingInterface.systemName ||
    (existing.systemRef ?? incomingInterface.systemName) !==
      (incomingInterface.systemRef ?? incomingInterface.systemName) ||
    !sameNumbers(existing.sampleRates, incomingInterface.sampleRates)
  );
}

function channelInputs(incomingInterface: NodeInterfaceInput) {
  if (incomingInterface.channels.length > 0) {
    return incomingInterface.channels.map((channel) => ({
      alias: channel.alias,
      index: channel.index,
    }));
  }

  return channelIndexes(incomingInterface.channelCount).map((index) => ({
    alias: defaultChannelAlias(index),
    index,
  }));
}

function incomingChannelAliases(incomingInterface: NodeInterfaceInput) {
  return new Map(incomingInterface.channels.map((channel) => [channel.index, channel.alias]));
}

function channelIndexes(channelCount: number): number[] {
  return Array.from({ length: Math.max(0, channelCount) }, (_, position) => position + 1);
}

function defaultChannelAlias(index: number): string {
  return `Channel ${index}`;
}

function incomingInterfaceKey(incomingInterface: NodeInterfaceInput): string {
  return matchKey(incomingInterface.systemRef, incomingInterface.systemName);
}

function interfaceRowKey(row: AudioInterfaceRow): string {
  return matchKey(row.systemRef, row.systemName);
}

function seedKey(audioInterface: AudioInterface): string {
  return matchKey(audioInterface.systemRef, audioInterface.systemName);
}

function matchKey(systemRef: string | null | undefined, systemName: string): string {
  const ref = systemRef?.trim();

  return ref && ref.length > 0 ? ref : systemName.trim();
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}
