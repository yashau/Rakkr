import { type Dispatch, type ReactNode, type SetStateAction, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AudioLines,
  Cpu,
  HardDrive,
  Headphones,
  KeyRound,
  MapPin,
  Network,
  PlusCircle,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react";

import {
  NodeAudioDefaultsEditor,
  NodeIdentityEditor,
  NodeInterfaceEditor,
} from "@/components/node-inventory-editors";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  api,
  type NodeEnrollmentInput,
  type NodeEnrollmentResult,
  type NodeFilters,
} from "@/lib/api";
import { formatDateTime, localDateBoundaryIso } from "@/lib/dates";
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

interface EnrollmentDraft {
  agentVersion: string;
  alias: string;
  backend: NodeEnrollmentInput["interfaces"][number]["backend"];
  building: string;
  channelCount: string;
  floor: string;
  hardwarePath: string;
  hostname: string;
  interfaceAlias: string;
  ipAddresses: string;
  notes: string;
  room: string;
  sampleRates: string;
  serialNumber: string;
  site: string;
  systemName: string;
  tags: string;
}

const emptyDraft: EnrollmentDraft = {
  agentVersion: "0.1.0",
  alias: "",
  backend: "unknown",
  building: "",
  channelCount: "0",
  floor: "",
  hardwarePath: "",
  hostname: "",
  interfaceAlias: "",
  ipAddresses: "",
  notes: "",
  room: "",
  sampleRates: "",
  serialNumber: "",
  site: "",
  systemName: "",
  tags: "",
};

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
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(emptyDraft);
  const [nodeFilterDraft, setNodeFilterDraft] = useState(emptyNodeInventoryFilters);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [credential, setCredential] = useState<NodeEnrollmentResult | undefined>();
  const [listenPreview, setListenPreview] = useState<ListenMonitorPreview>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = nodePageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const nodeFilters = {
    backend: nodeFilterDraft.backend || undefined,
    building: nodeFilterDraft.building.trim() || undefined,
    floor: nodeFilterDraft.floor.trim() || undefined,
    lastSeenFrom: localDateBoundaryIso(nodeFilterDraft.lastSeenFrom, "start"),
    lastSeenTo: localDateBoundaryIso(nodeFilterDraft.lastSeenTo, "end"),
    q: nodeFilterDraft.search.trim() || undefined,
    room: nodeFilterDraft.room.trim() || undefined,
    site: nodeFilterDraft.site.trim() || undefined,
    status: nodeFilterDraft.status || undefined,
  } satisfies NodeFilters;
  const nodesQuery = useQuery({
    enabled: actionPermissions.canRead,
    queryFn: () => api.nodes(nodeFilters),
    queryKey: ["nodes", nodeFilterDraft],
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
    onSuccess: ({ nodeAlias, session }) => {
      setListenPreview({ nodeAlias, session });
    },
  });
  const enrollMutation = useMutation({
    mutationFn: api.enrollNode,
    onSuccess: ({ data }) => {
      setCredential(data);
      setDraft(emptyDraft);
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    },
  });
  const rotateMutation = useMutation({
    mutationFn: api.rotateNodeCredential,
    onSuccess: ({ data }) => {
      setCredential(data);
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["node-health-events"] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const exportMutation = useMutation({
    mutationFn: () => api.nodesExport(nodeFilters),
    onSuccess: downloadBlob,
  });
  const selectedExportMutation = useMutation({
    mutationFn: (nodeIds: string[]) => api.nodesExportSelected({ nodeIds }),
    onSuccess: downloadBlob,
  });

  const nodes = nodesQuery.data?.data ?? [];
  const activeFilterChips = nodeFilterChips(nodeFilters);
  const selection = nodeSelectionState(nodes, selectedNodeIds);

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

  return (
    <div className="grid gap-4">
      {actionPermissions.canManage ? (
        <Card className="rounded-lg p-4 shadow-sm">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              enrollMutation.mutate(enrollmentInput(draft));
            }}
          >
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Enroll Recorder Node</h2>
                <p className="text-sm text-muted-foreground">Create a persisted node and token.</p>
              </div>
              <Button disabled={enrollMutation.isPending} type="submit">
                <PlusCircle className="size-4" />
                Enroll
              </Button>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Alias">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "alias", event.target.value)}
                  required
                  value={draft.alias}
                />
              </Field>
              <Field label="Hostname">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "hostname", event.target.value)}
                  required
                  value={draft.hostname}
                />
              </Field>
              <Field label="Agent Version">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "agentVersion", event.target.value)}
                  required
                  value={draft.agentVersion}
                />
              </Field>
              <Field label="Site">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "site", event.target.value)}
                  required
                  value={draft.site}
                />
              </Field>
              <Field label="Building">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "building", event.target.value)}
                  value={draft.building}
                />
              </Field>
              <Field label="Floor">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "floor", event.target.value)}
                  value={draft.floor}
                />
              </Field>
              <Field label="Room">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "room", event.target.value)}
                  required
                  value={draft.room}
                />
              </Field>
              <Field label="IP Addresses">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "ipAddresses", event.target.value)}
                  placeholder="10.0.0.25, 10.0.0.26"
                  value={draft.ipAddresses}
                />
              </Field>
              <Field label="Interface">
                <Input
                  onChange={(event) =>
                    setDraftValue(setDraft, "interfaceAlias", event.target.value)
                  }
                  placeholder="USB Audio"
                  value={draft.interfaceAlias}
                />
              </Field>
              <Field label="Backend">
                <Select
                  onValueChange={(value) =>
                    setDraftValue(setDraft, "backend", value as EnrollmentDraft["backend"])
                  }
                  value={draft.backend}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unknown">unknown</SelectItem>
                    <SelectItem value="alsa">alsa</SelectItem>
                    <SelectItem value="jack">jack</SelectItem>
                    <SelectItem value="pipewire">pipewire</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Channels">
                <Input
                  min={0}
                  onChange={(event) => setDraftValue(setDraft, "channelCount", event.target.value)}
                  type="number"
                  value={draft.channelCount}
                />
              </Field>
              <Field label="System Name">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "systemName", event.target.value)}
                  placeholder="Behringer X32 Rack USB"
                  value={draft.systemName}
                />
              </Field>
              <Field label="Hardware Path">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "hardwarePath", event.target.value)}
                  placeholder="/proc/asound/card1/pcm0c"
                  value={draft.hardwarePath}
                />
              </Field>
              <Field label="Serial Number">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "serialNumber", event.target.value)}
                  value={draft.serialNumber}
                />
              </Field>
              <Field label="Sample Rates">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "sampleRates", event.target.value)}
                  placeholder="48000, 44100"
                  value={draft.sampleRates}
                />
              </Field>
              <Field label="Tags">
                <Input
                  onChange={(event) => setDraftValue(setDraft, "tags", event.target.value)}
                  placeholder="voice, room-a"
                  value={draft.tags}
                />
              </Field>
            </div>

            <Field label="Notes">
              <Textarea
                onChange={(event) => setDraftValue(setDraft, "notes", event.target.value)}
                value={draft.notes}
              />
            </Field>

            {credential ? (
              <Field label="One-Time Node Token">
                <Textarea readOnly value={credential.credential.token} />
              </Field>
            ) : null}
            {enrollMutation.isError ? (
              <p className="text-sm text-destructive">Node enrollment failed.</p>
            ) : null}
          </form>
        </Card>
      ) : null}

      {listenPreview ? (
        <ListenMonitorPanel onClose={() => setListenPreview(undefined)} preview={listenPreview} />
      ) : null}

      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Recorder Nodes</h2>
            <p className="text-xs text-muted-foreground">{nodes.length} shown</p>
            <NodeInventoryActions
              allVisibleSelected={selection.allVisibleSelected}
              exportPending={exportMutation.isPending}
              onClear={() => setSelectedNodeIds([])}
              onExport={() => exportMutation.mutate()}
              onExportSelected={() =>
                selectedExportMutation.mutate(selection.selectedVisibleNodeIds)
              }
              onSelectAll={(selected) =>
                setSelectedNodeIds(selected ? selection.visibleNodeIds : [])
              }
              selectedCount={selection.selectedVisibleNodeIds.length}
              selectedExportPending={selectedExportMutation.isPending}
            />
          </div>
          <NodeInventoryFilters filters={nodeFilterDraft} onChange={setNodeFilterDraft} />
        </div>
        {activeFilterChips.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {activeFilterChips.map((filter) => (
              <Badge
                className="max-w-full gap-1 overflow-hidden bg-background pr-1"
                key={filter.key}
                variant="outline"
              >
                <span className="shrink-0 text-muted-foreground">{filter.label}</span>
                <span className="truncate font-mono">{filter.value}</span>
                <button
                  aria-label={`Clear ${filter.label} filter`}
                  className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => clearNodeFilter(filter.key)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : null}
      </section>

      {nodesQuery.isSuccess && nodes.length === 0 ? (
        <Alert>
          <AlertDescription>No nodes match the current filters.</AlertDescription>
        </Alert>
      ) : null}

      {nodes.map((node) => {
        const healthEvents = (healthEventsQuery.data?.data ?? []).filter(
          (event) => event.nodeId === node.id,
        );
        const healthSummary = nodeHealthSummary(healthEvents);

        return (
          <Card className="rounded-lg p-4 shadow-sm" key={node.id}>
            <div className="grid gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2">
                    <Checkbox
                      aria-label={`Select ${node.alias}`}
                      checked={selection.selectedVisibleNodeIds.includes(node.id)}
                      onCheckedChange={(value) =>
                        setSelectedNodeIds((current) =>
                          nextNodeSelection(current, node.id, value === true),
                        )
                      }
                    />
                    <h2 className="text-lg font-semibold">{node.alias}</h2>
                    <Badge className={nodeStatusBadgeClass(node.status)} variant="outline">
                      {node.status}
                    </Badge>
                    <Badge className={healthBadgeClass(healthSummary.tone)} variant="outline">
                      {healthSummary.label}
                    </Badge>
                  </div>
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <MapPin className="size-4" />
                      {nodeLocationSummary(node.location)}
                    </div>
                    <div className="flex items-center gap-2">
                      <Network className="size-4" />
                      {node.hostname} / {node.ipAddresses.join(", ")}
                    </div>
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
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {actionPermissions.canListen ? (
                    <Button
                      disabled={listenMutation.isPending}
                      onClick={() => listenMutation.mutate({ alias: node.alias, id: node.id })}
                      variant="outline"
                    >
                      <Headphones className="size-4" />
                      Listen
                    </Button>
                  ) : null}
                  {actionPermissions.canManage ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Button
                            disabled={rotateMutation.isPending || !isUuid(node.id)}
                            onClick={() => rotateMutation.mutate(node.id)}
                            variant="outline"
                          >
                            <KeyRound className="size-4" />
                            Rotate Token
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {rotateNodeTokenTitle(actionPermissions.canManage, isUuid(node.id))}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  <NodeLifecycleMenu canManage={actionPermissions.canManage} node={node} />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-4">
                {[
                  {
                    event: healthSummary.connectivity,
                    icon: <WifiOff className="size-4" />,
                    label: "Connectivity",
                  },
                  {
                    event: healthSummary.disk,
                    icon: <HardDrive className="size-4" />,
                    label: "Disk",
                  },
                  { event: healthSummary.cpu, icon: <Activity className="size-4" />, label: "CPU" },
                  {
                    event: healthSummary.audio,
                    icon: <AudioLines className="size-4" />,
                    label: "Audio",
                  },
                ].map((tile) => (
                  <HealthSummaryTile
                    event={tile.event}
                    icon={tile.icon}
                    key={tile.label}
                    label={tile.label}
                  />
                ))}
              </div>

              <NodeHealthTrend events={healthEvents} />
              <NodeHealthEvents
                canManage={actionPermissions.canAcknowledgeHealth}
                events={healthEvents}
                healthBadgeClass={healthBadgeClass}
                healthEventDetails={healthEventDetails}
                healthTone={healthTone}
                onAction={(event, action) =>
                  healthLifecycleMutation.mutate(nodeHealthLifecycleInput(event.id, action))
                }
                pending={healthLifecycleMutation.isPending}
                readableHealthType={readableHealthType}
                renderDateTime={formatDateTime}
              />

              <div className="grid gap-3 border-t border-border pt-3 text-sm">
                <NodeIdentityEditor canManage={actionPermissions.canManage} node={node} />
                <NodeAudioDefaultsEditor canManage={actionPermissions.canManage} node={node} />
                {node.interfaces.map((audioInterface) => (
                  <NodeInterfaceEditor
                    audioInterface={audioInterface}
                    canManage={actionPermissions.canManage}
                    key={audioInterface.id}
                    node={node}
                  />
                ))}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );

  function clearNodeFilter(key: NodeFilterKey) {
    setNodeFilterDraft((current) => ({ ...current, [nodeFilterDraftKeys[key]]: "" }));
  }
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function setDraftValue<Draft>(
  setDraft: Dispatch<SetStateAction<Draft>>,
  key: keyof Draft,
  value: Draft[keyof Draft],
) {
  setDraft((current) => ({ ...current, [key]: value }));
}

function enrollmentInput(draft: EnrollmentDraft): NodeEnrollmentInput {
  const channelCount = Number(draft.channelCount);
  const systemName = draft.systemName.trim();
  const interfaceAlias = draft.interfaceAlias.trim();
  const hasInterface = systemName || interfaceAlias || channelCount > 0;

  return {
    agentVersion: draft.agentVersion.trim(),
    alias: draft.alias.trim(),
    hostname: draft.hostname.trim(),
    interfaces: hasInterface
      ? [
          {
            alias: interfaceAlias || systemName || "Audio Interface",
            backend: draft.backend,
            channelCount: Number.isFinite(channelCount) ? Math.max(0, channelCount) : 0,
            channels: [],
            hardwarePath: draft.hardwarePath.trim() || undefined,
            sampleRates: parseNumbers(draft.sampleRates),
            serialNumber: draft.serialNumber.trim() || undefined,
            systemName: systemName || interfaceAlias || "Unknown Audio Interface",
          },
        ]
      : [],
    ipAddresses: parseList(draft.ipAddresses),
    location: {
      building: draft.building.trim() || undefined,
      floor: draft.floor.trim() || undefined,
      room: draft.room.trim(),
      site: draft.site.trim(),
    },
    notes: draft.notes.trim() || undefined,
    tags: parseList(draft.tags),
  };
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumbers(value: string) {
  return parseList(value)
    .map(Number)
    .filter((item) => Number.isInteger(item) && item > 0);
}

function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}
