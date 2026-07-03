import net from "node:net";

// Reusable raw-TCP line transport for command-protocol audio switchers (AVPro
// AC-MAX and similar telnet-style devices). The device speaks a line protocol
// over TCP with no request/response framing and no prompt terminator, so a
// completed response is detected by an idle gap: send a command, then treat the
// response as complete once no further bytes arrive for `idleMs`.

export interface SwitcherConnection {
  host: string;
  // Optional control-channel credentials. The AVPro AC-MAX telnet port is open
  // (these guard its web GUI only) so its driver ignores them; models that
  // require a login handshake use them in their own driver.
  password?: string;
  port: number;
  username?: string;
}

export interface SwitcherSessionOptions {
  // Hard ceiling for a single command's response collection.
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  // Quiet gap after the last received byte that marks a response complete.
  idleMs?: number;
  // Ceiling on a single command's accumulated response. The control channel is
  // unauthenticated (telnet), so a compromised or spoofed device could stream
  // bytes continuously (resetting the idle timer) until the hard timeout,
  // growing the buffer without bound; cap it so an over-large response fails
  // fast instead of exhausting memory.
  maxResponseBytes?: number;
}

export interface SwitcherSession {
  close(): Promise<void>;
  // Send one command line and resolve with the response lines (trimmed,
  // non-empty). Resolves with [] if the device acknowledges silently.
  send(command: string): Promise<string[]>;
}

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

// Strip inline telnet IAC negotiation from a chunk and refuse every option so a
// negotiating server still advances to accepting commands. Returns the cleaned
// payload as a latin1 string (device responses are ASCII).
function stripTelnet(socket: net.Socket, data: Buffer): string {
  const out: number[] = [];
  let index = 0;

  while (index < data.length) {
    if (data[index] === IAC) {
      const command = data[index + 1];

      if (command === DO || command === DONT || command === WILL || command === WONT) {
        const option = data[index + 2];

        if (command === DO && option !== undefined) {
          socket.write(Buffer.from([IAC, WONT, option]));
        } else if (command === WILL && option !== undefined) {
          socket.write(Buffer.from([IAC, DONT, option]));
        }

        index += 3;
        continue;
      }

      if (command === SB) {
        index += 2;
        while (index < data.length && data[index] !== SE) {
          index += 1;
        }
        index += 1;
        continue;
      }

      index += 2;
      continue;
    }

    out.push(data[index]);
    index += 1;
  }

  return Buffer.from(out).toString("latin1");
}

export async function openSwitcherSession(
  connection: SwitcherConnection,
  options: SwitcherSessionOptions = {},
): Promise<SwitcherSession> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const idleMs = options.idleMs ?? 250;
  const commandTimeoutMs = options.commandTimeoutMs ?? 6_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;

  const socket = new net.Socket();
  socket.setNoDelay(true);

  let buffer = "";
  let onData: ((chunk: string) => void) | null = null;

  socket.on("data", (data: Buffer) => {
    const text = stripTelnet(socket, data);

    if (text.length > 0 && onData) {
      onData(text);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("switcher_connect_timeout"));
    }, connectTimeoutMs);
    const onConnectError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };

    socket.once("error", onConnectError);
    socket.connect(connection.port, connection.host, () => {
      clearTimeout(timer);
      socket.removeListener("error", onConnectError);
      resolve();
    });
  });

  const runCommand = (command: string): Promise<string[]> =>
    new Promise<string[]>((resolve, reject) => {
      buffer = "";
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        onData = null;
        socket.removeListener("error", onError);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (hardTimer) {
          clearTimeout(hardTimer);
        }
      };
      const finish = () => {
        cleanup();
        resolve(
          buffer
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      onData = (chunk: string) => {
        buffer += chunk;
        // Fail fast if the device floods past the response ceiling rather than
        // letting the buffer grow until the hard timeout (unbounded memory).
        if (buffer.length > maxResponseBytes) {
          cleanup();
          reject(new Error("switcher_response_too_large"));
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(finish, idleMs);
      };
      socket.once("error", onError);
      // Start the idle timer up front so a silent acknowledgement still
      // resolves (with []), and cap the total wait so a wedged device can't
      // hang the caller.
      idleTimer = setTimeout(finish, Math.max(idleMs, 300));
      hardTimer = setTimeout(finish, commandTimeoutMs);

      socket.write(`${command}\r\n`);
    });

  // Serialize commands: the device has a single command channel, so overlapping
  // sends would interleave responses.
  let queue: Promise<unknown> = Promise.resolve();

  const send = (command: string): Promise<string[]> => {
    const result = queue.then(() => runCommand(command));

    queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      socket.removeAllListeners("error");
      socket.on("error", () => undefined);
      socket.end(() => resolve());
      socket.destroy();
    });

  return { close, send };
}

// Open a session, run `fn`, and always close the socket.
export async function withSwitcherSession<T>(
  connection: SwitcherConnection,
  options: SwitcherSessionOptions,
  fn: (session: SwitcherSession) => Promise<T>,
): Promise<T> {
  const session = await openSwitcherSession(connection, options);

  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
