import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";
import { createNodeLifecycleService, type NodeLifecycleJob } from "../src/node-lifecycle.js";

test("node lifecycle HTTP runner does not override target SSH user by default", async () => {
  const previousRunnerUrl = process.env.RAKKR_ANSIBLE_RUNNER_URL;
  const previousDefaultUser = process.env.RAKKR_ANSIBLE_DEFAULT_SSH_USER;
  let receivedPayload: unknown;
  const server = createServer((request, response) => {
    let raw = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      receivedPayload = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            exitCode: 0,
            runId: "ansible_test_run",
            targetHost: "172.22.145.152",
          },
        }),
      );
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address && typeof address === "object");
    process.env.RAKKR_ANSIBLE_RUNNER_URL = `http://127.0.0.1:${address.port}`;
    process.env.RAKKR_ANSIBLE_DEFAULT_SSH_USER = "rakkr";

    const jobs: NodeLifecycleJob[] = [];
    const service = createNodeLifecycleService({
      store: {
        async list(nodeId) {
          return jobs.filter((job) => !nodeId || job.nodeId === nodeId);
        },
        async save(job) {
          const index = jobs.findIndex((candidate) => candidate.id === job.id);

          if (index >= 0) {
            jobs[index] = job;
          } else {
            jobs.unshift(job);
          }
        },
      },
    });

    const job = await service.run({
      action: "smoke_check",
      node: node(),
      requestedBy: "user_node_lifecycle",
    });

    assert.equal(job.status, "succeeded");
    assert.deepEqual(receivedPayload, {
      action: "smoke_check",
      options: {},
      target: {
        host: "172.22.145.152",
        nodeAlias: "Council Chamber Rack",
        nodeId: "node_x32_test",
      },
    });
  } finally {
    restoreEnv("RAKKR_ANSIBLE_RUNNER_URL", previousRunnerUrl);
    restoreEnv("RAKKR_ANSIBLE_DEFAULT_SSH_USER", previousDefaultUser);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Council Chamber Rack",
    hostname: "recorder",
    id: "node_x32_test",
    interfaces: [],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: "2026-06-27T21:37:31.533Z",
    location: {
      room: "Council Chamber",
      site: "Main Site",
    },
    status: "online",
    tags: ["x32"],
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
