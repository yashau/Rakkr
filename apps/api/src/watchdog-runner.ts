import { randomUUID } from "node:crypto";
import {
  defaultScheduledVoiceWatchdogPolicy,
  type AuditEvent,
  type HealthEvent,
  type MeterFrame,
  type RecordingSummary,
  type WatchdogPolicy,
} from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import { buildMeterFrame, demoMetersEnabled } from "./demo-data.js";
import type { HealthEventStore } from "./health-store.js";
import type { NodeStore } from "./node-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { RecordingStore } from "./recording-store.js";
import { reconcileClippingEvent } from "./watchdog-clipping.js";
import { reconcileFlatlineEvent } from "./watchdog-flatline.js";
import { nodeOfflineEventType, reconcileNodeLivenessEvents } from "./watchdog-node-liveness.js";
import { reconcileQualityAnomalyEvent } from "./watchdog-quality.js";
import {
  channelCorrelationIsAbovePolicy,
  channelCorrelationThreshold,
  historyFor,
  minCumulativeChannelCorrelationSeconds,
  minCumulativeSpeechSeconds,
  minSpeechScore,
  pruneHistory,
  pruneInactiveHistories,
  signalEvaluation,
  signalIsBelowPolicy,
  signalLevelIsBelowPolicy,
  signalSample,
  speechIsBelowPolicy,
  type SignalEvaluation,
  type SignalHistory,
} from "./watchdog-signal.js";

export const scheduledLowSignalEventType = "watchdog.scheduled_low_signal";
export const channelCorrelationEventType = "watchdog.channel_correlation";
export { clippingEventType } from "./watchdog-clipping.js";
export { flatlineEventType } from "./watchdog-flatline.js";
export { nodeOfflineEventType };
export { qualityAnomalyEventType } from "./watchdog-quality.js";

export type MeterFrameProvider = (
  nodeId: string,
  now: Date,
) => MaybePromise<MeterFrame | undefined>;

export interface WatchdogRunnerDependencies {
  auditStore: AuditStore;
  healthEventStore: HealthEventStore;
  meterFrameProvider?: MeterFrameProvider;
  nodeStore?: Pick<NodeStore, "list">;
  policies?: WatchdogPolicy[];
  recordingStore: RecordingStore;
}

export interface WatchdogRunResult {
  eventId?: string;
  maxMetricDbfs?: number;
  nodeId?: string;
  outcome:
    | "alert_created"
    | "alert_repeated"
    | "alert_resolved"
    | "alert_updated"
    | "healthy"
    | "pending"
    | "skipped";
  reason?: string;
  recordingId?: string;
  scheduleId?: string;
}

type MaybePromise<T> = Promise<T> | T;

export function createWatchdogRunner(dependencies: WatchdogRunnerDependencies) {
  const histories = new Map<string, SignalHistory>();
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(now = new Date()) {
    if (running) {
      return [];
    }

    running = true;

    try {
      return await runWatchdogPass(dependencies, histories, now);
    } finally {
      running = false;
    }
  }

  return {
    async runOnce(now = new Date()) {
      return tick(now);
    },
    start(intervalMs = watchdogRunnerIntervalMs()) {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

async function runWatchdogPass(
  {
    auditStore,
    healthEventStore,
    meterFrameProvider = defaultMeterFrameProvider,
    nodeStore,
    policies = [defaultScheduledVoiceWatchdogPolicy],
    recordingStore,
  }: WatchdogRunnerDependencies,
  histories: Map<string, SignalHistory>,
  now = new Date(),
): Promise<WatchdogRunResult[]> {
  const policyById = new Map(policies.map((policy) => [policy.id, policy]));
  const recordings = await recordingStore.list();
  const activeRecordingIds = new Set<string>();
  const results: WatchdogRunResult[] = [];

  for (const recording of recordings) {
    const policy = policyById.get(recording.watchdogPolicyId ?? "");

    if (!policy || !watchdogApplies(policy, recording)) {
      results.push({
        outcome: "skipped",
        reason: policy ? "watchdog_policy_not_active_for_recording" : "watchdog_policy_not_found",
        recordingId: recording.id,
        scheduleId: recording.scheduleId,
      });
      continue;
    }

    activeRecordingIds.add(recording.id);

    const frame = recording.nodeId ? await meterFrameProvider(recording.nodeId, now) : undefined;
    const history = historyFor(histories, recording.id);
    const sample = signalSample(frame, policy, history.lastSampleAtMs, now);

    history.samples.push(sample);
    history.lastSampleAtMs = now.getTime();
    pruneHistory(history, policy, now);

    const readyAtMs =
      Date.parse(recording.recordedAt) + (policy.graceSeconds + policy.windowSeconds) * 1_000;

    if (now.getTime() < readyAtMs) {
      results.push({
        maxMetricDbfs: sample.metricDbfs,
        outcome: "pending",
        reason: "watchdog_window_not_elapsed",
        recordingId: recording.id,
        scheduleId: recording.scheduleId,
      });
      continue;
    }

    const evaluation = signalEvaluation(history, policy, now);
    const lowSignal = signalIsBelowPolicy(evaluation, policy);
    const highChannelCorrelation = channelCorrelationIsAbovePolicy(evaluation, policy);

    results.push(
      lowSignal
        ? await writeLowSignalEvent({
            auditStore,
            evaluation,
            healthEventStore,
            now,
            policy,
            recording,
            recordingStore,
          })
        : await resolveLowSignalEvent({
            auditStore,
            evaluation,
            healthEventStore,
            now,
            policy,
            recording,
            recordingStore,
          }),
    );

    results.push(
      highChannelCorrelation
        ? await writeChannelCorrelationEvent({
            auditStore,
            evaluation,
            healthEventStore,
            now,
            policy,
            recording,
            recordingStore,
          })
        : await resolveChannelCorrelationEvent({
            auditStore,
            evaluation,
            healthEventStore,
            now,
            policy,
            recording,
            recordingStore,
          }),
    );

    results.push(
      await reconcileClippingEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      }),
    );

    results.push(
      await reconcileFlatlineEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      }),
    );

    results.push(
      await reconcileQualityAnomalyEvent({
        auditStore,
        evaluation,
        healthEventStore,
        now,
        policy,
        recording,
        recordingStore,
      }),
    );
  }

  pruneInactiveHistories(histories, activeRecordingIds);

  if (nodeStore) {
    results.push(
      ...(await reconcileNodeLivenessEvents({
        auditStore,
        healthEventStore,
        nodes: await nodeStore.list(),
        now,
      })),
    );
  }

  return results;
}

async function writeLowSignalEvent({
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
  const existing = await activeLowSignalEvent(healthEventStore, recording.id);
  const details = lowSignalDetails(recording, policy, evaluation, now, existing);

  if (!existing) {
    const event = await healthEventStore.create({
      details,
      nodeId: recording.nodeId,
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
      severity: policy.severity,
      type: scheduledLowSignalEventType,
    });

    await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.low_signal.created",
      after: healthEventSnapshot(event),
      event,
      now,
      outcome: "succeeded",
      recording,
    });

    return {
      eventId: event.id,
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "alert_created",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  const repeatDue = shouldRepeat(existing, policy, now);
  const event = await healthEventStore.update(existing.id, {
    details,
    severity: policy.severity,
    status: existing.status,
  });

  if (!event) {
    return {
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "skipped",
      reason: "health_event_missing_during_update",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);

  if (repeatDue) {
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.low_signal.repeated",
      after: healthEventSnapshot(event),
      before: healthEventSnapshot(existing),
      event,
      now,
      outcome: "succeeded",
      recording,
    });
  }

  return {
    eventId: event.id,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    outcome: repeatDue ? "alert_repeated" : "alert_updated",
    recordingId: recording.id,
    scheduleId: recording.scheduleId,
  };
}

async function resolveLowSignalEvent({
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
  const existing = await activeLowSignalEvent(healthEventStore, recording.id);

  if (!existing) {
    return {
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "healthy",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  const resolved = await healthEventStore.updateLifecycle(existing.id, {
    details: {
      ...existing.details,
      autoResolvedAt: now.toISOString(),
      autoResolvedReason: "signal_above_threshold",
      recoveryEvaluation: evaluationDetails(policy, evaluation),
    },
    resolvedAt: now,
    resolvedBy: "system:watchdog",
    status: "resolved",
  });

  if (!resolved) {
    return {
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "skipped",
      reason: "health_event_missing_during_resolve",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
  await appendWatchdogAudit(auditStore, {
    action: "health.watchdog.low_signal.resolved",
    after: healthEventSnapshot(resolved),
    before: healthEventSnapshot(existing),
    event: resolved,
    now,
    outcome: "succeeded",
    recording,
  });

  return {
    eventId: resolved.id,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    outcome: "alert_resolved",
    recordingId: recording.id,
    scheduleId: recording.scheduleId,
  };
}

async function writeChannelCorrelationEvent({
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
  const existing = await activeChannelCorrelationEvent(healthEventStore, recording.id);
  const details = channelCorrelationDetails(recording, policy, evaluation, now, existing);

  if (!existing) {
    const event = await healthEventStore.create({
      details,
      nodeId: recording.nodeId,
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
      severity: policy.severity,
      type: channelCorrelationEventType,
    });

    await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.channel_correlation.created",
      after: healthEventSnapshot(event),
      event,
      now,
      outcome: "succeeded",
      recording,
    });

    return {
      eventId: event.id,
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "alert_created",
      reason: "channel_correlation_above_threshold",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  const repeatDue = shouldRepeat(existing, policy, now);
  const event = await healthEventStore.update(existing.id, {
    details,
    severity: policy.severity,
    status: existing.status,
  });

  if (!event) {
    return {
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "skipped",
      reason: "health_event_missing_during_update",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);

  if (repeatDue) {
    await appendWatchdogAudit(auditStore, {
      action: "health.watchdog.channel_correlation.repeated",
      after: healthEventSnapshot(event),
      before: healthEventSnapshot(existing),
      event,
      now,
      outcome: "succeeded",
      recording,
    });
  }

  return {
    eventId: event.id,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    outcome: repeatDue ? "alert_repeated" : "alert_updated",
    reason: "channel_correlation_above_threshold",
    recordingId: recording.id,
    scheduleId: recording.scheduleId,
  };
}

async function resolveChannelCorrelationEvent({
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
  const existing = await activeChannelCorrelationEvent(healthEventStore, recording.id);

  if (!existing) {
    return {
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "healthy",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  const resolved = await healthEventStore.updateLifecycle(existing.id, {
    details: {
      ...existing.details,
      autoResolvedAt: now.toISOString(),
      autoResolvedReason: "channel_correlation_below_threshold",
      recoveryEvaluation: channelCorrelationEvaluationDetails(policy, evaluation),
    },
    resolvedAt: now,
    resolvedBy: "system:watchdog",
    status: "resolved",
  });

  if (!resolved) {
    return {
      maxMetricDbfs: evaluation.maxMetricDbfs,
      outcome: "skipped",
      reason: "health_event_missing_during_resolve",
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
    };
  }

  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
  await appendWatchdogAudit(auditStore, {
    action: "health.watchdog.channel_correlation.resolved",
    after: healthEventSnapshot(resolved),
    before: healthEventSnapshot(existing),
    event: resolved,
    now,
    outcome: "succeeded",
    recording,
  });

  return {
    eventId: resolved.id,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    outcome: "alert_resolved",
    reason: "channel_correlation_below_threshold",
    recordingId: recording.id,
    scheduleId: recording.scheduleId,
  };
}

async function activeLowSignalEvent(healthEventStore: HealthEventStore, recordingId: string) {
  const events = await healthEventStore.list({ limit: 500, recordingId });

  return events.find(
    (event) => event.type === scheduledLowSignalEventType && event.status !== "resolved",
  );
}

async function activeChannelCorrelationEvent(
  healthEventStore: HealthEventStore,
  recordingId: string,
) {
  const events = await healthEventStore.list({ limit: 500, recordingId });

  return events.find(
    (event) => event.type === channelCorrelationEventType && event.status !== "resolved",
  );
}

function lowSignalDetails(
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
    ...evaluationDetails(policy, evaluation),
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

function channelCorrelationDetails(
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
    ...channelCorrelationEvaluationDetails(policy, evaluation),
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

function evaluationDetails(policy: WatchdogPolicy, evaluation: SignalEvaluation) {
  return {
    coverageSeconds: Number(evaluation.coverageSeconds.toFixed(1)),
    cumulativeSecondsAboveThreshold: Number(evaluation.cumulativeSecondsAboveThreshold.toFixed(1)),
    cumulativeSpeechLikeSeconds: Number(evaluation.cumulativeSpeechLikeSeconds.toFixed(1)),
    latestChannelIndex: evaluation.latestChannelIndex,
    latestInterfaceId: evaluation.latestInterfaceId,
    latestMetricDbfs: evaluation.latestMetricDbfs,
    latestNoiseScore: evaluation.latestNoiseScore,
    latestPeakDbfs: evaluation.latestPeakDbfs,
    latestRmsDbfs: evaluation.latestRmsDbfs,
    latestSpeechScore: evaluation.latestSpeechScore,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    maxNoiseScore: evaluation.maxNoiseScore,
    maxSpeechScore: evaluation.maxSpeechScore,
    metric: policy.metric,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    minCumulativeSpeechSeconds: minCumulativeSpeechSeconds(policy),
    minSpeechScore: minSpeechScore(policy),
    qualityMode: policy.qualityMode ?? "signal_only",
    sampleCount: evaluation.sampleCount,
    signalBelowThreshold: signalLevelIsBelowPolicy(evaluation, policy),
    speechBelowThreshold: speechIsBelowPolicy(evaluation, policy),
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
    windowStartedAt: evaluation.windowStartedAt,
  };
}

function channelCorrelationEvaluationDetails(policy: WatchdogPolicy, evaluation: SignalEvaluation) {
  return {
    channelCorrelationAboveThreshold: channelCorrelationIsAbovePolicy(evaluation, policy),
    channelCorrelationMode: policy.channelCorrelationMode ?? "off",
    channelCorrelationThreshold: channelCorrelationThreshold(policy),
    coverageSeconds: Number(evaluation.coverageSeconds.toFixed(1)),
    cumulativeCorrelatedSeconds: Number(evaluation.cumulativeCorrelatedSeconds.toFixed(1)),
    latestChannelCorrelationPairs: evaluation.latestChannelCorrelationPairs,
    maxChannelCorrelationScore: evaluation.maxChannelCorrelationScore,
    minCumulativeChannelCorrelationSeconds: minCumulativeChannelCorrelationSeconds(policy),
    sampleCount: evaluation.sampleCount,
    windowSeconds: policy.windowSeconds,
    windowStartedAt: evaluation.windowStartedAt,
  };
}

function watchdogApplies(policy: WatchdogPolicy, recording: RecordingSummary) {
  if (recording.status !== "recording") {
    return false;
  }

  if (policy.activeDuring === "always" || policy.activeDuring === "recording") {
    return true;
  }

  return recording.source === "schedule" && Boolean(recording.scheduleId);
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

function defaultMeterFrameProvider(nodeId: string) {
  if (!demoMetersEnabled()) {
    return undefined;
  }

  const frame = buildMeterFrame();

  return frame.nodeId === nodeId ? frame : undefined;
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

function watchdogRunnerIntervalMs() {
  return positiveInteger(process.env.RAKKR_WATCHDOG_RUNNER_INTERVAL_SECONDS, 30) * 1_000;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
