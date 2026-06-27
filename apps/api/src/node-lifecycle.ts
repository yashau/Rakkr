import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RecorderNode } from "@rakkr/shared";

export const nodeLifecycleActions = [
  "install_dependencies",
  "update_binary",
  "restart_service",
  "rotate_trust",
  "smoke_check",
] as const;

export type NodeLifecycleAction = (typeof nodeLifecycleActions)[number];
export type NodeLifecycleStatus = "failed" | "running" | "succeeded";

export interface NodeLifecycleJob {
  action: NodeLifecycleAction;
  completedAt?: string;
  error?: string;
  exitCode?: number;
  id: string;
  nodeAlias: string;
  nodeId: string;
  requestedAt: string;
  requestedBy: string;
  runnerRunId?: string;
  startedAt?: string;
  status: NodeLifecycleStatus;
  stderr?: string;
  stdout?: string;
  targetHost: string;
}

export interface NodeLifecycleRunInput {
  action: NodeLifecycleAction;
  node: RecorderNode;
  options?: NodeLifecycleRunOptions;
  requestedBy: string;
}

export interface NodeLifecycleRunOptions {
  agentVersion?: string;
  sshUser?: string;
}

interface NodeLifecycleRunnerResult {
  exitCode: number;
  runId?: string;
  stderr?: string;
  stdout?: string;
  targetHost?: string;
}

interface NodeLifecycleRunner {
  run(input: {
    action: NodeLifecycleAction;
    node: RecorderNode;
    options?: NodeLifecycleRunOptions;
    targetHost: string;
  }): Promise<NodeLifecycleRunnerResult>;
}

interface NodeLifecycleJobStore {
  list(nodeId?: string): Promise<NodeLifecycleJob[]>;
  save(job: NodeLifecycleJob): Promise<void>;
}

export interface NodeLifecycleService {
  list(nodeId?: string): Promise<NodeLifecycleJob[]>;
  run(input: NodeLifecycleRunInput): Promise<NodeLifecycleJob>;
}

const lifecycleStorePath = path.resolve(
  process.env.RAKKR_NODE_LIFECYCLE_STORE_PATH ?? "data/node-lifecycle-jobs.json",
);

export function createNodeLifecycleService({
  runner = new HttpNodeLifecycleRunner(),
  store = new JsonNodeLifecycleJobStore(),
}: {
  runner?: NodeLifecycleRunner;
  store?: NodeLifecycleJobStore;
} = {}): NodeLifecycleService {
  return {
    list: (nodeId) => store.list(nodeId),
    async run(input) {
      const targetHost = nodeLifecycleTargetHost(input.node);
      const now = new Date().toISOString();
      const job: NodeLifecycleJob = {
        action: input.action,
        id: `node_lifecycle_${randomUUID()}`,
        nodeAlias: input.node.alias,
        nodeId: input.node.id,
        requestedAt: now,
        requestedBy: input.requestedBy,
        startedAt: now,
        status: "running",
        targetHost,
      };

      await store.save(job);

      try {
        const result = await runner.run({
          action: input.action,
          node: input.node,
          options: input.options,
          targetHost,
        });
        const status = result.exitCode === 0 ? "succeeded" : "failed";
        const completed: NodeLifecycleJob = {
          ...job,
          completedAt: new Date().toISOString(),
          exitCode: result.exitCode,
          runnerRunId: result.runId,
          status,
          stderr: result.stderr,
          stdout: result.stdout,
          targetHost: result.targetHost ?? job.targetHost,
        };

        await store.save(completed);

        return completed;
      } catch (error) {
        const failed: NodeLifecycleJob = {
          ...job,
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "node_lifecycle_failed",
          status: "failed",
        };

        await store.save(failed);

        return failed;
      }
    },
  };
}

export function nodeLifecycleTargetHost(node: RecorderNode) {
  const host = node.ipAddresses.find((candidate) => candidate.trim()) ?? node.hostname;

  if (!host.trim()) {
    throw new Error("node_target_unavailable");
  }

  return host;
}

class HttpNodeLifecycleRunner implements NodeLifecycleRunner {
  private readonly runnerUrl = process.env.RAKKR_ANSIBLE_RUNNER_URL;
  private readonly token = process.env.RAKKR_ANSIBLE_RUNNER_TOKEN;

  async run(input: {
    action: NodeLifecycleAction;
    node: RecorderNode;
    options?: NodeLifecycleRunOptions;
    targetHost: string;
  }) {
    if (!this.runnerUrl) {
      throw new Error("ansible_runner_unconfigured");
    }

    const response = await fetch(`${this.runnerUrl.replace(/\/$/, "")}/runs`, {
      body: JSON.stringify({
        action: input.action,
        options: {
          agentVersion: input.options?.agentVersion,
          sshUser: input.options?.sshUser,
        },
        target: {
          host: input.targetHost,
          nodeAlias: input.node.alias,
          nodeId: input.node.id,
        },
      }),
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(runnerTimeoutMs()),
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: NodeLifecycleRunnerResult;
      error?: string;
    };

    if (!response.ok || !body.data) {
      throw new Error(body.error ?? `ansible_runner_${response.status}`);
    }

    return body.data;
  }
}

class JsonNodeLifecycleJobStore implements NodeLifecycleJobStore {
  private readonly jobs = loadLifecycleJobs();

  async list(nodeId?: string) {
    return this.jobs.filter((job) => !nodeId || job.nodeId === nodeId);
  }

  async save(job: NodeLifecycleJob) {
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);

    if (index >= 0) {
      this.jobs[index] = job;
    } else {
      this.jobs.unshift(job);
    }

    this.persist();
  }

  private persist() {
    mkdirSync(path.dirname(lifecycleStorePath), { recursive: true });
    const tempPath = `${lifecycleStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        jobs: this.jobs,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, lifecycleStorePath);
  }
}

const defaultNodeLifecycleService = createNodeLifecycleService();

export function nodeLifecycleService() {
  return defaultNodeLifecycleService;
}

function loadLifecycleJobs(): NodeLifecycleJob[] {
  if (!existsSync(lifecycleStorePath)) {
    return [];
  }

  const parsed: unknown = JSON.parse(readFileSync(lifecycleStorePath, "utf8"));
  const jobs = isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : parsed;

  return Array.isArray(jobs) ? jobs.filter(isNodeLifecycleJob) : [];
}

function isNodeLifecycleJob(value: unknown): value is NodeLifecycleJob {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.nodeAlias === "string" &&
    typeof value.requestedAt === "string" &&
    typeof value.requestedBy === "string" &&
    typeof value.targetHost === "string" &&
    nodeLifecycleActions.includes(value.action as NodeLifecycleAction) &&
    (value.status === "running" || value.status === "succeeded" || value.status === "failed")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runnerTimeoutMs() {
  const value = Number(process.env.RAKKR_ANSIBLE_RUNNER_TIMEOUT_MS);

  return Number.isInteger(value) && value > 0 ? value : 120_000;
}
