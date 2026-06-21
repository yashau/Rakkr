import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HardDrive, Radio, ShieldCheck } from "lucide-react";

import { MeterBank } from "@/components/meter-bank";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { dashboardPagePermissions, dashboardSelectedNodeId } from "@/lib/dashboard-page-helpers";
import { formatDateTime } from "@/lib/dates";
import { nodeStatusBadgeClass } from "@/lib/node-status";

export function DashboardPage() {
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const pagePermissions = dashboardPagePermissions(currentUserQuery.data?.data);
  const statusQuery = useQuery({
    enabled: pagePermissions.canRead,
    queryFn: api.status,
    queryKey: ["status"],
    refetchInterval: 5000,
  });

  const nodesQuery = useQuery({
    enabled: pagePermissions.canRead,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
    refetchInterval: 5000,
  });

  const nodes = nodesQuery.data?.data ?? [];
  const visibleSelectedNodeId = dashboardSelectedNodeId(selectedNodeId, nodes);
  const node = nodes.find((candidate) => candidate.id === visibleSelectedNodeId);
  const meterQuery = useQuery({
    enabled: pagePermissions.canReadMeters && Boolean(visibleSelectedNodeId),
    queryFn: () => api.meterFrame(visibleSelectedNodeId),
    queryKey: ["meters", visibleSelectedNodeId],
    refetchInterval: 1000,
  });

  const status = statusQuery.data;
  const levels = meterQuery.data?.data.levels ?? [];

  useEffect(() => {
    if (visibleSelectedNodeId !== selectedNodeId) {
      setSelectedNodeId(visibleSelectedNodeId);
    }
  }, [selectedNodeId, visibleSelectedNodeId]);

  if (currentUserQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading dashboard.</p>;
  }

  if (!pagePermissions.canRead) {
    return (
      <Card className="rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Dashboard</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Dashboard is unavailable.</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Online nodes</p>
              <p className="mt-2 text-3xl font-semibold">
                {status?.onlineNodes ?? 0}/{status?.nodeCount ?? 0}
              </p>
            </div>
            <CheckCircle2 className="size-7 text-emerald-600" />
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Active recordings</p>
              <p className="mt-2 text-3xl font-semibold">{status?.activeRecordings ?? 0}</p>
            </div>
            <Radio className="size-7 text-teal-600" />
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Cached recordings</p>
              <p className="mt-2 text-3xl font-semibold">{status?.cachedRecordings ?? 0}</p>
            </div>
            <HardDrive className="size-7 text-zinc-700" />
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Critical alerts</p>
              <p className="mt-2 text-3xl font-semibold">{status?.criticalAlerts ?? 0}</p>
            </div>
            <AlertTriangle className="size-7 text-amber-600" />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <section className="grid gap-3">
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3 shadow-sm md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold">Meter Source</h2>
              <p className="text-xs text-muted-foreground">
                {nodes.length} visible recorder {nodes.length === 1 ? "node" : "nodes"}
              </p>
            </div>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm md:min-w-64"
              disabled={nodes.length === 0}
              onChange={(event) => setSelectedNodeId(event.target.value)}
              value={visibleSelectedNodeId}
            >
              {nodes.length === 0 ? <option value="">No visible nodes</option> : null}
              {nodes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.alias} / {candidate.location.room || candidate.hostname}
                </option>
              ))}
            </select>
          </div>

          <MeterBank levels={levels} title={node ? `${node.alias} Meters` : "Meters"} />
        </section>

        <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Node</h2>
              <p className="text-xs text-muted-foreground">{node?.location.room ?? "No node"}</p>
            </div>
            <Badge className={nodeStatusBadgeClass(node?.status)} variant="outline">
              {node?.status ?? "offline"}
            </Badge>
          </div>

          <dl className="grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Alias</dt>
              <dd className="font-medium">{node?.alias ?? "Unknown"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Address</dt>
              <dd className="font-mono text-xs">{node?.ipAddresses.join(", ") ?? "n/a"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Last seen</dt>
              <dd>{node ? formatDateTime(node.lastSeenAt) : "n/a"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Profile</dt>
              <dd>{status?.recordingProfile.name ?? "n/a"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Watchdog</dt>
              <dd>{status?.watchdogPolicy.name ?? "n/a"}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
