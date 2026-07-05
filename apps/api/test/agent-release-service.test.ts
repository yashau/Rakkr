import assert from "node:assert/strict";
import test from "node:test";

const { createAgentReleaseService, resolveLatestAgentRelease } =
  await import("../src/agent-release-service.js");

const releasesPage = (tags: string[]) =>
  tags.map((tag) => ({
    html_url: `https://github.com/yashau/Rakkr/releases/tag/${tag}`,
    published_at: "2026-06-28T00:00:00.000Z",
    tag_name: tag,
  }));

test("resolveLatestAgentRelease picks the newest agent-v tag and ignores others", () => {
  const latest = resolveLatestAgentRelease([
    { tag_name: "docs-v2026.07.01-1" },
    { tag_name: "controller-v2026.07.02-1" },
    { tag_name: "agent-v2026.06.28-2" },
    { tag_name: "agent-v2026.06.28-10" },
    { draft: true, tag_name: "agent-v2026.07.05-1" },
    { prerelease: true, tag_name: "agent-v2026.07.04-1" },
  ]);

  assert.equal(latest?.version, "2026.06.28-10");
  assert.equal(latest?.tag, "agent-v2026.06.28-10");
});

test("resolveLatestAgentRelease returns null when no agent release is present", () => {
  assert.equal(resolveLatestAgentRelease([{ tag_name: "docs-v2026.07.01-1" }]), null);
  assert.equal(resolveLatestAgentRelease("not-an-array"), null);
});

test("snapshot is non-blocking: null until warmed, then hydrated", async () => {
  let fetchCalls = 0;
  const service = createAgentReleaseService({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(releasesPage(["agent-v2026.06.28-1"])), { status: 200 });
    },
    now: () => new Date("2026-07-05T00:00:00.000Z"),
  });

  // Cold cache returns null immediately (and schedules a background refresh).
  assert.equal(service.snapshot().data, null);

  await service.warm();

  const snap = service.snapshot();
  assert.equal(snap.data?.version, "2026.06.28-1");
  assert.equal(snap.checkedAt, "2026-07-05T00:00:00.000Z");
  assert.ok(fetchCalls >= 1);
});

test("stale-while-revalidate serves the old value then refreshes", async () => {
  let clock = new Date("2026-07-05T00:00:00.000Z").getTime();
  let fetchCalls = 0;
  let tags = ["agent-v2026.06.28-1"];
  const service = createAgentReleaseService({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(releasesPage(tags)), { status: 200 });
    },
    now: () => new Date(clock),
    ttlMs: 1000,
  });

  await service.warm();
  assert.equal(service.snapshot().data?.version, "2026.06.28-1");
  assert.equal(fetchCalls, 1);

  // Within the TTL a snapshot must not trigger another fetch.
  clock += 500;
  assert.equal(service.snapshot().data?.version, "2026.06.28-1");
  assert.equal(fetchCalls, 1);

  // Past the TTL a newer release is published. The stale snapshot still returns
  // the old value immediately but schedules a refresh.
  clock += 1000;
  tags = ["agent-v2026.06.28-1", "agent-v2026.07.04-1"];
  assert.equal(service.snapshot().data?.version, "2026.06.28-1");

  await service.warm();
  assert.equal(service.snapshot().data?.version, "2026.07.04-1");
  assert.equal(fetchCalls, 2);
});

test("a failed refresh keeps the last good value and backs off", async () => {
  let clock = new Date("2026-07-05T00:00:00.000Z").getTime();
  let fetchCalls = 0;
  let fail = false;
  const service = createAgentReleaseService({
    errorTtlMs: 1000,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fail) {
        throw new Error("network down");
      }
      return new Response(JSON.stringify(releasesPage(["agent-v2026.06.28-1"])), { status: 200 });
    },
    now: () => new Date(clock),
    ttlMs: 1000,
  });

  await service.warm();
  assert.equal(service.snapshot().data?.version, "2026.06.28-1");

  // Force a failing refresh past the TTL.
  clock += 2000;
  fail = true;
  await service.warm();
  const afterFailure = service.snapshot();
  assert.equal(afterFailure.data?.version, "2026.06.28-1", "last good value is retained");
  assert.equal(fetchCalls, 2);

  // Inside the error backoff window no further fetch is scheduled.
  clock += 500;
  service.snapshot();
  assert.equal(fetchCalls, 2);
});
