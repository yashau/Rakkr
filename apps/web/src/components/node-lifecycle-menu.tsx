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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  nodeLifecycleApi,
  type NodeLifecycleAction,
  type NodeLifecycleJob,
} from "@/lib/node-lifecycle-api";
import { toneBadgeClass } from "@/lib/status-colors";
import { toast } from "sonner";

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
    // Update Binary deploys the latest published release; the controller can still
    // pin a specific version via the lifecycle API when needed.
    mutationFn: (action: NodeLifecycleAction) => nodeLifecycleApi.run(node, action),
    onError: () => {
      toast.error("Lifecycle action failed");
    },
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="justify-self-start md:justify-self-end"
            disabled={runMutation.isPending}
            variant="outline"
          >
            <CheckCircle2 className="size-4" />
            Lifecycle
            <ChevronDown className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Lifecycle actions</DropdownMenuLabel>
        {lifecycleActions.map(({ action, icon: Icon, label }) => (
          <DropdownMenuItem
            disabled={runMutation.isPending}
            key={action}
            onSelect={() => runMutation.mutate(action)}
          >
            <Icon className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
        {latestJob ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <LifecycleJobBadge job={latestJob} />
            </div>
          </>
        ) : null}
        {runMutation.isError ? (
          <p className="px-2 py-1 text-xs text-destructive">Lifecycle action failed.</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
    return toneBadgeClass("healthy");
  }

  if (status === "failed") {
    return toneBadgeClass("critical");
  }

  return toneBadgeClass("info");
}
