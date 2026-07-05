import { z } from "zod";

import { isoDateTimeSchema } from "./base.js";

// Recorder-agent version helpers, shared by the controller (which resolves the
// latest published release from GitHub) and the console (which decides whether a
// node's reported version is behind that release). The agent version is the
// calendar `YYYY.MM.DD-N` scheme stamped at build time; unstamped dev/CI builds
// report `0.0.0-dev`. GitHub release tags carry an `agent-v` prefix, so the bare
// calendar version and the release tag differ by that prefix only.

export const AGENT_DEV_VERSION = "0.0.0-dev";
export const AGENT_RELEASE_TAG_PREFIX = "agent-v";

const CALENDAR_VERSION_PATTERN = /^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/;

// A comparable tuple [year, month, day, counter]; `null` for anything that is
// not a calendar version (e.g. `0.0.0-dev`, empty, or malformed input). Callers
// treat unparseable versions as "unknown" — never as an update prompt.
export function parseAgentVersion(value: string | undefined | null): number[] | null {
  if (!value) {
    return null;
  }

  const match = CALENDAR_VERSION_PATTERN.exec(value.trim());

  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

// Orders two calendar versions. Returns a negative number when `a` is older than
// `b`, zero when equal, and a positive number when `a` is newer. Unparseable
// versions sort before any real calendar version so the newest real release
// still wins a `reduce`/`sort` over a mixed list.
export function compareAgentVersions(a: string, b: string): number {
  const left = parseAgentVersion(a);
  const right = parseAgentVersion(b);

  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

// True only when both versions are real calendar versions and `latest` is
// strictly newer than `current`. A dev/unknown current version never prompts an
// update, and a missing/unknown latest never claims one.
export function isAgentUpdateAvailable(
  current: string | undefined | null,
  latest: string | undefined | null,
): boolean {
  if (!parseAgentVersion(current) || !parseAgentVersion(latest)) {
    return false;
  }

  return compareAgentVersions(latest as string, current as string) > 0;
}

// The GitHub release tag for a bare calendar version (`2026.06.28-1` ->
// `agent-v2026.06.28-1`). Idempotent if a tag is passed in.
export function agentReleaseTag(version: string): string {
  const trimmed = version.trim();

  return trimmed.startsWith(AGENT_RELEASE_TAG_PREFIX)
    ? trimmed
    : `${AGENT_RELEASE_TAG_PREFIX}${trimmed}`;
}

// The bare calendar version for a release tag (`agent-v2026.06.28-1` ->
// `2026.06.28-1`). Idempotent if a bare version is passed in.
export function stripAgentReleaseTag(tag: string): string {
  const trimmed = tag.trim();

  return trimmed.startsWith(AGENT_RELEASE_TAG_PREFIX)
    ? trimmed.slice(AGENT_RELEASE_TAG_PREFIX.length)
    : trimmed;
}

// The latest recorder-agent release the controller resolved from GitHub. `tag`
// is the full `agent-v…` tag (used to pin `update_binary`); `version` is the
// bare calendar version (compared against a node's reported `agentVersion`).
export const agentReleaseSchema = z.object({
  publishedAt: isoDateTimeSchema.optional(),
  tag: z.string().min(1),
  url: z.string().url().optional(),
  version: z.string().min(1),
});

export type AgentRelease = z.infer<typeof agentReleaseSchema>;

// The response body for the latest-release endpoint. `data` is `null` until the
// controller has resolved a release (cold cache / GitHub unreachable), so the
// console can render the nodes table first and hydrate the badge later.
export const agentReleaseResponseSchema = z.object({
  checkedAt: isoDateTimeSchema.optional(),
  data: agentReleaseSchema.nullable(),
});

export type AgentReleaseResponse = z.infer<typeof agentReleaseResponseSchema>;
