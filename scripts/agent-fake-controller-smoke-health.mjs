// Fake-controller health/recovery scenarios. The scenario functions live in two
// cohesive sibling modules (system/node lifecycle vs. meter/monitor data plane);
// this module re-exports them so the smoke entry point keeps one import surface.
export * from "./agent-fake-controller-smoke-health-system.mjs";
export * from "./agent-fake-controller-smoke-health-meters.mjs";
