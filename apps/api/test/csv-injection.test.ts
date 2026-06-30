import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingSummary, ScheduleSummary } from "@rakkr/shared";
import { neutralizeCsvFormula } from "../src/csv.js";
import { recordingManifestCsv } from "../src/recording-listing.js";
import { schedulesCsv } from "../src/schedule-export.js";

test("neutralizeCsvFormula prefixes formula triggers and leaves safe values intact", () => {
  for (const payload of ["=1+1", "+1", "-1", "@SUM(1)", "\tcmd", "\rcmd"]) {
    assert.equal(
      neutralizeCsvFormula(payload),
      `'${payload}`,
      `expected ${JSON.stringify(payload)} to be neutralised`,
    );
  }

  for (const safe of ["Council Meeting", "Room 12", "a=b", "2026-06-18", ""]) {
    assert.equal(neutralizeCsvFormula(safe), safe);
  }
});

test("recordingManifestCsv neutralises a formula-injection recording name (conditional-quote path)", () => {
  const csv = recordingManifestCsv([
    recording({ name: '=HYPERLINK("http://evil")', tags: ["@cmd"] }),
  ]);

  // The malicious cells are written as text, not as bare formulas.
  assert.match(csv, /'=HYPERLINK/u);
  assert.match(csv, /'@cmd/u);
  // No data cell begins with a raw formula trigger.
  for (const line of csv.split("\n").slice(1)) {
    for (const cell of line.split(",")) {
      const unquoted = cell.replace(/^"|"$/gu, "");
      assert.doesNotMatch(unquoted, /^[=+\-@\t\r]/u, `cell starts with a formula trigger: ${cell}`);
    }
  }
});

test("schedulesCsv neutralises a formula even on the always-quoted path", () => {
  // Quoting alone does NOT protect: Excel evaluates `=cmd` inside a quoted
  // field once the CSV quotes are stripped on import.
  const csv = schedulesCsv([schedule({ name: "=cmd|'/C calc'!A0", room: "@evil" })]);

  assert.match(csv, /"'=cmd/u);
  assert.match(csv, /"'@evil"/u);
});

function recording(overrides: Partial<RecordingSummary>): RecordingSummary {
  return {
    cachePath: "scheduled/rec_csv.mp3",
    cached: true,
    checksum: "sha256:rec_csv",
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id: "rec_csv",
    name: "Council Meeting",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: [],
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleSummary>): ScheduleSummary {
  return {
    enabled: true,
    id: "sch_csv",
    name: "Weekly Council",
    nodeId: "node_csv",
    room: "Room 12",
    tags: [],
    timezone: "UTC",
    uploadPolicyIds: [],
    ...overrides,
  } as unknown as ScheduleSummary;
}
