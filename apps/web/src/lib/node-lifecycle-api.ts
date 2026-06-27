import type { RecorderNode } from "@rakkr/shared";
import { getAuthToken } from "@/lib/api";

export type NodeLifecycleAction =
  | "install_dependencies"
  | "restart_service"
  | "rotate_trust"
  | "smoke_check"
  | "update_binary";
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
  targetHost: string;
}

export interface NodeLifecycleInput {
  agentVersion?: string;
  sshUser?: string;
}

const apiBase = import.meta.env.VITE_API_BASE ?? "";

export const nodeLifecycleApi = {
  jobs: (nodeId: string) =>
    fetchNodeLifecycleJson<{ data: NodeLifecycleJob[] }>(`/api/v1/nodes/${nodeId}/lifecycle-jobs`),
  run: (node: Pick<RecorderNode, "id">, action: NodeLifecycleAction, input = {}) =>
    fetchNodeLifecycleJson<{ data: NodeLifecycleJob }>(
      `/api/v1/nodes/${node.id}/lifecycle/${action}`,
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
};

async function fetchNodeLifecycleJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}
