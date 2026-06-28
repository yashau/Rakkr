import { AlertTriangle, CheckCircle2, Gauge, ShieldAlert } from "lucide-react";
import type { HealthEvent, RecordingSummary } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatDuration } from "@/lib/dates";
import { qualityEventEvidenceText } from "@/lib/quality-timeline-helpers";
import { cn } from "@/lib/utils";

interface TimelineSegment {
  event: HealthEvent;
  left: number;
  right: number;
}

export function QualityTimeline({
  events,
  recording,
}: {
  events: HealthEvent[];
  recording: RecordingSummary;
}) {
  const window = timelineWindow(recording);
  const segments = eventSegments(events, window);
  const activeEvents = events.filter((event) => event.status !== "resolved");

  return (
    <section className="mt-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-teal-100 text-teal-700">
            <Gauge className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">Quality Timeline</h3>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(new Date(window.startMs).toISOString())} /{" "}
              {formatDuration(Math.round((window.endMs - window.startMs) / 1000))}
            </p>
          </div>
        </div>
        <Badge className={timelineStatusClass(recording.healthStatus)} variant="outline">
          {activeEvents.length} active
        </Badge>
      </div>

      <div className="relative h-9 overflow-hidden rounded-md border border-stone-300 bg-emerald-100">
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,.7)_0,transparent_1px,transparent_20%,rgba(255,255,255,.65)_calc(20%+1px),transparent_calc(20%+2px),transparent_40%,rgba(255,255,255,.65)_calc(40%+1px),transparent_calc(40%+2px),transparent_60%,rgba(255,255,255,.65)_calc(60%+1px),transparent_calc(60%+2px),transparent_80%,rgba(255,255,255,.65)_calc(80%+1px),transparent_calc(80%+2px))]" />
        {segments.map((segment) => (
          <Tooltip key={segment.event.id}>
            <TooltipTrigger asChild>
              <div
                aria-label={`${segment.event.severity} ${segment.event.type}`}
                className={cn(
                  "absolute top-0 bottom-0 min-w-1 border-x border-white/60",
                  timelineSegmentClass(segment.event),
                )}
                style={{
                  left: `${segment.left}%`,
                  width: `${Math.max(1, segment.right - segment.left)}%`,
                }}
              />
            </TooltipTrigger>
            <TooltipContent>{timelineTitle(segment.event)}</TooltipContent>
          </Tooltip>
        ))}
        <div className="absolute right-2 bottom-1 rounded bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
          healthy
        </div>
      </div>

      {events.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {events.slice(0, 4).map((event) => (
            <TimelineEventLine event={event} key={event.id} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No health events in this window.</p>
      )}
    </section>
  );
}

function TimelineEventLine({ event }: { event: HealthEvent }) {
  const evidence = qualityEventEvidenceText(event);
  const Icon =
    event.status === "resolved"
      ? CheckCircle2
      : event.severity === "critical"
        ? ShieldAlert
        : AlertTriangle;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Icon
        className={cn(
          "size-4",
          event.status === "resolved" ? "text-emerald-600" : "text-amber-600",
        )}
      />
      <Badge className={timelineSegmentClass(event)} variant="outline">
        {event.severity}
      </Badge>
      <span className="font-medium">{event.type}</span>
      <span className="text-muted-foreground">{event.status}</span>
      {evidence ? <span className="font-mono text-muted-foreground">{evidence}</span> : null}
    </div>
  );
}

function timelineWindow(recording: RecordingSummary) {
  const startMs = Date.parse(recording.recordedAt);
  const durationMs = recording.durationSeconds > 0 ? recording.durationSeconds * 1000 : 0;
  const minimumEndMs = startMs + Math.max(durationMs, 60_000);
  const endMs =
    recording.status === "recording" ? Math.max(minimumEndMs, Date.now()) : minimumEndMs;

  return {
    endMs,
    startMs,
  };
}

function eventSegments(events: HealthEvent[], window: { endMs: number; startMs: number }) {
  const totalMs = Math.max(window.endMs - window.startMs, 1);

  return events
    .map((event): TimelineSegment => {
      const startMs = clamp(
        Date.parse(stringDetail(event.details.firstObservedAt) ?? event.openedAt),
        window.startMs,
        window.endMs,
      );
      const endMs = clamp(
        Date.parse(
          event.resolvedAt ?? stringDetail(event.details.lastObservedAt) ?? event.openedAt,
        ),
        startMs + 1000,
        window.endMs,
      );

      return {
        event,
        left: ((startMs - window.startMs) / totalMs) * 100,
        right: ((endMs - window.startMs) / totalMs) * 100,
      };
    })
    .sort((left, right) => left.left - right.left);
}

function timelineTitle(event: HealthEvent) {
  const firstObservedAt = stringDetail(event.details.firstObservedAt) ?? event.openedAt;
  const lastObservedAt =
    stringDetail(event.details.lastObservedAt) ?? event.resolvedAt ?? event.openedAt;

  return `${event.type}: ${formatDateTime(firstObservedAt)} to ${formatDateTime(lastObservedAt)}`;
}

function timelineSegmentClass(event: HealthEvent) {
  if (event.status === "resolved") {
    return "border-emerald-200 bg-emerald-500/70 text-emerald-800";
  }

  if (event.severity === "critical") {
    return "border-rose-200 bg-rose-500/80 text-rose-800";
  }

  if (event.severity === "warning") {
    return "border-amber-200 bg-amber-400/80 text-amber-800";
  }

  return "border-sky-200 bg-sky-400/75 text-sky-800";
}

function timelineStatusClass(status: RecordingSummary["healthStatus"]) {
  if (status === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (status === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (status === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function stringDetail(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}
