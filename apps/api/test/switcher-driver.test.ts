import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  avproAcMaxDriver,
  formatSetRoute,
  getSwitcherDriver,
  isErrorLine,
  openSwitcherSession,
  parseFirmware,
  parseInputSignals,
  parseRouteLine,
  parseRoutes,
  parseSignalLine,
  withSwitcherSession,
} from "../src/switchers/index.js";

interface EmulatorState {
  errorMode: boolean;
  ignoreSet: boolean;
}

interface Emulator {
  close(): Promise<void>;
  port: number;
  routes: Map<number, number>;
  state: EmulatorState;
}

// Minimal in-process AC-MAX emulator: initial topology mirrors the live unit
// (OUT1-4 -> IN1-4, OUT5-24 -> IN9) so tests exercise realistic parsing.
async function startEmulator(): Promise<Emulator> {
  const routes = new Map<number, number>();

  for (let output = 1; output <= 24; output += 1) {
    routes.set(output, output <= 4 ? output : 9);
  }

  const state: EmulatorState = { errorMode: false, ignoreSet: false };

  const reply = (socket: net.Socket, lines: string[]) => {
    socket.write(lines.map((line) => `${line}\r\n`).join(""));
  };

  const handle = (socket: net.Socket, line: string) => {
    if (state.errorMode) {
      reply(socket, ["CMD ERR: Command is not valid"]);
      return;
    }

    const upper = line.toUpperCase();

    if (upper === "GET OUT0 AS") {
      reply(
        socket,
        [...routes.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([output, input]) => `OUT${output} AS IN${input}`),
      );
      return;
    }

    const getOne = /^GET OUT(\d+) AS$/i.exec(line);

    if (getOne) {
      const output = Number(getOne[1]);

      reply(socket, [`OUT${output} AS IN${routes.get(output) ?? 0}`]);
      return;
    }

    const setRoute = /^SET OUT(\d+) AS IN(\d+)$/i.exec(line);

    if (setRoute) {
      const output = Number(setRoute[1]);
      const input = Number(setRoute[2]);

      if (!state.ignoreSet) {
        routes.set(output, input);
      }

      reply(socket, [`OUT${output} AS IN${routes.get(output) ?? 0}`]);
      return;
    }

    if (upper === "GET IN0 SIG STA") {
      const lines: string[] = [];

      for (let input = 1; input <= 24; input += 1) {
        lines.push(`IN${input} SIG STA ${input === 13 ? 3 : 0}`);
      }

      reply(socket, lines);
      return;
    }

    if (upper === "STA") {
      reply(socket, ["= System Address = 00      F/W Version : 1.31 =", "= DHCP = DISABLE ="]);
      return;
    }

    if (upper === "GET CONFIG") {
      const lines = ["SET ADDR 00", "SET BAUDR 4"];

      for (const [output, input] of [...routes.entries()].sort(
        (left, right) => left[0] - right[0],
      )) {
        lines.push(`SET OUT${output} AS IN${input}`);
      }

      lines.push("SET HIP 172.022.195.101");
      reply(socket, lines);
      return;
    }

    reply(socket, ["CMD ERR: Command is not valid"]);
  };

  const server = net.createServer((socket) => {
    let pending = "";

    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      let newline = pending.indexOf("\n");

      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "").trim();

        pending = pending.slice(newline + 1);

        if (line.length > 0) {
          handle(socket, line);
        }

        newline = pending.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    port,
    routes,
    state,
  };
}

const sessionOptions = { commandTimeoutMs: 2_000, connectTimeoutMs: 2_000, idleMs: 30 };

test("formats and parses AC-MAX line protocol", () => {
  assert.equal(formatSetRoute(7, 13), "SET OUT7 AS IN13");
  assert.deepEqual(parseRouteLine("OUT7 AS IN13"), { input: 13, output: 7 });
  assert.deepEqual(parseRouteLine("  out2 as in9  "), { input: 9, output: 2 });
  assert.equal(parseRouteLine("not a route"), null);
  assert.deepEqual(parseSignalLine("IN13 SIG STA 3"), { input: 13, level: 3 });
  assert.equal(parseSignalLine("bogus"), null);
  assert.equal(isErrorLine("CMD ERR: Command is not valid"), true);
  assert.equal(isErrorLine("OUT1 AS IN1"), false);

  const routes = parseRoutes(["OUT1 AS IN1", "OUT2 AS IN9", "CMD ERR: nope", "junk"]);

  assert.equal(routes.size, 2);
  assert.equal(routes.get(1), 1);
  assert.equal(routes.get(2), 9);

  const signals = parseInputSignals(["IN1 SIG STA 0", "IN13 SIG STA 3"]);

  assert.equal(signals.get(13), 3);
  assert.equal(parseFirmware(["= foo =", "= F/W Version : 1.31 ="]), "1.31");
  assert.equal(parseFirmware(["no version here"]), undefined);
});

test("registry resolves the AC-MAX driver", () => {
  const driver = getSwitcherDriver("avpro-ac-max");

  assert.equal(driver, avproAcMaxDriver);
  assert.equal(driver.info.inputs, 24);
  assert.equal(driver.info.outputs, 24);
  assert.equal(driver.info.defaultPort, 23);
});

test("driver reads, sets, and confirms routes over the transport", async () => {
  const emulator = await startEmulator();

  try {
    const session = await openSwitcherSession(
      { host: "127.0.0.1", port: emulator.port },
      sessionOptions,
    );

    try {
      const routes = await avproAcMaxDriver.readRoutes(session);

      assert.equal(routes.size, 24);
      assert.equal(routes.get(1), 1);
      assert.equal(routes.get(24), 9);

      const confirmed = await avproAcMaxDriver.setRoute(session, 24, 13);

      assert.equal(confirmed, 13);
      assert.equal((await avproAcMaxDriver.readRoutes(session)).get(24), 13);

      const signals = await avproAcMaxDriver.readInputSignals(session);

      assert.equal(signals.size, 24);
      assert.equal(signals.get(13), 3);

      const snapshot = await avproAcMaxDriver.snapshot(session);

      assert.ok(snapshot.includes("SET OUT24 AS IN13"));

      const result = await avproAcMaxDriver.test(session);

      assert.equal(result.ok, true);
      assert.equal(result.reachable, true);
      assert.equal(result.firmware, "1.31");
      assert.equal(result.routeCount, 24);
    } finally {
      await session.close();
    }
  } finally {
    await emulator.close();
  }
});

test("setRoute rejects when the device does not apply the change", async () => {
  const emulator = await startEmulator();
  emulator.state.ignoreSet = true;

  try {
    await withSwitcherSession(
      { host: "127.0.0.1", port: emulator.port },
      sessionOptions,
      async (session) => {
        await assert.rejects(
          () => avproAcMaxDriver.setRoute(session, 24, 7),
          /confirm_route_mismatch/,
        );
      },
    );
  } finally {
    await emulator.close();
  }
});

test("readRoutes surfaces device command errors", async () => {
  const emulator = await startEmulator();
  emulator.state.errorMode = true;

  try {
    await withSwitcherSession(
      { host: "127.0.0.1", port: emulator.port },
      sessionOptions,
      async (session) => {
        await assert.rejects(() => avproAcMaxDriver.readRoutes(session), /read_routes_rejected/);
      },
    );
  } finally {
    await emulator.close();
  }
});

test("restore replays routing but skips device-network commands", async () => {
  const emulator = await startEmulator();

  try {
    await withSwitcherSession(
      { host: "127.0.0.1", port: emulator.port },
      sessionOptions,
      async (session) => {
        await avproAcMaxDriver.restore(
          session,
          ["SET OUT24 AS IN5", "SET HIP 10.0.0.1", ""].join("\n"),
        );

        // Routing command applied; the unsafe network command was skipped, so the
        // emulator's host config would be untouched on a real device.
        assert.equal((await avproAcMaxDriver.readRoutes(session)).get(24), 5);
      },
    );
  } finally {
    await emulator.close();
  }
});

test("session rejects a device response that floods past the size cap", async () => {
  // The control channel is unauthenticated telnet, so a compromised or spoofed
  // device can stream bytes continuously (resetting the idle timer) until the
  // hard timeout. The session must abort on the size cap rather than buffer
  // without bound.
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", () => {
      const blob = `${"x".repeat(8_192)}\r\n`;

      for (let i = 0; i < 64; i += 1) {
        socket.write(blob);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const session = await openSwitcherSession(
      { host: "127.0.0.1", port },
      { ...sessionOptions, maxResponseBytes: 64 * 1_024 },
    );

    try {
      await assert.rejects(() => session.send("STA"), /switcher_response_too_large/);
    } finally {
      await session.close();
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

// Live validation against a real AC-MAX. Skipped unless RAKKR_SWITCHER_LIVE_HOST
// is set. Round-trips a single spare output and restores its original source, so
// it is safe to run against a unit that is otherwise idle.
const liveHost = process.env.RAKKR_SWITCHER_LIVE_HOST;

test("live AC-MAX round-trips a route on a spare output", { skip: !liveHost }, async () => {
  const output = Number(process.env.RAKKR_SWITCHER_LIVE_OUTPUT ?? "24");

  await withSwitcherSession(
    { host: liveHost as string, port: Number(process.env.RAKKR_SWITCHER_LIVE_PORT ?? "23") },
    { commandTimeoutMs: 8_000, connectTimeoutMs: 6_000, idleMs: 300 },
    async (session) => {
      const before = await avproAcMaxDriver.readRoutes(session);

      assert.ok(before.size >= 1, "expected at least one route from the live device");

      const original = before.get(output) ?? 0;
      const target = original === 1 ? 2 : 1;

      const confirmed = await avproAcMaxDriver.setRoute(session, output, target);

      assert.equal(confirmed, target);

      const restored = await avproAcMaxDriver.setRoute(session, output, original);

      assert.equal(restored, original);
    },
  );
});
