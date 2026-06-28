import { TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import type { HealthEvent } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, localIsoDate, startOfLocalDay } from "@/lib/dates";
import { toneBadgeClass } from "@/lib/status-colors";

export function HealthSummaryTile({
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

export function NodeHealthTrend({ events }: { events: HealthEvent[] }) {
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
            <Tooltip key={bucket.date}>
              <TooltipTrigger asChild>
                <div className="grid gap-1 rounded-md border border-border bg-muted/20 p-2">
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
              </TooltipTrigger>
              <TooltipContent>{`${bucket.date}: ${bucket.count} health events`}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

export function nodeHealthSummary(events: HealthEvent[]) {
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

export type HealthTone = "critical" | "healthy" | "unknown" | "warning";

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

export function healthTone(event: HealthEvent | undefined) {
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

export function healthEventDetails(event: HealthEvent) {
  const metric = healthMetric(event);

  if (metric) {
    return metric;
  }

  const reason = stringDetail(event.details.reason);
  const error = stringDetail(event.details.error);

  return reason ?? error ?? readableHealthType(event.type);
}

export function readableHealthType(type: string) {
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

export function healthBadgeClass(tone: HealthTone) {
  return toneBadgeClass(tone === "unknown" ? "neutral" : tone);
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
