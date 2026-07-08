import assert from "node:assert/strict";
import test from "node:test";
import type { NodeStatus } from "@rakkr/shared";

import { nodeStatusBadgeClass, nodeStatusLabel } from "./node-status";
import { toneBadgeClass, toneFillClass } from "./status-colors";

// Pin the tone for every node status so a new/renamed enum member (or a silent
// change to the offline tone) breaks this test rather than shipping the wrong
// colour. Offline reads critical (red) per the operator decision (audit R3-1).
const expectedTone: Record<NodeStatus, Parameters<typeof toneBadgeClass>[0]> = {
  alerting: "critical",
  degraded: "warning",
  offline: "critical",
  online: "healthy",
  provisioning: "info",
  recording: "info",
};

test("nodeStatusBadgeClass maps every node status to its pinned tone", () => {
  for (const [status, tone] of Object.entries(expectedTone) as Array<
    [NodeStatus, Parameters<typeof toneBadgeClass>[0]]
  >) {
    assert.equal(nodeStatusBadgeClass(status), toneBadgeClass(tone), status);
  }
});

test("nodeStatusBadgeClass offline reads as critical, not neutral", () => {
  assert.equal(nodeStatusBadgeClass("offline"), toneBadgeClass("critical"));
  assert.notEqual(nodeStatusBadgeClass("offline"), toneBadgeClass("neutral"));
});

test("an unknown/undefined status falls back to neutral", () => {
  assert.equal(nodeStatusBadgeClass(undefined), toneBadgeClass("neutral"));
});

test("nodeStatusLabel surfaces a Title Case label, never the raw lowercase token", () => {
  const labels: Record<NodeStatus, string> = {
    alerting: "Alerting",
    degraded: "Degraded",
    offline: "Offline",
    online: "Online",
    provisioning: "Provisioning",
    recording: "Recording",
  };

  for (const [status, label] of Object.entries(labels) as Array<[NodeStatus, string]>) {
    assert.equal(nodeStatusLabel(status), label, status);
    // The label must not be the raw machine token (audit H2-STATUS-RAW).
    assert.notEqual(nodeStatusLabel(status), status);
  }

  assert.equal(nodeStatusLabel(undefined), "Unknown");
});

test("toneFillClass gives neutral its own muted fill, not the sky info fill", () => {
  assert.notEqual(toneFillClass("neutral"), toneFillClass("info"));
  assert.match(toneFillClass("neutral"), /bg-muted/);
  assert.match(toneFillClass("info"), /bg-sky/);
});
