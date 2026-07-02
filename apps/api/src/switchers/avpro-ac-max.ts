import { switcherModelInfo, type SwitcherConnectionTest } from "@rakkr/shared";

import type { InputSignalMap, RouteMap, SwitcherDriver } from "./driver.js";
import type { SwitcherSession } from "./transport.js";

// Driver for the AVPro Edge AC-MAX audio matrix (verified against a live
// AC-MAX-24, firmware 1.31). Control is a raw-TCP line protocol on port 23 with
// no authentication on the channel. Command grammar used here:
//   route:          SET OUTx AS INy      (x=output 1..24, y=input 0..24; 0=none)
//   read one route: GET OUTx AS          -> "OUTx AS INy"
//   read all:       GET OUT0 AS          -> one "OUTx AS INy" line per output
//   input signal:   GET IN0 SIG STA      -> "INx SIG STA n"  (n=0..3)
//   full backup:    GET CONFIG           -> restorable "SET ..." dump
//   status:         STA                  -> block incl. "F/W Version : 1.31"
// Errors are returned inline as lines prefixed "CMD ERR: ...".

const ROUTE_LINE = /^OUT(\d+)\s+AS\s+IN(\d+)$/i;
const SIGNAL_LINE = /^IN(\d+)\s+SIG\s+STA\s+(\d+)$/i;
const FIRMWARE_LINE = /F\/W\s+Version\s*:\s*([\w.-]+)/i;
const ERROR_LINE = /^CMD\s+ERR/i;
// Restore replays a GET CONFIG dump. Skip commands that would change the
// device's network identity/addressing so a restore can never strand it.
const UNSAFE_RESTORE = /^SET\s+(RIP|HIP|NMK|MAC|TIP|DHCP|ADDR|BAUDR)\b/i;

export function formatSetRoute(output: number, input: number): string {
  return `SET OUT${output} AS IN${input}`;
}

export function parseRouteLine(line: string): { input: number; output: number } | null {
  const match = ROUTE_LINE.exec(line.trim());

  return match ? { input: Number(match[2]), output: Number(match[1]) } : null;
}

export function parseSignalLine(line: string): { input: number; level: number } | null {
  const match = SIGNAL_LINE.exec(line.trim());

  return match ? { input: Number(match[1]), level: Number(match[2]) } : null;
}

export function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line.trim());
}

export function parseRoutes(lines: string[]): RouteMap {
  const routes: RouteMap = new Map();

  for (const line of lines) {
    const parsed = parseRouteLine(line);

    if (parsed) {
      routes.set(parsed.output, parsed.input);
    }
  }

  return routes;
}

export function parseInputSignals(lines: string[]): InputSignalMap {
  const signals: InputSignalMap = new Map();

  for (const line of lines) {
    const parsed = parseSignalLine(line);

    if (parsed) {
      signals.set(parsed.input, parsed.level);
    }
  }

  return signals;
}

export function parseFirmware(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = FIRMWARE_LINE.exec(line);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function assertNoError(lines: string[], action: string): void {
  const errorLine = lines.find(isErrorLine);

  if (errorLine) {
    throw new Error(`switcher_${action}_rejected: ${errorLine}`);
  }
}

export const avproAcMaxDriver: SwitcherDriver = {
  info: switcherModelInfo("avpro-ac-max"),

  async readRoutes(session: SwitcherSession): Promise<RouteMap> {
    const lines = await session.send("GET OUT0 AS");

    assertNoError(lines, "read_routes");

    return parseRoutes(lines);
  },

  async readInputSignals(session: SwitcherSession): Promise<InputSignalMap> {
    const lines = await session.send("GET IN0 SIG STA");

    assertNoError(lines, "read_signals");

    return parseInputSignals(lines);
  },

  async setRoute(session: SwitcherSession, output: number, input: number): Promise<number> {
    const setLines = await session.send(formatSetRoute(output, input));

    assertNoError(setLines, "set_route");

    // Read the crosspoint back so a silent/partial apply surfaces as an error
    // rather than a false success.
    const confirmLines = await session.send(`GET OUT${output} AS`);

    assertNoError(confirmLines, "confirm_route");

    const confirmed = parseRoutes(confirmLines).get(output);

    if (confirmed === undefined) {
      throw new Error(`switcher_confirm_route_missing: OUT${output}`);
    }

    if (confirmed !== input) {
      throw new Error(
        `switcher_confirm_route_mismatch: OUT${output} expected IN${input} got IN${confirmed}`,
      );
    }

    return confirmed;
  },

  async snapshot(session: SwitcherSession): Promise<string> {
    const lines = await session.send("GET CONFIG");

    assertNoError(lines, "snapshot");

    return lines.join("\n");
  },

  async restore(session: SwitcherSession, snapshot: string): Promise<void> {
    for (const raw of snapshot.split(/\r?\n/)) {
      const line = raw.trim();

      if (!line || !/^SET\s+/i.test(line) || UNSAFE_RESTORE.test(line)) {
        continue;
      }

      const response = await session.send(line);

      assertNoError(response, "restore");
    }
  },

  async test(session: SwitcherSession): Promise<SwitcherConnectionTest> {
    try {
      const routeLines = await session.send("GET OUT0 AS");
      const routes = parseRoutes(routeLines);
      const statusLines = await session.send("STA");
      const firmware = parseFirmware(statusLines);
      const ok = routes.size > 0;

      return {
        firmware,
        message: ok ? undefined : "no_routes_returned",
        model: "avpro-ac-max",
        ok,
        reachable: true,
        routeCount: routes.size,
      };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : "unknown_error",
        model: "avpro-ac-max",
        ok: false,
        reachable: false,
      };
    }
  },
};
