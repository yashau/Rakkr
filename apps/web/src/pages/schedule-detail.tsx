import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  ClipboardList,
  FileAudio,
  HeartPulse,
  History,
} from "lucide-react";
import type { AuditEvent, HealthEvent, RecordingJob, RecordingSummary } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/dates";
import { occurrenceWindow, recurrenceSummary, timelineAction } from "@/lib/schedule-draft";

export function ScheduleDetailPage({ scheduleId }: { scheduleId: string }) {
  const schedulesQuery = useQuery({
    queryFn: api.schedules,
    queryKey: ["schedules"],
  });
  const recordingsQuery = useQuery({
    queryFn: () => api.recordings({ scheduleId }),
    queryKey: ["recordings", { scheduleId }],
    refetchInterval: 5000,
  });
  const jobsQuery = useQuery({
    queryFn: api.recordingJobs,
    queryKey: ["recording-jobs"],
    refetchInterval: 3000,
  });
  const healthQuery = useQuery({
    queryFn: () => api.healthEvents({ limit: 100, scheduleId }),
    queryKey: ["health-events", { scheduleId }],
    refetchInterval: 5000,
  });
  const auditQuery = useQuery({
    queryFn: () => api.auditEvents({ limit: 100, target: scheduleId }),
    queryKey: ["audit-events", "schedule-detail", scheduleId],
    refetchInterval: 5000,
  });
  const occurrencesQuery = useQuery({
    queryFn: () => api.scheduleOccurrences(scheduleId, 8),
    queryKey: ["schedule-occurrences", scheduleId],
    refetchInterval: 5000,
  });
  const nodesQuery = useQuery({
    queryFn: api.nodes,
    queryKey: ["nodes"],
  });

  const schedule = schedulesQuery.data?.data.find((candidate) => candidate.id === scheduleId);
  const recordings = useMemo(() => recordingsQuery.data?.data ?? [], [recordingsQuery.data?.data]);
  const recordingIds = useMemo(
    () => new Set(recordings.map((recording) => recording.id)),
    [recordings],
  );
  const jobs = useMemo(
    () => (jobsQuery.data?.data ?? []).filter((job) => recordingIds.has(job.recordingId)),
    [jobsQuery.data?.data, recordingIds],
  );
  const healthEvents = healthQuery.data?.data ?? [];
  const auditEvents = auditQuery.data?.data ?? [];
  const node = nodesQuery.data?.data.find((candidate) => candidate.id === schedule?.nodeId);

  if (schedulesQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading schedule.</p>;
  }

  if (!schedule) {
    return (
      <div className="grid gap-4">
        <Button asChild className="w-fit" variant="outline">
          <Link to="/schedules">
            <ArrowLeft className="size-4" />
            Schedules
          </Link>
        </Button>
        <Card className="rounded-lg p-4 shadow-sm">
          <p className="text-sm text-muted-foreground">Schedule not found.</p>
        </Card>
      </div>
    );
  }

  const summary = executionSummary(recordings, jobs, healthEvents);

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <Button asChild className="mb-3 w-fit" variant="outline">
            <Link to="/schedules">
              <ArrowLeft className="size-4" />
              Schedules
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <CalendarClock className="size-5 text-teal-700" />
            <h2 className="text-lg font-semibold">{schedule.name}</h2>
            <Badge variant={schedule.enabled ? "secondary" : "outline"}>
              {schedule.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {schedule.room} / {schedule.timezone} / {node?.alias ?? schedule.nodeId}
          </p>
          <p className="mt-2 text-sm">{recurrenceSummary(schedule.recurrence)}</p>
        </div>
        <div className="grid gap-1 text-sm text-muted-foreground md:text-right">
          <span className="font-medium text-foreground">Next Run</span>
          <span>{schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "Not scheduled"}</span>
          <span className="font-mono text-xs">{schedule.id}</span>
        </div>
      </div>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          icon={FileAudio}
          label="Recordings"
          value={String(recordings.length)}
          tone={summary.failedRecordings > 0 ? "critical" : "neutral"}
        />
        <SummaryTile
          icon={ClipboardList}
          label="Jobs"
          value={`${summary.activeJobs} active / ${jobs.length} total`}
          tone={summary.failedJobs > 0 ? "critical" : "neutral"}
        />
        <SummaryTile
          icon={HeartPulse}
          label="Health"
          value={`${summary.openHealthEvents} open / ${healthEvents.length} total`}
          tone={summary.criticalHealthEvents > 0 ? "critical" : "healthy"}
        />
        <SummaryTile
          icon={History}
          label="Timeline"
          value={`${auditEvents.length} events`}
          tone="neutral"
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={Activity} title="Upcoming Windows" />
          <ol className="mt-3 grid gap-3 border-l border-border pl-3 text-sm">
            {(occurrencesQuery.data?.data ?? []).map((occurrence) => (
              <li key={occurrence.recordingStartAt}>
                <div className="font-medium">{formatDateTime(occurrence.recordingStartAt)}</div>
                <div className="text-muted-foreground">{occurrenceWindow(occurrence)}</div>
              </li>
            ))}
            {occurrencesQuery.data?.data.length === 0 ? (
              <li className="text-muted-foreground">No upcoming windows.</li>
            ) : null}
          </ol>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={FileAudio} title="Recordings And Jobs" />
          <div className="mt-3 grid gap-3">
            {recordings.map((recording) => (
              <RecordingExecutionRow
                jobs={jobs.filter((job) => job.recordingId === recording.id)}
                key={recording.id}
                recording={recording}
              />
            ))}
            {!recordingsQuery.isPending && recordings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recordings are linked yet.</p>
            ) : null}
          </div>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={HeartPulse} title="Health Events" />
          <div className="mt-3 grid gap-3">
            {healthEvents.map((event) => (
              <HealthEventRow event={event} key={event.id} />
            ))}
            {!healthQuery.isPending && healthEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No health events are linked yet.</p>
            ) : null}
          </div>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={History} title="Audit Timeline" />
          <ol className="mt-3 grid gap-3 border-l border-border pl-3 text-sm">
            {auditEvents.map((event) => (
              <li key={event.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{timelineAction(event)}</span>
                  <Badge variant="outline">{event.outcome}</Badge>
                </div>
                <div className="text-muted-foreground">{auditEventLine(event)}</div>
              </li>
            ))}
            {!auditQuery.isPending && auditEvents.length === 0 ? (
              <li className="text-muted-foreground">No audit events are linked yet.</li>
            ) : null}
          </ol>
        </Card>
      </section>
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  tone,
  value,
}: {
  icon: typeof Activity;
  label: string;
  tone: "critical" | "healthy" | "neutral";
  value: string;
}) {
  const toneClass =
    tone === "critical"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : tone === "healthy"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-border bg-panel text-foreground";

  return (
    <section className={`rounded-lg border p-4 shadow-sm ${toneClass}`}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4" />
        {label}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
    </section>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-5 text-teal-700" />
      <h3 className="text-base font-semibold">{title}</h3>
    </div>
  );
}

function RecordingExecutionRow({
  jobs,
  recording,
}: {
  jobs: RecordingJob[];
  recording: RecordingSummary;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{recording.name}</span>
        <Badge className={healthStatusClass(recording.healthStatus)} variant="outline">
          {recording.healthStatus}
        </Badge>
        <Badge variant="secondary">{recording.status}</Badge>
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{formatDateTime(recording.recordedAt)}</span>
        <span>{formatDuration(recording.durationSeconds)}</span>
        <span>{recording.folder}</span>
      </div>
      <div className="mt-3 grid gap-2">
        {jobs.map((job) => (
          <div className="flex flex-wrap items-center gap-2 text-xs" key={job.id}>
            <Badge className={jobStatusClass(job.status)} variant="outline">
              {job.status}
            </Badge>
            <span className="font-mono break-all text-muted-foreground">{job.id}</span>
            <span className="text-muted-foreground">{job.claimedBy ?? job.nodeId}</span>
            {job.failureReason ? (
              <span className="text-destructive">{job.failureReason}</span>
            ) : null}
          </div>
        ))}
        {jobs.length === 0 ? <span className="text-xs text-muted-foreground">No jobs.</span> : null}
      </div>
    </div>
  );
}

function HealthEventRow({ event }: { event: HealthEvent }) {
  return (
    <div className="rounded-md border border-border bg-background p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={healthSeverityClass(event.severity)} variant="outline">
          {event.severity}
        </Badge>
        <span className="font-medium">{event.type}</span>
        <Badge variant={event.resolvedAt ? "secondary" : "outline"}>
          {event.resolvedAt ? "resolved" : "open"}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{formatDateTime(event.openedAt)}</span>
        {event.resolvedAt ? <span>Resolved {formatDateTime(event.resolvedAt)}</span> : null}
        {event.nodeId ? <span>{event.nodeId}</span> : null}
        {event.recordingId ? <span>{event.recordingId}</span> : null}
      </div>
    </div>
  );
}

function executionSummary(
  recordings: RecordingSummary[],
  jobs: RecordingJob[],
  healthEvents: HealthEvent[],
) {
  return {
    activeJobs: jobs.filter((job) => job.status === "queued" || job.status === "running").length,
    criticalHealthEvents: healthEvents.filter(
      (event) => event.severity === "critical" && !event.resolvedAt,
    ).length,
    failedJobs: jobs.filter((job) => job.status === "failed").length,
    failedRecordings: recordings.filter((recording) => recording.status === "failed").length,
    openHealthEvents: healthEvents.filter((event) => !event.resolvedAt).length,
  };
}

function auditEventLine(event: AuditEvent) {
  return `${formatDateTime(event.createdAt)} / ${event.actor.name}`;
}

function healthStatusClass(status: RecordingSummary["healthStatus"]) {
  if (status === "healthy") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "critical") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (status === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function healthSeverityClass(severity: HealthEvent["severity"]) {
  return severity === "critical"
    ? "border-rose-200 bg-rose-50 text-rose-700"
    : severity === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-sky-200 bg-sky-50 text-sky-700";
}

function jobStatusClass(status: RecordingJob["status"]) {
  if (status === "running") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "failed" || status === "cancelled") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (status === "stop_requested") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}
