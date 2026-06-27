import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecorderNode } from "@rakkr/shared";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  PackagePlus,
  Play,
  RotateCw,
  Shield,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  nodeLifecycleApi,
  type NodeLifecycleAction,
  type NodeLifecycleJob,
} from "@/lib/node-lifecycle-api";

interface NodeLifecycleMenuProps {
  canManage: boolean;
  node: RecorderNode;
}

const lifecycleActions: Array<{
  action: NodeLifecycleAction;
  icon: typeof PackagePlus;
  label: string;
}> = [
  { action: "install_dependencies", icon: PackagePlus, label: "Install Deps" },
  { action: "update_binary", icon: Download, label: "Update Binary" },
  { action: "restart_service", icon: RotateCw, label: "Restart Service" },
  { action: "rotate_trust", icon: Shield, label: "Rotate Trust" },
  { action: "smoke_check", icon: Play, label: "Smoke Check" },
];

export function NodeLifecycleMenu({ canManage, node }: NodeLifecycleMenuProps) {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    enabled: canManage,
    queryFn: () => nodeLifecycleApi.jobs(node.id),
    queryKey: ["nodes", node.id, "lifecycle-jobs"],
    refetchInterval: 5000,
  });
  const runMutation = useMutation({
    mutationFn: (action: NodeLifecycleAction) =>
      nodeLifecycleApi.run(node, action, { agentVersion: node.agentVersion }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["nodes", node.id, "lifecycle-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  if (!canManage) {
    return null;
  }

  const latestJob = jobsQuery.data?.data[0];

  return (
    <details className="justify-self-start md:justify-self-end">
      <summary aria-label="Node lifecycle actions" className="list-none">
        <Button asChild disabled={runMutation.isPending} variant="outline">
          <span>
            <CheckCircle2 className="size-4" />
            Lifecycle
            <ChevronDown className="size-4" />
          </span>
        </Button>
      </summary>
      <div className="mt-2 grid w-56 gap-2 rounded-md border border-border bg-background p-2 shadow-sm">
        {lifecycleActions.map(({ action, icon: Icon, label }) => (
          <Button
            className="justify-start"
            disabled={runMutation.isPending}
            key={action}
            onClick={() => runMutation.mutate(action)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Icon className="size-4" />
            {label}
          </Button>
        ))}
        {latestJob ? <LifecycleJobBadge job={latestJob} /> : null}
        {runMutation.isError ? (
          <p className="px-2 text-xs text-destructive">Lifecycle action failed.</p>
        ) : null}
      </div>
    </details>
  );
}

function LifecycleJobBadge({ job }: { job: NodeLifecycleJob }) {
  return (
    <Badge className={lifecycleStatusClass(job.status)} variant="outline">
      {job.action.replaceAll("_", " ")} / {job.status}
    </Badge>
  );
}

function lifecycleStatusClass(status: NodeLifecycleJob["status"]) {
  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  return "border-sky-200 bg-sky-50 text-sky-700";
}
