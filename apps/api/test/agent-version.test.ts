import assert from "node:assert/strict";
import test from "node:test";

import {
  agentReleaseTag,
  compareAgentVersions,
  isAgentUpdateAvailable,
  parseAgentVersion,
  stripAgentReleaseTag,
} from "@rakkr/shared";

test("parseAgentVersion accepts calendar versions and rejects everything else", () => {
  assert.deepEqual(parseAgentVersion("2026.06.28-1"), [2026, 6, 28, 1]);
  assert.deepEqual(parseAgentVersion(" 2026.06.28-10 "), [2026, 6, 28, 10]);
  assert.equal(parseAgentVersion("0.0.0-dev"), null);
  assert.equal(parseAgentVersion("agent-v2026.06.28-1"), null);
  assert.equal(parseAgentVersion(""), null);
  assert.equal(parseAgentVersion(undefined), null);
});

test("compareAgentVersions orders by date then counter", () => {
  assert.ok(compareAgentVersions("2026.06.28-1", "2026.06.28-2") < 0);
  // Multi-digit counter must beat single digit (string compare would fail here).
  assert.ok(compareAgentVersions("2026.06.28-10", "2026.06.28-2") > 0);
  assert.ok(compareAgentVersions("2026.07.01-1", "2026.06.28-9") > 0);
  assert.equal(compareAgentVersions("2026.06.28-1", "2026.06.28-1"), 0);
  // Unparseable sorts below any real calendar version.
  assert.ok(compareAgentVersions("0.0.0-dev", "2026.06.28-1") < 0);
});

test("isAgentUpdateAvailable only fires for a strictly newer real version", () => {
  assert.equal(isAgentUpdateAvailable("2026.06.28-1", "2026.06.28-2"), true);
  assert.equal(isAgentUpdateAvailable("2026.06.28-2", "2026.06.28-1"), false);
  assert.equal(isAgentUpdateAvailable("2026.06.28-1", "2026.06.28-1"), false);
  // Dev / unknown current never prompts, and unknown latest never claims.
  assert.equal(isAgentUpdateAvailable("0.0.0-dev", "2026.06.28-1"), false);
  assert.equal(isAgentUpdateAvailable("2026.06.28-1", undefined), false);
});

test("release tag helpers round-trip and are idempotent", () => {
  assert.equal(agentReleaseTag("2026.06.28-1"), "agent-v2026.06.28-1");
  assert.equal(agentReleaseTag("agent-v2026.06.28-1"), "agent-v2026.06.28-1");
  assert.equal(stripAgentReleaseTag("agent-v2026.06.28-1"), "2026.06.28-1");
  assert.equal(stripAgentReleaseTag("2026.06.28-1"), "2026.06.28-1");
});
