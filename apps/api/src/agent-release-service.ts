import {
  agentReleaseTag,
  compareAgentVersions,
  parseAgentVersion,
  stripAgentReleaseTag,
  type AgentRelease,
} from "@rakkr/shared";

// Resolves the latest published recorder-agent release from GitHub and caches it
// with stale-while-revalidate semantics: a snapshot never blocks on the network,
// it returns whatever was last resolved (possibly `null` on a cold cache) and
// kicks a background refresh when the cache is stale. This keeps the nodes list
// fast — the console renders the table immediately and the "update available"
// badge hydrates once the release resolves.
//
// GitHub tags are component-prefixed and share one repo, so `/releases/latest`
// can point at a docs or controller release. We list releases and pick the
// newest `agent-v…` tag ourselves, making the controller the source of truth for
// "latest agent version" and letting `update_binary` pin the exact tag.

export interface AgentReleaseSnapshot {
  checkedAt?: string;
  data: AgentRelease | null;
}

export interface AgentReleaseService {
  // Non-blocking: returns the cached snapshot and schedules a refresh if stale.
  snapshot(): AgentReleaseSnapshot;
  // Awaitable refresh; used to warm the cache at startup. Never rejects.
  warm(): Promise<void>;
}

interface GithubRelease {
  draft?: boolean;
  html_url?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
}

interface AgentReleaseServiceOptions {
  apiUrl?: string;
  errorTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  repo?: string;
  timeoutMs?: number;
  token?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ERROR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
// The newest agent release is normally on page 1 (GitHub lists newest-first), but
// a burst of docs/controller tags could push it back. Follow `Link: rel=next` a
// bounded number of pages so we still find it without unbounded paging (R N-3A).
const MAX_RELEASE_PAGES = 5;
// Never buffer an unbounded response body into memory. 100 releases/page of
// GitHub release JSON is well under this; a body larger than this from a
// misconfigured/hostile API URL is rejected rather than read (R N-3B).
const MAX_RELEASE_BODY_BYTES = 8 * 1024 * 1024;

export function createAgentReleaseService(
  options: AgentReleaseServiceOptions = {},
): AgentReleaseService {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const repo = options.repo ?? "yashau/Rakkr";
  const token = options.token;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const errorTtlMs = Math.min(options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS, ttlMs);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  let release: AgentRelease | null = null;
  let checkedAt: string | undefined;
  let nextRefreshAtMs = 0;
  let inFlight: Promise<void> | null = null;

  async function doFetch(): Promise<void> {
    try {
      const firstUrl = `${apiUrl}/repos/${repo}/releases?per_page=100`;
      const origin = new URL(firstUrl).origin;
      const entries: unknown[] = [];
      let url: string | null = firstUrl;

      for (let page = 0; page < MAX_RELEASE_PAGES && url; page += 1) {
        const response = await fetchImpl(url, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "rakkr-controller",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`github_releases_${response.status}`);
        }

        const parsed = JSON.parse(
          await readBoundedText(response, MAX_RELEASE_BODY_BYTES),
        ) as unknown;

        if (Array.isArray(parsed)) {
          entries.push(...parsed);
        }

        // Only follow a next link that stays on the same origin — don't chase a
        // header pointing at an unrelated host.
        const next = parseNextLink(response.headers.get("link"));

        url = next && new URL(next).origin === origin ? next : null;
      }

      const resolved = resolveLatestAgentRelease(entries);

      if (resolved) {
        release = resolved;
      }

      checkedAt = now().toISOString();
      nextRefreshAtMs = now().getTime() + ttlMs;
    } catch (error) {
      // Keep the last good value; back off before retrying so a persistent
      // failure does not hammer GitHub on every request.
      nextRefreshAtMs = now().getTime() + errorTtlMs;
      console.warn("recorder-agent release check failed", error);
    }
  }

  function refresh(): Promise<void> {
    if (!inFlight) {
      inFlight = doFetch().finally(() => {
        inFlight = null;
      });
    }

    return inFlight;
  }

  return {
    snapshot() {
      if (now().getTime() >= nextRefreshAtMs) {
        void refresh();
      }

      return { checkedAt, data: release };
    },
    warm() {
      return refresh();
    },
  };
}

// Picks the newest `agent-v…` release from a GitHub releases list, ignoring
// drafts, pre-releases, and other components' tags.
export function resolveLatestAgentRelease(body: unknown): AgentRelease | null {
  if (!Array.isArray(body)) {
    return null;
  }

  let latest: AgentRelease | null = null;

  for (const entry of body as GithubRelease[]) {
    if (!entry || typeof entry.tag_name !== "string" || entry.draft || entry.prerelease) {
      continue;
    }

    const version = stripAgentReleaseTag(entry.tag_name);

    if (!parseAgentVersion(version)) {
      continue;
    }

    if (!latest || compareAgentVersions(version, latest.version) > 0) {
      latest = {
        publishedAt: entry.published_at || undefined,
        tag: agentReleaseTag(entry.tag_name),
        url: entry.html_url || undefined,
        version,
      };
    }
  }

  return latest;
}

// Extracts the `rel="next"` URL from a GitHub `Link` header, or null when there
// is no next page. GitHub emits `<url>; rel="next", <url>; rel="last"`.
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);

    if (match) {
      return match[1];
    }
  }

  return null;
}

// Reads a response body as text but refuses to buffer more than `maxBytes`,
// checking the declared Content-Length first and then enforcing the cap while
// streaming (chunked responses omit Content-Length).
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("github_releases_body_too_large");
  }

  const body = response.body;

  if (!body) {
    const text = await response.text();

    if (byteLength(text) > maxBytes) {
      throw new Error("github_releases_body_too_large");
    }

    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    received += value.byteLength;

    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("github_releases_body_too_large");
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

let defaultService: AgentReleaseService | undefined;

export function agentReleaseService(): AgentReleaseService {
  if (!defaultService) {
    defaultService = createAgentReleaseService({
      apiUrl: process.env.RAKKR_GITHUB_API_URL,
      repo: process.env.RAKKR_AGENT_RELEASE_REPO,
      token: process.env.RAKKR_GITHUB_TOKEN,
      ttlMs: positiveIntEnv(process.env.RAKKR_AGENT_RELEASE_TTL_MS),
      timeoutMs: positiveIntEnv(process.env.RAKKR_AGENT_RELEASE_TIMEOUT_MS),
    });
  }

  return defaultService;
}

function positiveIntEnv(value: string | undefined): number | undefined {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
