import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HardDrive, Radio } from "lucide-react";

import { MeterBank } from "@/components/meter-bank";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { nodeStatusBadgeClass } from "@/lib/node-status";

export function DashboardPage() {
  const statusQuery = useQuery({
    queryFn: api.status,
    queryKey: ["status"],
    refetchInterval: 5000,
  });

  const nodesQuery = useQuery({
    queryFn: api.nodes,
    queryKey: ["nodes"],
    refetchInterval: 5000,
  });

  const meterQuery = useQuery({
    enabled: Boolean(nodesQuery.data?.data[0]?.id),
    queryFn: () => api.meterFrame(nodesQuery.data!.data[0]!.id),
    queryKey: ["meters", nodesQuery.data?.data[0]?.id],
    refetchInterval: 1000,
  });

  const status = statusQuery.data;
  const node = nodesQuery.data?.data[0];
  const levels = meterQuery.data?.data.levels ?? [];

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
        <MeterBank levels={levels} title={node?.interfaces[0]?.alias ?? "Meters"} />

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
