import { AlertTriangle, CheckCircle2, Gauge, ShieldAlert } from "lucide-react";
import type { HealthEvent, RecordingSummary } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatDuration } from "@/lib/dates";
import { qualityEventEvidenceText } from "@/lib/quality-timeline-helpers";
import { toneBadgeClass, toneFillClass } from "@/lib/status-colors";
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
          <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Gauge className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">Quality Timeline</h3>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(new Date(window.startMs))} /{" "}
              {formatDuration(Math.round((window.endMs - window.startMs) / 1000))}
            </p>
          </div>
        </div>
        <Badge className={timelineStatusClass(recording.healthStatus)} variant="outline">
          {activeEvents.length} active
        </Badge>
      </div>

      <div className="relative h-9 overflow-hidden rounded-md border border-border bg-emerald-100 dark:bg-emerald-950/40">
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,.7)_0,transparent_1px,transparent_20%,rgba(255,255,255,.65)_calc(20%+1px),transparent_calc(20%+2px),transparent_40%,rgba(255,255,255,.65)_calc(40%+1px),transparent_calc(40%+2px),transparent_60%,rgba(255,255,255,.65)_calc(60%+1px),transparent_calc(60%+2px),transparent_80%,rgba(255,255,255,.65)_calc(80%+1px),transparent_calc(80%+2px))]" />
        {segments.map((segment) => (
          <Tooltip key={segment.event.id}>
            <TooltipTrigger
              render={
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
              }
            />
            <TooltipContent>{timelineTitle(segment.event)}</TooltipContent>
          </Tooltip>
        ))}
        <div className="absolute right-2 bottom-1 rounded bg-card/80 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-card/70 dark:text-emerald-200">
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
          event.status === "resolved"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-600 dark:text-amber-400",
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
    return toneFillClass("healthy");
  }

  if (event.severity === "critical") {
    return toneFillClass("critical");
  }

  if (event.severity === "warning") {
    return toneFillClass("warning");
  }

  return toneFillClass("info");
}

function timelineStatusClass(status: RecordingSummary["healthStatus"]) {
  if (status === "critical") {
    return toneBadgeClass("critical");
  }

  if (status === "warning") {
    return toneBadgeClass("warning");
  }

  if (status === "healthy") {
    return toneBadgeClass("healthy");
  }

  return toneBadgeClass("neutral");
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
