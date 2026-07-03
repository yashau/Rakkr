import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { HealthEvent, RecorderNode } from "@rakkr/shared";
import {
  Activity,
  AudioLines,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  HardDrive,
  Headphones,
  KeyRound,
  Network,
  ShieldCheck,
  WifiOff,
} from "lucide-react";

import { FilterToolbar } from "@/components/filter-toolbar";
import { EnrollNodeDialog, NodeConfigureDialog } from "@/components/node-inventory-dialogs";
import {
  emptyNodeInventoryFilters,
  NodeInventoryFilters,
} from "@/components/node-inventory-filters";
import { NodeInventoryActions } from "@/components/node-inventory-actions";
import {
  healthBadgeClass,
  healthEventDetails,
  HealthSummaryTile,
  healthTone,
  NodeHealthTrend,
  nodeHealthSummary,
  readableHealthType,
} from "@/components/node-health";
import { NodeHealthEvents } from "@/components/node-health-events";
import { NodeLifecycleMenu } from "@/components/node-lifecycle-menu";
import { ListenMonitorPanel, type ListenMonitorPreview } from "@/components/listen-monitor-panel";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { MeterBank } from "@/components/meter-bank";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { api, type NodeFilters } from "@/lib/api";
import { formatDateTime, localDateBoundaryIso } from "@/lib/dates";
import { useDocumentTitle } from "@/lib/document-title";
import {
  nextNodeSelection,
  nodeFilterChips,
  nodeHealthLifecycleInput,
  nodeLocationSummary,
  nodePageActionPermissions,
  nodeRuntimeSummary,
  nodeSelectionState,
  rotateNodeTokenTitle,
  type NodeFilterKey,
  type NodeHealthLifecycleAction,
} from "@/lib/node-page-helpers";
import { nodeStatusBadgeClass } from "@/lib/node-status";
import { downloadBlob } from "@/lib/recording-page-helpers";
import { defaultPageSize } from "@/lib/server-pagination";
import { useServerPagination } from "@/lib/use-server-pagination";

const nodeFilterDraftKeys: Record<NodeFilterKey, keyof typeof emptyNodeInventoryFilters> = {
  backend: "backend",
  building: "building",
  floor: "floor",
  lastSeenFrom: "lastSeenFrom",
  lastSeenTo: "lastSeenTo",
  q: "search",
  room: "room",
  site: "site",
  status: "status",
};

export function NodesPage() {
  useDocumentTitle("Nodes");

  const queryClient = useQueryClient();
  const [nodeFilterDraft, setNodeFilterDraft] = useState(emptyNodeInventoryFilters);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [listenPreview, setListenPreview] = useState<ListenMonitorPreview>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = nodePageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const nodeFilters = useMemo(
    () =>
      ({
        backend: nodeFilterDraft.backend || undefined,
        building: nodeFilterDraft.building.trim() || undefined,
        floor: nodeFilterDraft.floor.trim() || undefined,
        lastSeenFrom: localDateBoundaryIso(nodeFilterDraft.lastSeenFrom, "start"),
        lastSeenTo: localDateBoundaryIso(nodeFilterDraft.lastSeenTo, "end"),
        q: nodeFilterDraft.search.trim() || undefined,
        room: nodeFilterDraft.room.trim() || undefined,
        site: nodeFilterDraft.site.trim() || undefined,
        status: nodeFilterDraft.status || undefined,
      }) satisfies NodeFilters,
    [nodeFilterDraft],
  );
  const pagination = useServerPagination(nodeFilters, { defaultPageSize });
  const nodesQuery = useQuery({
    enabled: actionPermissions.canRead,
    placeholderData: keepPreviousData,
    queryFn: () => api.nodes(pagination.query),
    queryKey: ["nodes", pagination.query],
    refetchInterval: 5000,
  });
  const healthEventsQuery = useQuery({
    enabled: actionPermissions.canReadHealth,
    queryFn: () => api.healthEvents({ limit: 500 }),
    queryKey: ["node-health-events"],
    refetchInterval: 5000,
  });
  const listenMutation = useMutation({
    mutationFn: async (node: { alias: string; id: string }) => {
      const session = await api.startListen(node.id);

      return {
        nodeAlias: node.alias,
        session: session.data,
      };
    },
    onError: () =>
      toast.error("Listen failed", {
        description: "A live listen session could not be started for the node.",
      }),
    onSuccess: ({ nodeAlias, session }) => {
      setListenPreview({ nodeAlias, session });
    },
  });
  const rotateMutation = useMutation({
    mutationFn: api.rotateNodeCredential,
    onError: () =>
      toast.error("Token rotation failed", {
        description: "The node credential token could not be rotated.",
      }),
    onSuccess: () => {
      toast.success("Token rotated", {
        description: "A fresh one-time node token has been issued.",
      });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });
  const healthLifecycleMutation = useMutation({
    mutationFn: ({
      action,
      eventId,
      suppressedUntil,
    }: {
      action: NodeHealthLifecycleAction;
      eventId: string;
      suppressedUntil?: string;
    }) => api.updateHealthEventLifecycle(eventId, action, { suppressedUntil }),
    onError: () =>
      toast.error("Update failed", {
        description: "The node health event could not be updated.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["node-health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const exportMutation = useMutation({
    mutationFn: () => api.nodesExport(nodeFilters),
    onError: () =>
      toast.error("Export failed", {
        description: "The node CSV export could not be generated.",
      }),
    onSuccess: downloadBlob,
  });
  const selectedExportMutation = useMutation({
    mutationFn: (nodeIds: string[]) => api.nodesExportSelected({ nodeIds }),
    onError: () =>
      toast.error("Export failed", {
        description: "The selected node CSV export could not be generated.",
      }),
    onSuccess: downloadBlob,
  });

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading nodes" />;
  }

  if (!actionPermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Nodes</AlertTitle>
        <AlertDescription>Node inventory is unavailable.</AlertDescription>
      </Alert>
    );
  }

  const nodes = nodesQuery.data?.data ?? [];
  const meta = nodesQuery.data?.meta;
  // The free-text search lives inline in the toolbar, so keep it out of the
  // slide-out chip set (which drives the "Filters" count badge).
  const advancedFilterChips = nodeFilterChips(nodeFilters).filter((chip) => chip.key !== "q");
  const selection = nodeSelectionState(nodes, selectedNodeIds);
  const healthEvents = healthEventsQuery.data?.data ?? [];
  const columns = nodeColumns({
    canManage: actionPermissions.canManage,
    onToggleSelected: (nodeId, selected) =>
      setSelectedNodeIds((current) => nextNodeSelection(current, nodeId, selected)),
    selectedNodeIds: selection.selectedVisibleNodeIds,
  });

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Network className="size-5 text-primary" />
              <h2 className="text-lg font-semibold">Recorder Nodes</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {meta?.total ?? nodes.length} matching nodes
            </p>
          </div>
          {actionPermissions.canManage ? <EnrollNodeDialog /> : null}
        </div>

        <div className="mt-4">
          <FilterToolbar
            actions={
              <Button
                disabled={exportMutation.isPending}
                onClick={() => exportMutation.mutate()}
                type="button"
                variant="outline"
              >
                <Download className="size-4" />
                Export CSV
              </Button>
            }
            chips={advancedFilterChips}
            onClearAll={() => setNodeFilterDraft(emptyNodeInventoryFilters)}
            onClearChip={(key) => clearNodeFilter(key as NodeFilterKey)}
            onSearchChange={(value) =>
              setNodeFilterDraft((current) => ({ ...current, search: value }))
            }
            search={nodeFilterDraft.search}
            searchPlaceholder="alias, room, IP, tag, serial"
            sheetDescription="Narrow the inventory by status, backend, location, and last-seen window."
            sheetTitle="Filter nodes"
          >
            <NodeInventoryFilters filters={nodeFilterDraft} onChange={setNodeFilterDraft} />
          </FilterToolbar>
        </div>

        <NodeInventoryActions
          allVisibleSelected={selection.allVisibleSelected}
          onClear={() => setSelectedNodeIds([])}
          onExportSelected={() => selectedExportMutation.mutate(selection.selectedVisibleNodeIds)}
          onSelectAll={(selected) => setSelectedNodeIds(selected ? selection.visibleNodeIds : [])}
          selectedCount={selection.selectedVisibleNodeIds.length}
          selectedExportPending={selectedExportMutation.isPending}
        />
      </section>

      {listenPreview ? (
        <ListenMonitorPanel
          onClose={() => setListenPreview(undefined)}
          onSessionChange={(session) =>
            setListenPreview((current) => (current ? { ...current, session } : current))
          }
          preview={listenPreview}
        />
      ) : null}

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={nodes}
          emptyMessage="No nodes match the current filters."
          getRowId={(node) => node.id}
          isLoading={nodesQuery.isPending}
          renderExpandedRow={(node) => (
            <NodeDetailRow
              canListen={actionPermissions.canListen}
              canManage={actionPermissions.canManage}
              canReadMeters={actionPermissions.canRead}
              healthEvents={healthEvents.filter((event) => event.nodeId === node.id)}
              listenPending={listenMutation.isPending}
              node={node}
              onAcknowledgeHealth={(eventId, action) =>
                healthLifecycleMutation.mutate(nodeHealthLifecycleInput(eventId, action))
              }
              onListen={() => listenMutation.mutate({ alias: node.alias, id: node.id })}
              onRotate={() => rotateMutation.mutate(node.id)}
              healthPending={healthLifecycleMutation.isPending}
              rotatePending={rotateMutation.isPending}
              canAcknowledgeHealth={actionPermissions.canAcknowledgeHealth}
            />
          )}
        />
        <DataTablePagination
          meta={meta}
          onNext={pagination.nextPage}
          onPageSizeChange={pagination.setPageSize}
          onPrevious={pagination.previousPage}
          pageSize={pagination.pageSize}
          pageSizes={pagination.pageSizes}
        />
      </section>
    </div>
  );

  function clearNodeFilter(key: NodeFilterKey) {
    setNodeFilterDraft((current) => ({ ...current, [nodeFilterDraftKeys[key]]: "" }));
  }
}

interface NodeColumnOptions {
  canManage: boolean;
  onToggleSelected: (nodeId: string, selected: boolean) => void;
  selectedNodeIds: string[];
}

function nodeColumns({
  canManage,
  onToggleSelected,
  selectedNodeIds,
}: NodeColumnOptions): ColumnDef<RecorderNode>[] {
  return [
    {
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select ${row.original.alias}`}
          checked={selectedNodeIds.includes(row.original.id)}
          onCheckedChange={(value) => onToggleSelected(row.original.id, value === true)}
        />
      ),
      header: () => <span className="sr-only">Select</span>,
      id: "select",
      meta: { cellClassName: "w-8", headClassName: "w-8" },
    },
    {
      cell: ({ row }) => {
        const expanded = row.getIsExpanded();

        return (
          <Button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} node details`}
            onClick={row.getToggleExpandedHandler()}
            size="icon"
            type="button"
            variant="ghost"
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        );
      },
      header: () => <span className="sr-only">Expand</span>,
      id: "expand",
      meta: { cellClassName: "w-8", headClassName: "w-8" },
    },
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium">{row.original.alias}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.hostname}</div>
        </div>
      ),
      header: "Alias",
      id: "alias",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {nodeLocationSummary(row.original.location)}
        </span>
      ),
      header: "Location",
      id: "location",
    },
    {
      cell: ({ row }) => (
        <Badge className={nodeStatusBadgeClass(row.original.status)} variant="outline">
          {row.original.status}
        </Badge>
      ),
      header: "Status",
      id: "status",
    },
    {
      cell: ({ row }) => <span className="text-sm">{nodeBackendSummary(row.original)}</span>,
      header: "Backend",
      id: "backend",
    },
    {
      cell: ({ row }) => (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {formatDateTime(row.original.lastSeenAt)}
        </span>
      ),
      header: "Last seen",
      id: "lastSeen",
    },
    {
      cell: ({ row }) => (
        <div className="text-xs text-muted-foreground">
          <div className="font-mono">{row.original.ipAddresses.join(", ") || "n/a"}</div>
          {nodeSerialNumbers(row.original).length > 0 ? (
            <div className="font-mono">{nodeSerialNumbers(row.original).join(", ")}</div>
          ) : null}
        </div>
      ),
      header: "IPs / serial",
      id: "network",
    },
    {
      cell: ({ row }) =>
        canManage ? (
          <div className="flex justify-end">
            <NodeConfigureDialog node={row.original} />
          </div>
        ) : null,
      header: "Actions",
      id: "actions",
      meta: { cellClassName: "text-right", headClassName: "text-right" },
    },
  ];
}

function NodeDetailRow({
  canAcknowledgeHealth,
  canListen,
  canManage,
  canReadMeters,
  healthEvents,
  healthPending,
  listenPending,
  node,
  onAcknowledgeHealth,
  onListen,
  onRotate,
  rotatePending,
}: {
  canAcknowledgeHealth: boolean;
  canListen: boolean;
  canManage: boolean;
  canReadMeters: boolean;
  healthEvents: HealthEvent[];
  healthPending: boolean;
  listenPending: boolean;
  node: RecorderNode;
  onAcknowledgeHealth: (eventId: string, action: NodeHealthLifecycleAction) => void;
  onListen: () => void;
  onRotate: () => void;
  rotatePending: boolean;
}) {
  const healthSummary = nodeHealthSummary(healthEvents);
  const meterQuery = useQuery({
    enabled: canReadMeters,
    queryFn: () => api.meterFrame(node.id),
    queryKey: ["meters", node.id],
    refetchInterval: 1000,
  });
  const meterLevels = meterQuery.data?.data.levels ?? [];

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Cpu className="size-4" />
            Agent {node.agentVersion} / seen {formatDateTime(node.lastSeenAt)}
          </div>
          {node.runtime ? (
            <div className="flex items-center gap-2">
              <HardDrive className="size-4" />
              {nodeRuntimeSummary(node.runtime)}
            </div>
          ) : null}
          <Badge className={healthBadgeClass(healthSummary.tone)} variant="outline">
            {healthSummary.label}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canListen ? (
            <Button disabled={listenPending} onClick={onListen} variant="outline">
              <Headphones className="size-4" />
              Listen
            </Button>
          ) : null}
          {canManage ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      disabled={rotatePending || !isUuid(node.id)}
                      onClick={onRotate}
                      variant="outline"
                    >
                      <KeyRound className="size-4" />
                      Rotate Token
                    </Button>
                  </span>
                }
              />
              <TooltipContent>{rotateNodeTokenTitle(canManage, isUuid(node.id))}</TooltipContent>
            </Tooltip>
          ) : null}
          <NodeLifecycleMenu canManage={canManage} node={node} />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {[
          {
            event: healthSummary.connectivity,
            icon: <WifiOff className="size-4" />,
            label: "Connectivity",
          },
          { event: healthSummary.disk, icon: <HardDrive className="size-4" />, label: "Disk" },
          { event: healthSummary.cpu, icon: <Activity className="size-4" />, label: "CPU" },
          { event: healthSummary.audio, icon: <AudioLines className="size-4" />, label: "Audio" },
        ].map((tile) => (
          <HealthSummaryTile
            event={tile.event}
            icon={tile.icon}
            key={tile.label}
            label={tile.label}
          />
        ))}
      </div>

      {canReadMeters ? <MeterBank levels={meterLevels} title={`${node.alias} Meters`} /> : null}

      <NodeHealthTrend events={healthEvents} />
      <NodeHealthEvents
        canManage={canAcknowledgeHealth}
        events={healthEvents}
        healthBadgeClass={healthBadgeClass}
        healthEventDetails={healthEventDetails}
        healthTone={healthTone}
        onAction={(event, action) => onAcknowledgeHealth(event.id, action)}
        pending={healthPending}
        readableHealthType={readableHealthType}
        renderDateTime={formatDateTime}
      />
    </div>
  );
}

function nodeBackendSummary(node: RecorderNode) {
  const backends = Array.from(
    new Set(node.interfaces.map((audioInterface) => audioInterface.backend)),
  );

  return backends.length > 0 ? backends.join(", ") : "n/a";
}

function nodeSerialNumbers(node: RecorderNode) {
  return node.interfaces
    .map((audioInterface) => audioInterface.serialNumber)
    .filter((serial): serial is string => Boolean(serial));
}

function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}
