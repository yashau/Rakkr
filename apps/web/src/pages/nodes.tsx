import { useMutation, useQuery } from "@tanstack/react-query";
import { Cpu, Headphones, MapPin, Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

export function NodesPage() {
  const nodesQuery = useQuery({
    queryFn: api.nodes,
    queryKey: ["nodes"],
    refetchInterval: 5000,
  });
  const listenMutation = useMutation({
    mutationFn: api.startListen,
  });

  return (
    <div className="grid gap-4">
      {nodesQuery.data?.data.map((node) => (
        <Card className="rounded-lg p-4 shadow-sm" key={node.id}>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-lg font-semibold">{node.alias}</h2>
                <Badge
                  className="border-emerald-200 bg-emerald-50 text-emerald-700"
                  variant="outline"
                >
                  {node.status}
                </Badge>
              </div>
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <MapPin className="size-4" />
                  {node.location.site} / {node.location.room}
                </div>
                <div className="flex items-center gap-2">
                  <Network className="size-4" />
                  {node.hostname} / {node.ipAddresses.join(", ")}
                </div>
                <div className="flex items-center gap-2">
                  <Cpu className="size-4" />
                  Agent {node.agentVersion} / seen {formatDateTime(node.lastSeenAt)}
                </div>
              </div>
            </div>

            <div className="grid gap-3 text-sm md:min-w-72">
              <Button
                className="justify-self-start md:justify-self-end"
                disabled={listenMutation.isPending}
                onClick={() => listenMutation.mutate(node.id)}
                variant="outline"
              >
                <Headphones className="size-4" />
                Listen
              </Button>
              {node.interfaces.map((audioInterface) => (
                <div
                  className="rounded-md border border-stone-300 bg-stone-50 px-3 py-2"
                  key={audioInterface.id}
                >
                  <div className="font-medium">{audioInterface.alias}</div>
                  <div className="text-xs text-muted-foreground">
                    {audioInterface.channelCount} channels / {audioInterface.sampleRates.join(", ")}{" "}
                    Hz
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
