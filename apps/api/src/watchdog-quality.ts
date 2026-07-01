import { randomUUID } from "node:crypto";
import type { AuditEvent, HealthEvent, RecordingSummary, WatchdogPolicy } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { RecordingStore } from "./recording-store.js";
import type { WatchdogRunResult } from "./watchdog-runner.js";
import {
  broadbandNoiseScoreThreshold,
  humScoreThreshold,
  minCumulativeQualitySeconds,
  noiseScoreThreshold,
  qualityAnomalyIsAbovePolicy,
  staticScoreThreshold,
  type SignalEvaluation,
} from "./watchdog-signal.js";

export const qualityAnomalyEventType = "watchdog.quality_anomaly";

export async function reconcileQualityAnomalyEvent({
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
  return qualityAnomalyIsAbovePolicy(evaluation, policy)
    ? writeQualityAnomalyEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      })
    : resolveQualityAnomalyEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      });
}

async function writeQualityAnomalyEvent({
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
  const existing = await activeQualityAnomalyEvent(healthEventStore, recording.id);
  const details = qualityAnomalyDetails(recording, policy, evaluation, now, existing);

  if (!existing) {
    const event = await healthEventStore.create({
      details,
      nodeId: recording.nodeId,
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
      severity: policy.severity,
      type: qualityAnomalyEventType,
    });

    await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.quality_anomaly.created",
      after: healthEventSnapshot(event),
      event,
      now,
      outcome: "succeeded",
      recording,
    });

    return qualityAnomalyResult(
      "alert_created",
      evaluation,
      recording,
      event.id,
      "quality_anomaly_detected",
    );
  }

  const repeatDue = shouldRepeat(existing, policy, now);
  const event = await healthEventStore.update(existing.id, {
    details,
    severity: policy.severity,
    status: existing.status,
  });

  if (!event) {
    return qualityAnomalyResult(
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
      action: "health.watchdog.quality_anomaly.repeated",
      after: healthEventSnapshot(event),
      before: healthEventSnapshot(existing),
      event,
      now,
      outcome: "succeeded",
      recording,
    });
  }

  return qualityAnomalyResult(
    repeatDue ? "alert_repeated" : "alert_updated",
    evaluation,
    recording,
    event.id,
    "quality_anomaly_detected",
  );
}

async function resolveQualityAnomalyEvent({
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
  const existing = await activeQualityAnomalyEvent(healthEventStore, recording.id);

  if (!existing) {
    return qualityAnomalyResult("healthy", evaluation, recording);
  }

  const resolved = await healthEventStore.updateLifecycle(existing.id, {
    details: {
      ...existing.details,
      autoResolvedAt: now.toISOString(),
      autoResolvedReason: "quality_anomaly_recovered",
      recoveryEvaluation: qualityAnomalyEvaluationDetails(policy, evaluation),
    },
    resolvedAt: now,
    resolvedBy: "system:watchdog",
    status: "resolved",
  });

  if (!resolved) {
    return qualityAnomalyResult(
      "skipped",
      evaluation,
      recording,
      undefined,
      "health_event_missing_during_resolve",
    );
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
  await appendWatchdogAudit(auditStore, {
    action: "health.watchdog.quality_anomaly.resolved",
    after: healthEventSnapshot(resolved),
    before: healthEventSnapshot(existing),
    event: resolved,
    now,
    outcome: "succeeded",
    recording,
  });

  return qualityAnomalyResult(
    "alert_resolved",
    evaluation,
    recording,
    resolved.id,
    "quality_anomaly_recovered",
  );
}

async function activeQualityAnomalyEvent(healthEventStore: HealthEventStore, recordingId: string) {
  // Filter by `type` in the query so the 500-row cap applies per-type, not across
  // all of the recording's events (which could hide the open one → duplicate).
  const events = await healthEventStore.list({
    limit: 500,
    recordingId,
    type: qualityAnomalyEventType,
  });

  return events.find((event) => event.status !== "resolved");
}

function qualityAnomalyDetails(
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
    ...qualityAnomalyEvaluationDetails(policy, evaluation),
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

function qualityAnomalyEvaluationDetails(policy: WatchdogPolicy, evaluation: SignalEvaluation) {
  return {
    broadbandNoiseScoreThreshold: broadbandNoiseScoreThreshold(policy),
    coverageSeconds: Number(evaluation.coverageSeconds.toFixed(1)),
    cumulativeHighBroadbandNoiseSeconds: Number(
      evaluation.cumulativeHighBroadbandNoiseSeconds.toFixed(1),
    ),
    cumulativeHighHumSeconds: Number(evaluation.cumulativeHighHumSeconds.toFixed(1)),
    cumulativeHighNoiseSeconds: Number(evaluation.cumulativeHighNoiseSeconds.toFixed(1)),
    cumulativeHighStaticSeconds: Number(evaluation.cumulativeHighStaticSeconds.toFixed(1)),
    humScoreThreshold: humScoreThreshold(policy),
    latestBroadbandNoiseScore: evaluation.latestBroadbandNoiseScore,
    latestHumScore: evaluation.latestHumScore,
    latestNoiseScore: evaluation.latestNoiseScore,
    latestStaticScore: evaluation.latestStaticScore,
    maxBroadbandNoiseScore: evaluation.maxBroadbandNoiseScore,
    maxHumScore: evaluation.maxHumScore,
    maxNoiseScore: evaluation.maxNoiseScore,
    maxStaticScore: evaluation.maxStaticScore,
    minCumulativeQualitySeconds: minCumulativeQualitySeconds(policy),
    noiseScoreThreshold: noiseScoreThreshold(policy),
    qualityAlertMode: policy.qualityAlertMode ?? "off",
    qualityAnomalyAboveThreshold: qualityAnomalyIsAbovePolicy(evaluation, policy),
    sampleCount: evaluation.sampleCount,
    staticScoreThreshold: staticScoreThreshold(policy),
    windowSeconds: policy.windowSeconds,
    windowStartedAt: evaluation.windowStartedAt,
  };
}

function qualityAnomalyResult(
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
  if (event.status === "suppressed" && event.suppressedUntil) {
    return Date.parse(event.suppressedUntil) <= now.getTime();
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
