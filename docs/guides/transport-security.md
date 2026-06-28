---
title: Transport security
description: Encrypting controller/agent traffic — HTTPS, the agent plaintext guard, controller CA trust, and optional mutual TLS.
sidebar:
  order: 7
---

# Transport security

Traffic between the controller and recorder nodes must be **transport-layer
encrypted**. Rakkr ships the pieces to run encrypted in production while keeping
local development friction-free.

## Flows that must be encrypted

All controller/node exchanges are sensitive and expected to run over TLS in
production:

- node enrollment;
- heartbeat / status;
- commands and acknowledgements;
- meter frames;
- live monitor audio;
- recording / job metadata;
- local event-log sync;
- health and alert updates.

## Controller HTTPS

Set the TLS cert/key paths to make the controller serve HTTPS:

| Variable                                                               | Purpose                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `RAKKR_API_TLS_CERT_PATH` / `RAKKR_API_TLS_KEY_PATH`                   | Active server certificate and key (set together).        |
| `RAKKR_API_TLS_CA_PATH`                                                | CA bundle; also the default client-CA for mTLS.          |
| `RAKKR_API_TLS_NEXT_CERT_PATH` / `_NEXT_KEY_PATH` / `_NEXT_NOT_BEFORE` | Pre-staged "next" material for **certificate rotation**. |

If none of these are set, the controller serves plain HTTP (fine for localhost
dev). Setting any TLS path triggers HTTPS and enforces cert/key pairing.

## Mutual TLS (optional)

The controller can request or require recorder **client certificates** for node
identity:

| Variable                         | Values                          | Effect                                                                  |
| -------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `RAKKR_API_TLS_CLIENT_CA_PATH`   | path                            | CA used to verify client certs (falls back to `RAKKR_API_TLS_CA_PATH`). |
| `RAKKR_API_TLS_CLIENT_CERT_MODE` | `off` / `optional` / `required` | Whether client certs are ignored, requested, or mandatory.              |

## Agent-side trust and the plaintext guard

The recorder agent defends against accidental plaintext exposure:

- It **rejects non-loopback `http://`** controller URLs. For an explicit
  development exception, pass `--allow-insecure-controller`
  (`RAKKR_ALLOW_INSECURE_CONTROLLER=1`). Localhost HTTP is always allowed.
- It can trust an internal controller CA bundle for all requests with
  `--controller-ca-cert-path` (`RAKKR_CONTROLLER_CA_CERT_PATH`).

## Credentials and enrollment

- Local auth uses hashed passwords and bearer sessions.
- OIDC uses Authorization Code + PKCE; Azure AD stays disabled by default.
- **Node enrollment uses one-time tokens and stores only hashes.** Node
  credentials are scoped to a single node's own jobs, recordings, meters, and
  events.

## Development vs production

|            | Development                                             | Production                                                           |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Controller | HTTP on localhost is fine                               | HTTPS with a real cert; consider mTLS                                |
| Agent      | `--allow-insecure-controller` to a localhost controller | HTTPS only; trust the controller CA; client cert if mTLS is required |
| Certs      | Local CA or trusted dev certs                           | Live rotation via the "next" cert/key material                       |

The checked contract is the `TRANSPORT_SECURITY_BASELINE`. All TLS variables are
listed in the [configuration reference](../reference/configuration.md#tls--transport).
