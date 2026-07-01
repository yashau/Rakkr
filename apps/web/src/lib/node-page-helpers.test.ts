import assert from "node:assert/strict";
import test from "node:test";
import type { Permission } from "@rakkr/shared";

import {
  defaultNodeHealthSuppressedUntil,
  listenMonitorModeLabel,
  listenMonitorPollInterval,
  liveListenRendition,
  liveListenRenditionLabel,
  liveListenRenditions,
  nodeFilterChips,
  nodeHealthLifecycleActions,
  nodeHealthLifecycleInput,
  nodeLocationSummary,
  nodePageActionPermissions,
  nodePickerFilters,
  nodeRuntimeSummary,
  nodeSelectionState,
  nextNodeSelection,
  rotateNodeTokenTitle,
} from "./node-page-helpers";
import { formatDateTime } from "./dates";

test("G76: node pickers request the full inventory, not the default page", () => {
  // The API's default node page is 50; pickers/labels that omit `limit` drop
  // every node past the first page. The picker filters must request more than
  // one default page so the whole scoped inventory reaches the dropdowns.
  const filters = nodePickerFilters();

  assert.ok(filters.limit > 50, "picker must fetch beyond the default 50-row page");
  assert.equal(filters.limit, 200, "requests the API's max page size (PAGE_POLICY.default)");
});

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

test("node selection state tracks visible selected inventory", () => {
  assert.deepEqual(
    nodeSelectionState([{ id: "node_a" }, { id: "node_b" }], ["node_b", "node_hidden"]),
    {
      allVisibleSelected: false,
      selectedVisibleNodeIds: ["node_b"],
      visibleNodeIds: ["node_a", "node_b"],
    },
  );
  assert.deepEqual(nodeSelectionState([{ id: "node_a" }], ["node_a"]), {
    allVisibleSelected: true,
    selectedVisibleNodeIds: ["node_a"],
    visibleNodeIds: ["node_a"],
  });
});

test("node selection toggle adds and removes ids without duplicates", () => {
  assert.deepEqual(nextNodeSelection(["node_a"], "node_b", true), ["node_a", "node_b"]);
  assert.deepEqual(nextNodeSelection(["node_a"], "node_a", true), ["node_a"]);
  assert.deepEqual(nextNodeSelection(["node_a", "node_b"], "node_a", false), ["node_b"]);
});

test("node location and runtime summaries stay compact", () => {
  assert.equal(
    nodeLocationSummary({ building: "Hall", floor: "2", room: "Chamber", site: "Main" }),
    "Main / Hall / 2 / Chamber",
  );
  assert.equal(
    nodeRuntimeSummary({
      architecture: "x64",
      audioBackends: ["alsa", "jack"],
      kernelRelease: "6.8.0",
      osName: "Debian",
      uptimeSeconds: 90_000,
    }),
    "Debian / kernel 6.8.0 / x64 / alsa, jack / uptime 1d 1h",
  );
});

test("node filter chips expose active filters in operator order", () => {
  assert.deepEqual(
    nodeFilterChips({
      backend: "alsa",
      building: "Hall",
      lastSeenFrom: "2026-06-20T00:00:00.000Z",
      q: "council",
      room: "Chamber",
      status: "online",
    }),
    [
      { key: "q", label: "search", value: "council" },
      { key: "status", label: "status", value: "online" },
      { key: "backend", label: "backend", value: "alsa" },
      { key: "building", label: "building", value: "Hall" },
      { key: "room", label: "room", value: "Chamber" },
      {
        key: "lastSeenFrom",
        label: "last seen from",
        value: formatDateTime("2026-06-20T00:00:00.000Z"),
      },
    ],
  );
});

test("listen monitor helpers expose source labels and bounded refresh intervals", () => {
  assert.equal(listenMonitorModeLabel("agent_audio_chunk"), "Agent audio");
  assert.equal(listenMonitorModeLabel("controller_meter_preview"), "Meter preview");
  assert.equal(listenMonitorPollInterval(200), 750);
  assert.equal(listenMonitorPollInterval(1250), 1250);
  assert.equal(listenMonitorPollInterval(10_000), 3000);
  assert.equal(listenMonitorPollInterval(Number.NaN), 1500);
});

test("live listen rendition helpers map the session enhance flag to a labeled toggle", () => {
  assert.deepEqual(liveListenRenditions, ["raw", "enhanced"]);
  assert.equal(liveListenRendition(false), "raw");
  assert.equal(liveListenRendition(true), "enhanced");
  assert.equal(liveListenRenditionLabel("raw"), "Raw");
  assert.equal(liveListenRenditionLabel("enhanced"), "Enhanced");
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
