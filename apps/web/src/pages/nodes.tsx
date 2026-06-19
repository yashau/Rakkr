import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HealthEvent, NodeRuntime, NodeStatus } from "@rakkr/shared";
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
  TrendingUp,
  WifiOff,
} from "lucide-react";

import { NodeIdentityEditor, NodeInterfaceEditor } from "@/components/node-inventory-editors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type NodeEnrollmentInput, type NodeEnrollmentResult } from "@/lib/api";
import { formatDateTime, localIsoDate, startOfLocalDay } from "@/lib/dates";
import { nodeStatusBadgeClass } from "@/lib/node-status";

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

const nodeStatuses: NodeStatus[] = ["online", "recording", "degraded", "alerting", "offline"];
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function NodesPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(emptyDraft);
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeStatusFilter, setNodeStatusFilter] = useState<"" | NodeStatus>("");
  const [credential, setCredential] = useState<NodeEnrollmentResult | undefined>();
  const [listenPreview, setListenPreview] = useState<{
    nodeAlias: string;
    sessionId: string;
    startedAt: string;
    url: string;
  }>();
  const nodesQuery = useQuery({
    queryFn: () =>
      api.nodes({
        q: nodeSearch.trim() || undefined,
        status: nodeStatusFilter || undefined,
      }),
    queryKey: ["nodes", nodeStatusFilter, nodeSearch],
    refetchInterval: 5000,
  });
  const healthEventsQuery = useQuery({
    queryFn: () => api.healthEvents({ limit: 500 }),
    queryKey: ["node-health-events"],
    refetchInterval: 5000,
  });
  const listenMutation = useMutation({
    mutationFn: async (node: { alias: string; id: string }) => {
      const session = await api.startListen(node.id);
      const stream = await api.listenStream(session.data.streamUrl);

      return {
        nodeAlias: node.alias,
        session: session.data,
        stream,
      };
    },
    onSuccess: ({ nodeAlias, session, stream }) => {
      const url = URL.createObjectURL(stream.blob);

      setListenPreview((current) => {
        if (current?.url) {
          URL.revokeObjectURL(current.url);
        }

        return {
          nodeAlias,
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          url,
        };
      });
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

  useEffect(
    () => () => {
      if (listenPreview?.url) {
        URL.revokeObjectURL(listenPreview.url);
      }
    },
    [listenPreview?.url],
  );

  const nodes = nodesQuery.data?.data ?? [];

  return (
    <div className="grid gap-4">
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
                onChange={(event) => setDraftValue(setDraft, "interfaceAlias", event.target.value)}
                placeholder="USB Audio"
                value={draft.interfaceAlias}
              />
            </Field>
            <Field label="Backend">
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) =>
                  setDraftValue(
                    setDraft,
                    "backend",
                    event.target.value as EnrollmentDraft["backend"],
                  )
                }
                value={draft.backend}
              >
                <option value="unknown">unknown</option>
                <option value="alsa">alsa</option>
                <option value="jack">jack</option>
                <option value="pipewire">pipewire</option>
              </select>
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

      {listenPreview ? (
        <section className="rounded-lg border border-border bg-panel px-4 py-3 shadow-sm">
          <div className="mb-2 text-sm font-medium">
            {listenPreview.nodeAlias} / {listenPreview.sessionId} /{" "}
            {formatDateTime(listenPreview.startedAt)}
          </div>
          <audio className="w-full" controls src={listenPreview.url}>
            <track kind="captions" />
          </audio>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-sm font-semibold">Recorder Nodes</h2>
            <p className="text-xs text-muted-foreground">{nodes.length} shown</p>
          </div>
          <div className="grid w-full gap-3 md:max-w-xl md:grid-cols-[minmax(0,1fr)_14rem]">
            <Field label="Search">
              <Input
                onChange={(event) => setNodeSearch(event.target.value)}
                placeholder="alias, room, IP, tag, serial"
                value={nodeSearch}
              />
            </Field>
            <Field label="Status">
              <select
                className={selectClassName}
                onChange={(event) => setNodeStatusFilter(event.target.value as "" | NodeStatus)}
                value={nodeStatusFilter}
              >
                <option value="">all statuses</option>
                {nodeStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      </section>

      {nodesQuery.isSuccess && nodes.length === 0 ? (
        <Card className="rounded-lg p-4 text-sm text-muted-foreground shadow-sm">
          No nodes match the current filters.
        </Card>
      ) : null}

      {nodes.map((node) => {
        const healthEvents = (healthEventsQuery.data?.data ?? []).filter(
          (event) => event.nodeId === node.id,
        );
        const healthSummary = nodeHealthSummary(healthEvents);

        return (
          <Card className="rounded-lg p-4 shadow-sm" key={node.id}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="grid flex-1 gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2">
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
                      {locationSummary(node.location)}
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
                        {runtimeSummary(node.runtime)}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  <HealthSummaryTile
                    event={healthSummary.connectivity}
                    icon={<WifiOff className="size-4" />}
                    label="Connectivity"
                  />
                  <HealthSummaryTile
                    event={healthSummary.disk}
                    icon={<HardDrive className="size-4" />}
                    label="Disk"
                  />
                  <HealthSummaryTile
                    event={healthSummary.cpu}
                    icon={<Activity className="size-4" />}
                    label="CPU"
                  />
                  <HealthSummaryTile
                    event={healthSummary.audio}
                    icon={<AudioLines className="size-4" />}
                    label="Audio"
                  />
                </div>

                <NodeHealthTrend events={healthEvents} />
                <NodeHealthEvents events={healthEvents} />
              </div>

              <div className="grid gap-3 text-sm md:min-w-72">
                <Button
                  className="justify-self-start md:justify-self-end"
                  disabled={listenMutation.isPending}
                  onClick={() => listenMutation.mutate({ alias: node.alias, id: node.id })}
                  variant="outline"
                >
                  <Headphones className="size-4" />
                  Listen
                </Button>
                <Button
                  className="justify-self-start md:justify-self-end"
                  disabled={rotateMutation.isPending || !isUuid(node.id)}
                  onClick={() => rotateMutation.mutate(node.id)}
                  title={
                    isUuid(node.id) ? "Rotate node token" : "Demo node tokens are not persisted"
                  }
                  variant="outline"
                >
                  <KeyRound className="size-4" />
                  Rotate Token
                </Button>
                <NodeIdentityEditor node={node} />
                {node.interfaces.map((audioInterface) => (
                  <NodeInterfaceEditor
                    audioInterface={audioInterface}
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

function locationSummary(location: {
  building?: string;
  floor?: string;
  room: string;
  site: string;
}) {
  return [location.site, location.building, location.floor, location.room]
    .filter(Boolean)
    .join(" / ");
}

function runtimeSummary(runtime: NodeRuntime) {
  return [
    runtime.osName,
    runtime.kernelRelease ? `kernel ${runtime.kernelRelease}` : undefined,
    runtime.architecture,
    runtime.audioBackends.length > 0 ? runtime.audioBackends.join(", ") : undefined,
    runtime.uptimeSeconds === undefined ? undefined : `uptime ${uptime(runtime.uptimeSeconds)}`,
  ]
    .filter(Boolean)
    .join(" / ");
}

function uptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  return `${hours}h`;
}

function HealthSummaryTile({
  event,
  icon,
  label,
}: {
  event: HealthEvent | undefined;
  icon: ReactNode;
  label: string;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {label}
        </div>
        <Badge className={healthBadgeClass(healthTone(event))} variant="outline">
          {healthLabel(event)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{healthDetail(event)}</p>
    </div>
  );
}

function NodeHealthEvents({ events }: { events: HealthEvent[] }) {
  const recentEvents = [...events]
    .sort((left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt))
    .slice(0, 3);
  const tone = recentEvents.reduce<"critical" | "healthy" | "unknown" | "warning">(
    (current, event) => highestTone(current, healthTone(event)),
    recentEvents.length > 0 ? "healthy" : "unknown",
  );

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Recent Health Events</div>
        <Badge className={healthBadgeClass(tone)} variant="outline">
          {recentEvents.length}
        </Badge>
      </div>
      {recentEvents.length > 0 ? (
        <div className="grid gap-2">
          {recentEvents.map((event) => (
            <div className="grid gap-1 text-xs" key={event.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={healthBadgeClass(healthTone(event))} variant="outline">
                  {event.severity}
                </Badge>
                <span className="font-medium">{readableHealthType(event.type)}</span>
                <span className="text-muted-foreground">{event.status}</span>
                <span className="text-muted-foreground">{formatDateTime(event.openedAt)}</span>
              </div>
              <div className="truncate text-muted-foreground">{healthEventDetails(event)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No node health events.</p>
      )}
    </div>
  );
}

function NodeHealthTrend({ events }: { events: HealthEvent[] }) {
  const buckets = healthTrendBuckets(events);
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const totalCount = buckets.reduce((total, bucket) => total + bucket.count, 0);
  const tone = buckets.reduce<HealthTone>(
    (current, bucket) => highestTone(current, bucket.tone),
    totalCount > 0 ? "healthy" : "unknown",
  );

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TrendingUp className="size-4" />
          7-Day Health Trend
        </div>
        <Badge className={healthBadgeClass(tone)} variant="outline">
          {totalCount} events
        </Badge>
      </div>
      <div className="grid gap-2 md:grid-cols-7">
        {buckets.map((bucket) => {
          const percent = bucket.count === 0 ? 0 : Math.max(8, (bucket.count / maxCount) * 100);

          return (
            <div
              className="grid gap-1 rounded-md border border-border bg-muted/20 p-2"
              key={bucket.date}
              title={`${bucket.date}: ${bucket.count} health events`}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium tabular-nums">{bucket.date}</span>
                <span className="text-muted-foreground tabular-nums">{bucket.count}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${healthBarClass(bucket.tone)}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function nodeHealthSummary(events: HealthEvent[]) {
  const connectivity = latestHealthEvent(events, ["watchdog.node_offline"]);
  const disk = latestHealthEvent(events, [
    "agent.system.disk_pressure",
    "agent.system.disk_recovered",
  ]);
  const cpu = latestHealthEvent(events, [
    "agent.system.cpu_pressure",
    "agent.system.cpu_recovered",
  ]);
  const audio = latestHealthEvent(events, [
    "agent.audio_backend.unavailable",
    "agent.audio_backend.recovered",
  ]);
  const tone = [connectivity, disk, cpu, audio].reduce<
    "critical" | "healthy" | "unknown" | "warning"
  >((current, event) => highestTone(current, healthTone(event)), "unknown");

  return {
    audio,
    connectivity,
    cpu,
    disk,
    label: healthSummaryLabel(tone),
    tone,
  };
}

type HealthTone = "critical" | "healthy" | "unknown" | "warning";

interface HealthTrendBucket {
  count: number;
  date: string;
  tone: HealthTone;
}

function healthTrendBuckets(events: HealthEvent[]) {
  const today = startOfLocalDay(new Date());
  const buckets: HealthTrendBucket[] = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));

    return {
      count: 0,
      date: localIsoDate(date),
      tone: "unknown",
    };
  });
  const bucketByDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));

  for (const event of events) {
    const eventDate = new Date(event.openedAt);

    if (Number.isNaN(eventDate.getTime())) {
      continue;
    }

    const bucket = bucketByDate.get(localIsoDate(eventDate));

    if (!bucket) {
      continue;
    }

    const eventTone = healthTone(event);
    bucket.tone = bucket.count === 0 ? eventTone : highestTone(bucket.tone, eventTone);
    bucket.count += 1;
  }

  return buckets;
}

function latestHealthEvent(events: HealthEvent[], types: string[]) {
  const candidates = events.filter((event) => types.includes(event.type));

  return candidates.sort(
    (left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt),
  )[0];
}

function healthTone(event: HealthEvent | undefined) {
  if (!event) {
    return "unknown";
  }

  if (event.status === "resolved") {
    return "healthy";
  }

  if (event.type.endsWith("_recovered") || event.severity === "info") {
    return "healthy";
  }

  return event.severity;
}

function highestTone(current: HealthTone, next: HealthTone) {
  const order = { critical: 3, warning: 2, unknown: 1, healthy: 0 };

  return order[next] > order[current] ? next : current;
}

function healthSummaryLabel(tone: HealthTone) {
  if (tone === "critical") {
    return "Critical";
  }

  if (tone === "warning") {
    return "Warning";
  }

  if (tone === "healthy") {
    return "Healthy";
  }

  return "No samples";
}

function healthLabel(event: HealthEvent | undefined) {
  return healthSummaryLabel(healthTone(event));
}

function healthDetail(event: HealthEvent | undefined) {
  if (!event) {
    return "Waiting for node sample";
  }

  const value = healthMetric(event);
  const observed = formatDateTime(event.openedAt);

  return value ? `${value} / ${observed}` : `${readableHealthType(event.type)} / ${observed}`;
}

function healthMetric(event: HealthEvent) {
  if (event.type === "watchdog.node_offline") {
    const offlineForSeconds = numericDetail(event.details.offlineForSeconds);

    if (offlineForSeconds !== undefined) {
      return `${durationLabel(offlineForSeconds)} offline`;
    }

    const lastSeenAt = stringDetail(event.details.lastSeenAt);

    return lastSeenAt ? `last seen ${formatDateTime(lastSeenAt)}` : undefined;
  }

  if (event.type.includes("disk")) {
    const usedPercent = numericDetail(event.details.usedPercent);

    return usedPercent === undefined ? undefined : `${usedPercent.toFixed(1)}% used`;
  }

  if (event.type.includes("cpu")) {
    const loadPerCore = numericDetail(event.details.loadPerCore);
    const loadAverage = numericDetail(event.details.loadAverageOneMinute);

    if (loadPerCore !== undefined) {
      return `${loadPerCore.toFixed(1)} load/core`;
    }

    return loadAverage === undefined ? undefined : `${loadAverage.toFixed(1)} load`;
  }

  if (event.type.includes("audio_backend")) {
    const interfaces = numericDetail(event.details.interfaces);

    return interfaces === undefined ? undefined : `${interfaces} interfaces`;
  }

  return undefined;
}

function healthEventDetails(event: HealthEvent) {
  const metric = healthMetric(event);

  if (metric) {
    return metric;
  }

  const reason = stringDetail(event.details.reason);
  const error = stringDetail(event.details.error);

  return reason ?? error ?? readableHealthType(event.type);
}

function readableHealthType(type: string) {
  if (type === "watchdog.node_offline") {
    return "node offline";
  }

  return type
    .replace(/^agent\./, "")
    .replaceAll("_", " ")
    .replaceAll(".", " ");
}

function durationLabel(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));

  if (safeSeconds >= 86_400) {
    const days = Math.floor(safeSeconds / 86_400);
    const hours = Math.floor((safeSeconds % 86_400) / 3600);

    return `${days}d ${hours}h`;
  }

  if (safeSeconds >= 3600) {
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);

    return `${hours}h ${minutes}m`;
  }

  if (safeSeconds >= 60) {
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;

    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${safeSeconds}s`;
}

function healthBadgeClass(tone: HealthTone) {
  if (tone === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (tone === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (tone === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function healthBarClass(tone: HealthTone) {
  if (tone === "critical") {
    return "bg-rose-500";
  }

  if (tone === "warning") {
    return "bg-amber-500";
  }

  if (tone === "healthy") {
    return "bg-emerald-500";
  }

  return "bg-slate-300";
}

function numericDetail(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringDetail(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}
