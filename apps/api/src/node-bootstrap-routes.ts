import type { Context, Hono } from "hono";
import { z } from "zod";
import type { RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { bearerToken } from "./auth-utils.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import { NodeBootstrapStoreError, type NodeBootstrapStore } from "./node-bootstrap-store.js";
import { NodeStoreError, type NodeStore } from "./node-store.js";
import {
  NodeSshCredentialStoreError,
  type NodeSshCredentialStore,
} from "./node-ssh-credential-store.js";

interface NodeBootstrapRouteDependencies {
  app: Hono<AppBindings>;
  bootstrapStore: NodeBootstrapStore;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  sshCredentialStore: NodeSshCredentialStore;
}

const bootstrapTokenRequestSchema = z
  .object({ ttlSeconds: z.coerce.number().int().positive().max(86_400).optional() })
  .strip();
const bootstrapInterfaceSchema = z.object({
  alias: z.string().trim().min(1).max(160),
  backend: z.enum(["alsa", "jack", "pipewire", "unknown"]).default("unknown"),
  channelCount: z.coerce.number().int().min(0).max(256),
  channels: z
    .array(
      z.object({
        alias: z.string().trim().min(1).max(160),
        index: z.coerce.number().int().positive().max(256),
      }),
    )
    .max(256)
    .default([]),
  hardwarePath: z.string().trim().min(1).max(500).optional(),
  sampleRates: z.array(z.coerce.number().int().positive()).max(16).default([]),
  serialNumber: z.string().trim().min(1).max(255).optional(),
  systemName: z.string().trim().min(1).max(255),
  systemRef: z.string().trim().min(1).max(255).optional(),
});
const bootstrapRequestSchema = z
  .object({
    interfaces: z.array(bootstrapInterfaceSchema).max(64).optional(),
    // Preserve the PEM verbatim (no trim) so the trailing newline survives.
    privateKey: z.string().min(1).max(20_000),
    publicKey: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) /u, "Expected an OpenSSH public key"),
    username: z.string().trim().min(1).max(64).optional(),
  })
  .strip();

// Day-0 onboarding. An operator (node:manage) issues a single-use, short-TTL
// bootstrap token that rides into the node's provisioning user-data. At first
// boot the agent generates its own SSH keypair and POSTs the private key +
// discovered inventory here, authenticated only by that bootstrap token; the
// controller stores the key, reconciles interfaces, mints a long-lived
// controller token, and consumes the bootstrap token.
export function registerNodeBootstrapRoutes({
  app,
  bootstrapStore,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
  sshCredentialStore,
}: NodeBootstrapRouteDependencies) {
  app.post(
    "/api/v1/nodes/:nodeId/bootstrap-token",
    requirePermission("node:manage", "nodes.bootstrap_token.issue", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = (await scopedNodes(currentUser(c))).find((candidate) => candidate.id === nodeId);

      if (!node) {
        await recordOperatorFailure(
          c,
          "nodes.bootstrap_token.issue.failed",
          "node_not_found",
          nodeId,
        );
        return c.json({ error: "Node not found" }, 404);
      }

      const body = bootstrapTokenRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordOperatorFailure(
          c,
          "nodes.bootstrap_token.issue.failed",
          "invalid_request",
          nodeId,
        );
        return c.json({ error: "Invalid bootstrap token request", issues: body.error.issues }, 400);
      }

      const issued = await bootstrapStore
        .issue(nodeId, { actorUserId: currentUser(c).id, ttlSeconds: body.data.ttlSeconds })
        .catch(async (error: unknown) => {
          const reason =
            error instanceof NodeBootstrapStoreError ? error.code : "bootstrap_token_issue_failed";

          await recordOperatorFailure(c, "nodes.bootstrap_token.issue.failed", reason, node.alias);
          return "unavailable" as const;
        });

      if (issued === "unavailable") {
        return c.json({ error: "Bootstrap token issuance unavailable" }, 503);
      }

      await recordAuditEvent(c, {
        action: "nodes.bootstrap_token.issue.succeeded",
        auth: currentAuth(c),
        details: { expiresAt: issued.expiresAt, tokenPrefix: issued.tokenPrefix },
        outcome: "succeeded",
        permission: "node:manage",
        target: { id: node.id, name: node.alias, type: "node" },
      });

      return c.json({ data: { expiresAt: issued.expiresAt, nodeId, token: issued.token } }, 201);
    },
  );

  // Bootstrap-token-authenticated: no user/session, only the single-use token.
  app.post("/api/v1/nodes/:nodeId/bootstrap", async (c) => {
    const nodeId = c.req.param("nodeId");
    const target = { id: nodeId, type: "node" as const };
    const token = bearerToken(c.req.header("authorization"));

    if (!token) {
      await recordBootstrapFailure(c, "missing_bootstrap_token", target);
      return c.json({ error: "Bootstrap token required" }, 401);
    }

    const body = bootstrapRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordBootstrapFailure(c, "invalid_request", target);
      return c.json({ error: "Invalid bootstrap request", issues: body.error.issues }, 400);
    }

    const consumed = await bootstrapStore.consume(nodeId, token).catch(() => false);

    if (!consumed) {
      await recordBootstrapFailure(c, "invalid_bootstrap_token", target);
      return c.json({ error: "Invalid or expired bootstrap token" }, 401);
    }

    const node = await nodeStore.find(nodeId).catch(() => undefined);

    if (!node) {
      await recordBootstrapFailure(c, "node_not_found", target);
      return c.json({ error: "Node not found" }, 404);
    }

    try {
      const credential = await sshCredentialStore.ingest(nodeId, {
        privateKeyPem: body.data.privateKey,
        publicKey: body.data.publicKey,
        username: body.data.username,
      });

      if (body.data.interfaces) {
        await nodeStore.reconcileInterfaces(nodeId, body.data.interfaces).catch(() => undefined);
      }

      const minted = await nodeStore.rotateCredential(nodeId);

      await recordAuditEvent(c, {
        action: "nodes.bootstrap.completed",
        actor: { id: node.id, name: node.alias, roles: [], type: "node" },
        details: {
          fingerprint: credential.fingerprint,
          interfaceCount: body.data.interfaces?.length,
          mintedTokenPrefix: minted?.credential.tokenPrefix,
          username: credential.username,
        },
        outcome: "succeeded",
        permission: "node:manage",
        target: { id: node.id, name: node.alias, type: "node" },
      });

      return c.json(
        {
          data: {
            controllerToken: minted?.credential.token,
            fingerprint: credential.fingerprint,
            nodeId: node.id,
          },
        },
        201,
      );
    } catch (error) {
      const reason =
        error instanceof NodeSshCredentialStoreError || error instanceof NodeStoreError
          ? error.code
          : "bootstrap_failed";

      await recordBootstrapFailure(c, reason, target);
      return c.json({ error: "Node bootstrap unavailable" }, 503);
    }
  });

  async function recordOperatorFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    name: string,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "node:manage",
      reason,
      target: { id: name, name, type: "node" },
    });
  }

  async function recordBootstrapFailure(
    c: Context<AppBindings>,
    reason: string,
    target: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action: "nodes.bootstrap.failed",
      actor: { id: target.id ?? "unknown", name: target.id ?? "unknown", roles: [], type: "node" },
      outcome:
        reason === "missing_bootstrap_token" || reason === "invalid_bootstrap_token"
          ? "denied"
          : "failed",
      permission: "node:manage",
      reason,
      target,
    });
  }
}
