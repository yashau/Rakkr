import assert from "node:assert/strict";
import test from "node:test";

const { createAgentReleaseService, parseNextLink, resolveLatestAgentRelease } =
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

test("parseNextLink extracts the rel=next URL and ignores others", () => {
  const header =
    '<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel="next", ' +
    '<https://api.github.com/repositories/1/releases?per_page=100&page=9>; rel="last"';

  assert.equal(
    parseNextLink(header),
    "https://api.github.com/repositories/1/releases?per_page=100&page=2",
  );
  // A header with only prev/last (no next) yields null.
  assert.equal(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(parseNextLink(null), null);
});

test("doFetch sends the documented GitHub request contract", async () => {
  const requests: Array<{ headers: Headers; url: string }> = [];
  const service = createAgentReleaseService({
    fetchImpl: async (input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        url: typeof input === "string" ? input : String(input),
      });
      return new Response(JSON.stringify(releasesPage(["agent-v2026.06.28-1"])), { status: 200 });
    },
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    repo: "acme/widgets",
    token: "ghp_secret",
  });

  await service.warm();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/repos/acme/widgets/releases?per_page=100");
  assert.equal(requests[0].headers.get("accept"), "application/vnd.github+json");
  assert.equal(requests[0].headers.get("user-agent"), "rakkr-controller");
  assert.equal(requests[0].headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(requests[0].headers.get("authorization"), "Bearer ghp_secret");
});

test("doFetch follows Link rel=next to find a newer release on a later page", async () => {
  const urls: string[] = [];
  const page2 = "https://api.github.com/repos/yashau/Rakkr/releases?per_page=100&page=2";
  const service = createAgentReleaseService({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : String(input);
      urls.push(url);

      if (url.includes("page=2")) {
        // Newest agent release lives on page 2 (page 1 was all docs tags).
        return new Response(JSON.stringify(releasesPage(["agent-v2026.07.04-1"])), { status: 200 });
      }

      return new Response(JSON.stringify(releasesPage(["docs-v2026.07.03-1"])), {
        headers: { Link: `<${page2}>; rel="next"` },
        status: 200,
      });
    },
    now: () => new Date("2026-07-05T00:00:00.000Z"),
  });

  await service.warm();

  assert.equal(urls.length, 2);
  assert.equal(urls[1], page2);
  assert.equal(service.snapshot().data?.version, "2026.07.04-1");
});

test("doFetch stops paging at the page cap", async () => {
  let fetchCalls = 0;
  const service = createAgentReleaseService({
    fetchImpl: async (input) => {
      fetchCalls += 1;
      const url = typeof input === "string" ? input : String(input);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      // Every page advertises a next link, so only the cap stops the loop.
      return new Response(JSON.stringify(releasesPage(["docs-v2026.07.03-1"])), {
        headers: {
          Link: `<https://api.github.com/repos/yashau/Rakkr/releases?per_page=100&page=${page + 1}>; rel="next"`,
        },
        status: 200,
      });
    },
    now: () => new Date("2026-07-05T00:00:00.000Z"),
  });

  await service.warm();

  assert.equal(fetchCalls, 5);
});

test("doFetch rejects an over-cap body and keeps the last good value", async () => {
  let fail = false;
  let clock = new Date("2026-07-05T00:00:00.000Z").getTime();
  const service = createAgentReleaseService({
    fetchImpl: async () => {
      if (fail) {
        return new Response(JSON.stringify(releasesPage(["agent-v2026.07.04-1"])), {
          headers: { "Content-Length": String(64 * 1024 * 1024) },
          status: 200,
        });
      }
      return new Response(JSON.stringify(releasesPage(["agent-v2026.06.28-1"])), { status: 200 });
    },
    now: () => new Date(clock),
    ttlMs: 1000,
  });

  await service.warm();
  assert.equal(service.snapshot().data?.version, "2026.06.28-1");

  clock += 2000;
  fail = true;
  await service.warm();
  // The oversized body is rejected; the previous good value is retained.
  assert.equal(service.snapshot().data?.version, "2026.06.28-1");
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
