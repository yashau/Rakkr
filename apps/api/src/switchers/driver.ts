import type { SwitcherConnectionTest, SwitcherModel, SwitcherModelInfo } from "@rakkr/shared";

import { avproAcMaxDriver } from "./avpro-ac-max.js";
import type { SwitcherSession } from "./transport.js";

// output number -> input number (0 = no source / disconnected).
export type RouteMap = Map<number, number>;
// input number -> SIG STA level (0 = silent .. 3 = both channels present).
export type InputSignalMap = Map<number, number>;

// A model-specific driver: it knows the device's command grammar and response
// parsing but not how to connect (that is the transport's job). Every method
// takes an already-open session so a single connection can batch a full
// reconcile pass (read routes, apply diffs, confirm).
export interface SwitcherDriver {
  readonly info: SwitcherModelInfo;
  readInputSignals(session: SwitcherSession): Promise<InputSignalMap>;
  readRoutes(session: SwitcherSession): Promise<RouteMap>;
  // Replay a snapshot to restore prior state. Implementations must skip
  // device-network commands so a restore can never strand the controller.
  restore(session: SwitcherSession, snapshot: string): Promise<void>;
  // Set an output's source input and confirm it took effect; returns the
  // read-back input. Throws on device error or mismatch.
  setRoute(session: SwitcherSession, output: number, input: number): Promise<number>;
  // Capture a full, restorable device configuration dump.
  snapshot(session: SwitcherSession): Promise<string>;
  test(session: SwitcherSession): Promise<SwitcherConnectionTest>;
}

const drivers: Record<SwitcherModel, SwitcherDriver> = {
  "avpro-ac-max": avproAcMaxDriver,
};

export function getSwitcherDriver(model: SwitcherModel): SwitcherDriver {
  return drivers[model];
}
