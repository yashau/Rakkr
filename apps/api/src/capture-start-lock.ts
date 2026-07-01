// Per-node serial lock for the capture-START critical section (conflict/capacity
// check -> create recording + job). The check reads a jobs/recordings snapshot
// and only creates afterward, with awaits in between; without serialization two
// concurrent starts on the same node both read the pre-create snapshot, both
// pass the channel-conflict + maxConcurrentRecordings guard, and both create a
// job — exceeding capacity and double-capturing the same channels (the "begin"
// counterpart to the claim-time CAS, G5). Serializing per node closes that
// TOCTOU so the second start re-reads the snapshot after the first's create and
// is correctly rejected. Single-process model (Helm replicaCount 1); a
// multi-replica deployment would need a DB-level reservation instead.
const tails = new Map<string, Promise<unknown>>();

export function withCaptureStartLock<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(nodeId) ?? Promise.resolve();
  // Run after the previous holder settles (success OR failure), so one failed
  // start never wedges the node's queue.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );

  tails.set(nodeId, tail);
  // Drop the map entry once the queue drains, so it doesn't grow unbounded.
  void tail.then(() => {
    if (tails.get(nodeId) === tail) {
      tails.delete(nodeId);
    }
  });

  return run;
}
