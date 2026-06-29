import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import { NodeStoreError, type NodeStore } from "./node-store.js";
import {
  NodeSshCredentialStoreError,
  type NodeSshCredentialMetadata,
  type NodeSshCredentialStore,
} from "./node-ssh-credential-store.js";

interface NodeSshCredentialRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  sshCredentialStore: NodeSshCredentialStore;
}

// The controller is the system of record for each node's SSH key. Operators
// (node:manage) rotate it and read its public half; the Ansible runner — a
// trusted backend service authenticated with a shared runner token — fetches the
// decrypted private key (and optionally a freshly-minted controller token) for a
// lifecycle run. Private keys are never returned to operators or logged.
export function registerNodeSshCredentialRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
  sshCredentialStore,
}: NodeSshCredentialRouteDependencies) {
  app.get(
    "/api/v1/nodes/:nodeId/ssh-credential",
    requirePermission("node:manage", "nodes.ssh_credential.read", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordFailure(c, "nodes.ssh_credential.read.failed", "node_not_found", nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      const credential = await sshCredentialStore.findActiveMetadata(nodeId);

      await recordAuditEvent(c, {
        action: "nodes.ssh_credential.read.succeeded",
        auth: currentAuth(c),
        details: credentialAuditDetails(credential),
        outcome: "succeeded",
        permission: "node:manage",
        target: { id: node.id, name: node.alias, type: "node" },
      });

      return c.json({ data: credential ?? null });
    },
  );

  app.post(
    "/api/v1/nodes/:nodeId/ssh-credential/rotate",
    requirePermission("node:manage", "nodes.ssh_credential.rotate", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordFailure(c, "nodes.ssh_credential.rotate.failed", "node_not_found", nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      const body = (await c.req.json().catch(() => ({}))) as { username?: unknown };
      const username = typeof body.username === "string" ? body.username : undefined;
      const credential = await sshCredentialStore
        .rotate(nodeId, { actorUserId: currentUser(c).id, username })
        .catch(async (error: unknown) => {
          const reason =
            error instanceof NodeSshCredentialStoreError
              ? error.code
              : "ssh_credential_rotate_failed";

          await recordFailure(c, "nodes.ssh_credential.rotate.failed", reason, node.alias);
          return "unavailable" as const;
        });

      if (credential === "unavailable") {
        return c.json({ error: "Node SSH credential rotation unavailable" }, 503);
      }

      await recordAuditEvent(c, {
        action: "nodes.ssh_credential.rotate.succeeded",
        auth: currentAuth(c),
        details: credentialAuditDetails(credential),
        outcome: "succeeded",
        permission: "node:manage",
        target: { id: node.id, name: node.alias, type: "node" },
      });

      return c.json({ data: credential }, 201);
    },
  );

  // Runner-scoped: the Ansible runner fetches the decrypted private key for a
  // lifecycle run. Authenticated by the shared runner token, never user auth.
  app.get("/api/v1/nodes/:nodeId/ssh-credential/material", async (c) => {
    const nodeId = c.req.param("nodeId");
    const target = { id: nodeId, type: "node" as const };
    const runnerToken = process.env.RAKKR_RUNNER_TOKEN;

    if (!runnerToken) {
      await recordRunnerFailure(c, "runner_token_unconfigured", target);
      return c.json({ error: "Runner credential not configured" }, 503);
    }

    if (!matchesRunnerToken(bearerToken(c.req.header("authorization")), runnerToken)) {
      await recordRunnerFailure(c, "invalid_runner_token", target);
      return c.json({ error: "Runner credential required" }, 401);
    }

    const node = await nodeStore.find(nodeId).catch(() => undefined);

    if (!node) {
      await recordRunnerFailure(c, "node_not_found", target);
      return c.json({ error: "Node not found" }, 404);
    }

    const material = await sshCredentialStore.findActiveMaterial(nodeId);

    if (!material) {
      await recordRunnerFailure(c, "ssh_credential_not_found", { id: node.id, type: "node" });
      return c.json({ error: "Node has no active SSH credential" }, 404);
    }

    // Optionally re-provision a fresh controller token for the agent on deploy
    // actions; non-deploy runs omit it so the running agent's token is untouched.
    const mintToken = c.req.query("mintToken") === "1";
    const minted = mintToken ? await mintControllerToken(c, node.id) : undefined;

    await recordAuditEvent(c, {
      action: "nodes.ssh_credential.fetch.succeeded",
      actor: runnerActor(),
      details: {
        ...credentialAuditDetails(material),
        mintedTokenPrefix: minted?.tokenPrefix,
        provisionedToken: Boolean(minted),
      },
      outcome: "succeeded",
      permission: "node:manage",
      target: { id: node.id, name: node.alias, type: "node" },
    });

    return c.json({
      data: {
        controllerToken: minted?.token,
        fingerprint: material.fingerprint,
        privateKey: material.privateKey,
        publicKey: material.publicKey,
        username: material.username,
      },
    });
  });

  async function mintControllerToken(c: Context<AppBindings>, nodeId: string) {
    try {
      const result = await nodeStore.rotateCredential(nodeId);

      return result?.credential;
    } catch (error) {
      // Token minting is best-effort: a deploy can still proceed with SSH and
      // re-use the prior token, so surface the failure without blocking the run.
      const reason = error instanceof NodeStoreError ? error.code : "controller_token_mint_failed";

      await recordRunnerFailure(c, reason, { id: nodeId, type: "node" });
      return undefined;
    }
  }

  async function findScopedNode(c: Context<AppBindings>, nodeId: string) {
    return (await scopedNodes(currentUser(c))).find((node) => node.id === nodeId);
  }

  async function recordFailure(
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

  async function recordRunnerFailure(
    c: Context<AppBindings>,
    reason: string,
    target: { id: string; type: "node" },
  ) {
    await recordAuditEvent(c, {
      action: "nodes.ssh_credential.fetch.failed",
      actor: runnerActor(),
      outcome:
        reason === "invalid_runner_token" || reason === "runner_token_unconfigured"
          ? "denied"
          : "failed",
      permission: "node:manage",
      reason,
      target,
    });
  }
}

function credentialAuditDetails(credential: NodeSshCredentialMetadata | undefined) {
  return {
    credentialId: credential?.id,
    // Only the fingerprint + public material are ever recorded; never the key.
    fingerprint: credential?.fingerprint,
    hasCredential: Boolean(credential),
    username: credential?.username,
  };
}

function runnerActor() {
  return { id: "ansible-runner", name: "Ansible Runner", roles: [], type: "system" as const };
}

function matchesRunnerToken(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
