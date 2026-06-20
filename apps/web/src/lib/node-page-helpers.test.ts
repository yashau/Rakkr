import assert from "node:assert/strict";
import test from "node:test";
import type { Permission } from "@rakkr/shared";

import {
  defaultNodeHealthSuppressedUntil,
  listenMonitorModeLabel,
  listenMonitorPollInterval,
  nodeHealthLifecycleActions,
  nodeHealthLifecycleInput,
  nodePageActionPermissions,
  rotateNodeTokenTitle,
} from "./node-page-helpers";

test("node page action permissions split listen and management actions", () => {
  assert.deepEqual(nodePageActionPermissions(["node:read"]), {
    canAcknowledgeHealth: false,
    canRead: true,
    canReadHealth: false,
    canListen: false,
    canManage: false,
  });
  assert.deepEqual(
    nodePageActionPermissions(["health:acknowledge", "health:read", "node:read", "listen:monitor"]),
    {
      canAcknowledgeHealth: true,
      canRead: true,
      canReadHealth: true,
      canListen: true,
      canManage: false,
    },
  );
  assert.deepEqual(nodePageActionPermissions(["node:manage"] satisfies Permission[]), {
    canAcknowledgeHealth: false,
    canRead: false,
    canReadHealth: false,
    canListen: false,
    canManage: true,
  });
});

test("node token rotation titles explain permission and persistence state", () => {
  assert.equal(rotateNodeTokenTitle(false, true), "Requires node manage");
  assert.equal(rotateNodeTokenTitle(true, false), "Demo node tokens are not persisted");
  assert.equal(rotateNodeTokenTitle(true, true), "Rotate node token");
});

test("listen monitor helpers expose source labels and bounded refresh intervals", () => {
  assert.equal(listenMonitorModeLabel("agent_audio_chunk"), "Agent audio");
  assert.equal(listenMonitorModeLabel("controller_meter_preview"), "Meter preview");
  assert.equal(listenMonitorPollInterval(200), 750);
  assert.equal(listenMonitorPollInterval(1250), 1250);
  assert.equal(listenMonitorPollInterval(10_000), 3000);
  assert.equal(listenMonitorPollInterval(Number.NaN), 1500);
});

test("node health lifecycle actions match event status", () => {
  assert.deepEqual(nodeHealthLifecycleActions("open"), ["acknowledge", "suppress", "resolve"]);
  assert.deepEqual(nodeHealthLifecycleActions("acknowledged"), ["suppress", "resolve"]);
  assert.deepEqual(nodeHealthLifecycleActions("suppressed"), ["resolve"]);
  assert.deepEqual(nodeHealthLifecycleActions("resolved"), ["reopen"]);
});

test("default node health suppression uses a one hour UTC ISO window", () => {
  assert.equal(
    defaultNodeHealthSuppressedUntil(new Date("2026-06-20T12:15:30.000Z")),
    "2026-06-20T13:15:30.000Z",
  );
});

test("node health lifecycle input only adds suppression window for mute action", () => {
  assert.deepEqual(nodeHealthLifecycleInput("health_1", "resolve"), {
    action: "resolve",
    eventId: "health_1",
    suppressedUntil: undefined,
  });
  assert.match(nodeHealthLifecycleInput("health_1", "suppress").suppressedUntil ?? "", /^\d{4}/u);
});
