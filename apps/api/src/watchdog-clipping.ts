import { randomUUID } from "node:crypto";
import type { AuditEvent, HealthEvent, RecordingSummary, WatchdogPolicy } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { RecordingStore } from "./recording-store.js";
import type { WatchdogRunResult } from "./watchdog-runner.js";
import {
  clippingIsAbovePolicy,
  minCumulativeClippingSeconds,
  type SignalEvaluation,
} from "./watchdog-signal.js";

export const clippingEventType = "watchdog.clipping";

export async function reconcileClippingEvent({
  auditStore,
  evaluation,
  healthEventStore,
  now,
  policy,
  recording,
  recordingStore,
}: {
  auditStore: AuditStore;
  evaluation: SignalEvaluation;
  healthEventStore: HealthEventStore;
  now: Date;
  policy: WatchdogPolicy;
  recording: RecordingSummary;
  recordingStore: RecordingStore;
}): Promise<WatchdogRunResult> {
  return clippingIsAbovePolicy(evaluation, policy)
    ? writeClippingEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      })
    : resolveClippingEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      });
}

async function writeClippingEvent({
  auditStore,
  evaluation,
  healthEventStore,
  now,
  policy,
  recording,
  recordingStore,
}: {
  auditStore: AuditStore;
  evaluation: SignalEvaluation;
  healthEventStore: HealthEventStore;
  now: Date;
  policy: WatchdogPolicy;
  recording: RecordingSummary;
  recordingStore: RecordingStore;
}): Promise<WatchdogRunResult> {
  const existing = await activeClippingEvent(healthEventStore, recording.id);
  const details = clippingDetails(recording, policy, evaluation, now, existing);

  if (!existing) {
    const event = await healthEventStore.create({
      details,
      nodeId: recording.nodeId,
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
      severity: policy.severity,
      type: clippingEventType,
    });

    await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.clipping.created",
      after: healthEventSnapshot(event),
      event,
      now,
      outcome: "succeeded",
      recording,
    });

    return clippingResult("alert_created", evaluation, recording, event.id, "clipping_detected");
  }

  const repeatDue = shouldRepeat(existing, policy, now);
  const event = await healthEventStore.update(existing.id, {
    details,
    severity: policy.severity,
    status: existing.status,
  });

  if (!event) {
    return clippingResult(
      "skipped",
      evaluation,
      recording,
      undefined,
      "health_event_missing_during_update",
    );
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);

  if (repeatDue) {
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.clipping.repeated",
      after: healthEventSnapshot(event),
      before: healthEventSnapshot(existing),
      event,
      now,
      outcome: "succeeded",
      recording,
    });
  }

  return clippingResult(
    repeatDue ? "alert_repeated" : "alert_updated",
    evaluation,
    recording,
    event.id,
    "clipping_detected",
  );
}

async function resolveClippingEvent({
  auditStore,
  evaluation,
  healthEventStore,
  now,
  policy,
  recording,
  recordingStore,
}: {
  auditStore: AuditStore;
  evaluation: SignalEvaluation;
  healthEventStore: HealthEventStore;
  now: Date;
  policy: WatchdogPolicy;
  recording: RecordingSummary;
  recordingStore: RecordingStore;
}): Promise<WatchdogRunResult> {
  const existing = await activeClippingEvent(healthEventStore, recording.id);

  if (!existing) {
    return clippingResult("healthy", evaluation, recording);
  }

  const resolved = await healthEventStore.updateLifecycle(existing.id, {
    details: {
      ...existing.details,
      autoResolvedAt: now.toISOString(),
      autoResolvedReason: "clipping_recovered",
      recoveryEvaluation: clippingEvaluationDetails(policy, evaluation),
    },
    resolvedAt: now,
    resolvedBy: "system:watchdog",
    status: "resolved",
  });

  if (!resolved) {
    return clippingResult(
      "skipped",
      evaluation,
      recording,
      undefined,
      "health_event_missing_during_resolve",
    );
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
  await appendWatchdogAudit(auditStore, {
    action: "health.watchdog.clipping.resolved",
    after: healthEventSnapshot(resolved),
    before: healthEventSnapshot(existing),
    event: resolved,
    now,
    outcome: "succeeded",
    recording,
  });

  return clippingResult("alert_resolved", evaluation, recording, resolved.id, "clipping_recovered");
}

async function activeClippingEvent(healthEventStore: HealthEventStore, recordingId: string) {
  const events = await healthEventStore.list({ limit: 500, recordingId });

  return events.find((event) => event.type === clippingEventType && event.status !== "resolved");
}

function clippingDetails(
  recording: RecordingSummary,
  policy: WatchdogPolicy,
  evaluation: SignalEvaluation,
  now: Date,
  existing?: HealthEvent,
) {
  const existingDetails = record(existing?.details) ?? {};
  const repeatDue = existing ? shouldRepeat(existing, policy, now) : false;
  const repeatCount = numberDetail(existingDetails.repeatCount) + (repeatDue ? 1 : 0);
  const evaluationCount = numberDetail(existingDetails.evaluationCount) + 1;
  const firstObservedAt =
    stringDetail(existingDetails.firstObservedAt) ?? existing?.openedAt ?? now.toISOString();
  const lastRepeatedAt = repeatDue
    ? now.toISOString()
    : (stringDetail(existingDetails.lastRepeatedAt) ?? existing?.openedAt);

  return {
    ...existingDetails,
    ...clippingEvaluationDetails(policy, evaluation),
    evaluationCount,
    firstObservedAt,
    lastObservedAt: now.toISOString(),
    lastRepeatedAt,
    nodeId: recording.nodeId,
    recordingId: recording.id,
    repeatCount,
    scheduleId: recording.scheduleId,
    watchdogPolicyId: policy.id,
    watchdogPolicyName: policy.name,
  };
}

function clippingEvaluationDetails(policy: WatchdogPolicy, evaluation: SignalEvaluation) {
  return {
    clippingAboveThreshold: clippingIsAbovePolicy(evaluation, policy),
    clippingMode: policy.clippingMode ?? "off",
    coverageSeconds: Number(evaluation.coverageSeconds.toFixed(1)),
    cumulativeClippingSeconds: Number(evaluation.cumulativeClippingSeconds.toFixed(1)),
    latestClippingChannelIndexes: evaluation.latestClippingChannelIndexes,
    maxClippingChannelCount: evaluation.maxClippingChannelCount,
    minCumulativeClippingSeconds: minCumulativeClippingSeconds(policy),
    sampleCount: evaluation.sampleCount,
    windowSeconds: policy.windowSeconds,
    windowStartedAt: evaluation.windowStartedAt,
  };
}

function clippingResult(
  outcome: WatchdogRunResult["outcome"],
  evaluation: SignalEvaluation,
  recording: RecordingSummary,
  eventId?: string,
  reason?: string,
): WatchdogRunResult {
  return {
    eventId,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    outcome,
    reason,
    recordingId: recording.id,
    scheduleId: recording.scheduleId,
  };
}

function shouldRepeat(event: HealthEvent, policy: WatchdogPolicy, now: Date) {
  if (event.status === "suppressed") {
    // Indefinite suppression (no expiry) never repeats; a finite window repeats
    // only once it has elapsed.
    return event.suppressedUntil ? Date.parse(event.suppressedUntil) <= now.getTime() : false;
  }

  const details = record(event.details) ?? {};
  const lastRepeatedAt = stringDetail(details.lastRepeatedAt) ?? event.openedAt;

  return now.getTime() - Date.parse(lastRepeatedAt) >= policy.repeatEverySeconds * 1_000;
}

async function appendWatchdogAudit(
  auditStore: AuditStore,
  input: {
    action: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
    event: HealthEvent;
    now: Date;
    outcome: AuditEvent["outcome"];
    recording: RecordingSummary;
  },
) {
  await auditStore.append({
    action: input.action,
    actor: {
      id: "system:watchdog",
      name: "Rakkr Watchdog",
      roles: [],
      type: "system",
    },
    actorContext: {},
    after: input.after,
    before: input.before,
    correlationIds: {
      healthEventId: input.event.id,
      nodeId: input.recording.nodeId ?? "",
      recordingId: input.recording.id,
      scheduleId: input.recording.scheduleId ?? "",
    },
    createdAt: input.now.toISOString(),
    details: {
      nodeId: input.recording.nodeId,
      recordingId: input.recording.id,
      scheduleId: input.recording.scheduleId,
    },
    id: `audit_${randomUUID()}`,
    outcome: input.outcome,
    permission: "health:acknowledge",
    target: {
      id: input.event.id,
      name: input.event.type,
      type: "health_event",
    },
  });
}

function healthEventSnapshot(event: HealthEvent) {
  return {
    acknowledgedAt: event.acknowledgedAt,
    acknowledgedBy: event.acknowledgedBy,
    details: event.details,
    nodeId: event.nodeId,
    recordingId: event.recordingId,
    resolvedAt: event.resolvedAt,
    resolvedBy: event.resolvedBy,
    scheduleId: event.scheduleId,
    severity: event.severity,
    status: event.status,
    suppressedAt: event.suppressedAt,
    suppressedBy: event.suppressedBy,
    suppressedUntil: event.suppressedUntil,
    type: event.type,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberDetail(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringDetail(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
