import assert from "node:assert/strict";
import test from "node:test";
import { createListenSessionStore, type ListenSessionInput } from "../src/listen-session-store.js";

process.env.RAKKR_LISTEN_SESSION_TTL_SECONDS = "60";

function sessionInput(nodeId: string, sessionId: string, enhance = false): ListenSessionInput {
  return {
    enhance,
    mode: "agent_audio_chunk",
    nodeId,
    sessionId,
    startedAt: "2026-06-18T12:00:00.000Z",
    stopUrl: `/api/v1/nodes/${nodeId}/listen/${sessionId}`,
    streamUrl: `/api/v1/nodes/${nodeId}/listen/${sessionId}/stream`,
    targetLatencyMs: 500,
  };
}

test("an abandoned live-listen session is evicted after the TTL", async () => {
  let clockMs = Date.parse("2026-06-18T12:00:00.000Z");
  const store = createListenSessionStore(() => clockMs);

  await store.start(sessionInput("node_a", "sess_abandoned"));

  // The browser stops polling; advance past the 60s TTL.
  clockMs += 61_000;

  // Pre-fix the record lingered for the process lifetime and was still found.
  // Now any access sweeps it, so the abandoned session is gone.
  assert.equal(await store.find("node_a", "sess_abandoned"), undefined);
});

test("a continuously-polled session is kept live and not evicted", async () => {
  let clockMs = Date.parse("2026-06-18T12:00:00.000Z");
  const store = createListenSessionStore(() => clockMs);

  await store.start(sessionInput("node_b", "sess_live"));

  // Poll every 30s (< TTL); each find() touches lastSeenAt, keeping it alive
  // well past the 60s TTL.
  for (let poll = 0; poll < 5; poll += 1) {
    clockMs += 30_000;
    assert.ok(await store.find("node_b", "sess_live"), `poll ${poll} should keep it live`);
  }
});
