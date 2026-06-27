import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import type { serve } from "@hono/node-server";

type ApiListenOptions = Parameters<typeof serve>[0];
type ApiFetch = ApiListenOptions["fetch"];
type ClientCertificateMode = "off" | "optional" | "required";

export interface ApiTlsCertificateSummary {
  certFingerprintSha256: string;
  certPath: string;
  keyPath: string;
  notBefore?: string;
}

export interface ApiTlsClientCertificateConfig {
  caPath?: string;
  mode: ClientCertificateMode;
}

export interface ApiTlsRotationConfig {
  active: ApiTlsCertificateSummary;
  clientCertificates: ApiTlsClientCertificateConfig;
  next?: ApiTlsCertificateSummary;
}

export interface ApiListenConfig {
  options: ApiListenOptions;
  protocol: "http" | "https";
  tls?: ApiTlsRotationConfig;
}

export function apiListenConfig(
  fetch: ApiFetch,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): ApiListenConfig {
  const certPath = text(env.RAKKR_API_TLS_CERT_PATH);
  const keyPath = text(env.RAKKR_API_TLS_KEY_PATH);
  const caPath = text(env.RAKKR_API_TLS_CA_PATH);
  const nextCertPath = text(env.RAKKR_API_TLS_NEXT_CERT_PATH);
  const nextKeyPath = text(env.RAKKR_API_TLS_NEXT_KEY_PATH);
  const clientCaPath = text(env.RAKKR_API_TLS_CLIENT_CA_PATH);
  const clientCertMode = clientCertificateMode(env.RAKKR_API_TLS_CLIENT_CERT_MODE);

  if (!certPath && !keyPath && !caPath && !nextCertPath && !nextKeyPath && !clientCaPath) {
    return {
      options: { fetch, port },
      protocol: "http",
    };
  }

  if (!certPath || !keyPath) {
    throw new Error("RAKKR_API_TLS_CERT_PATH and RAKKR_API_TLS_KEY_PATH must be set together");
  }

  if (!nextCertPath !== !nextKeyPath) {
    throw new Error(
      "RAKKR_API_TLS_NEXT_CERT_PATH and RAKKR_API_TLS_NEXT_KEY_PATH must be set together",
    );
  }

  if (clientCertMode !== "off" && !clientCaPath && !caPath) {
    throw new Error(
      "RAKKR_API_TLS_CLIENT_CA_PATH or RAKKR_API_TLS_CA_PATH is required when client certificates are optional or required",
    );
  }

  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const ca = (clientCaPath ?? caPath) ? readFileSync(clientCaPath ?? caPath ?? "") : undefined;
  const nextCert = nextCertPath ? readFileSync(nextCertPath) : undefined;

  return {
    options: {
      createServer: createHttpsServer,
      fetch,
      port,
      serverOptions: {
        ca,
        cert,
        key,
        rejectUnauthorized: clientCertMode === "required",
        requestCert: clientCertMode !== "off",
      },
    },
    protocol: "https",
    tls: {
      active: certificateSummary(certPath, keyPath, cert),
      clientCertificates: {
        caPath: clientCaPath ?? caPath,
        mode: clientCertMode,
      },
      next:
        nextCertPath && nextKeyPath && nextCert
          ? certificateSummary(
              nextCertPath,
              nextKeyPath,
              nextCert,
              env.RAKKR_API_TLS_NEXT_NOT_BEFORE,
            )
          : undefined,
    },
  };
}

function text(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed || undefined;
}

function certificateSummary(
  certPath: string,
  keyPath: string,
  cert: Buffer,
  notBefore?: string,
): ApiTlsCertificateSummary {
  return {
    certFingerprintSha256: createHash("sha256").update(cert).digest("hex"),
    certPath,
    keyPath,
    notBefore: text(notBefore),
  };
}

function clientCertificateMode(value: string | undefined): ClientCertificateMode {
  const mode = text(value)?.toLowerCase();

  if (!mode || mode === "off" || mode === "none" || mode === "false") {
    return "off";
  }

  if (mode === "optional") {
    return "optional";
  }

  if (mode === "required" || mode === "require" || mode === "true") {
    return "required";
  }

  throw new Error("RAKKR_API_TLS_CLIENT_CERT_MODE must be off, optional, or required");
}
