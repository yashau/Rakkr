import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import type { serve } from "@hono/node-server";

type ApiListenOptions = Parameters<typeof serve>[0];
type ApiFetch = ApiListenOptions["fetch"];

export interface ApiListenConfig {
  options: ApiListenOptions;
  protocol: "http" | "https";
}

export function apiListenConfig(
  fetch: ApiFetch,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): ApiListenConfig {
  const certPath = text(env.RAKKR_API_TLS_CERT_PATH);
  const keyPath = text(env.RAKKR_API_TLS_KEY_PATH);
  const caPath = text(env.RAKKR_API_TLS_CA_PATH);

  if (!certPath && !keyPath && !caPath) {
    return {
      options: { fetch, port },
      protocol: "http",
    };
  }

  if (!certPath || !keyPath) {
    throw new Error("RAKKR_API_TLS_CERT_PATH and RAKKR_API_TLS_KEY_PATH must be set together");
  }

  return {
    options: {
      createServer: createHttpsServer,
      fetch,
      port,
      serverOptions: {
        ca: caPath ? readFileSync(caPath) : undefined,
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      },
    },
    protocol: "https",
  };
}

function text(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed || undefined;
}
