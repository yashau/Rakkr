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
import { buildMeterFrame } from "./demo-data.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { RecordingStore } from "./recording-store.js";

export const scheduledLowSignalEventType = "watchdog.scheduled_low_signal";

export type MeterFrameProvider = (
  nodeId: string,
  now: Date,
) => MaybePromise<MeterFrame | undefined>;

export interface WatchdogRunnerDependencies {
  auditStore: AuditStore;
  healthEventStore: HealthEventStore;
  meterFrameProvider?: MeterFrameProvider;
  policies?: WatchdogPolicy[];
  recordingStore: RecordingStore;
}

export interface WatchdogRunResult {
  eventId?: string;
  maxMetricDbfs?: number;
  outcome:
    | "alert_created"
    | "alert_repeated"
    | "alert_resolved"
    | "alert_updated"
    | "healthy"
    | "pending"
    | "skipped";
  reason?: string;
  recordingId: string;
  scheduleId?: string;
}

type MaybePromise<T> = Promise<T> | T;

interface SignalHistory {
  lastSampleAtMs?: number;
  samples: SignalSample[];
}

interface SignalSample {
  capturedAtMs: number;
  channelIndex?: number;
  durationSeconds: number;
  interfaceId?: string;
  maxPeakDbfs: number;
  maxRmsDbfs: number;
  metricDbfs: number;
}

interface SignalEvaluation {
  coverageSeconds: number;
  cumulativeSecondsAboveThreshold: number;
  latestChannelIndex?: number;
  latestInterfaceId?: string;
  latestMetricDbfs: number;
  latestPeakDbfs: number;
  latestRmsDbfs: number;
  maxMetricDbfs: number;
  sampleCount: number;
  windowStartedAt: string;
}

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
  }

  pruneInactiveHistories(histories, activeRecordingIds);

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

async function activeLowSignalEvent(healthEventStore: HealthEventStore, recordingId: string) {
  const events = await healthEventStore.list({ limit: 500, recordingId });

  return events.find(
    (event) => event.type === scheduledLowSignalEventType && event.status !== "resolved",
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

function evaluationDetails(policy: WatchdogPolicy, evaluation: SignalEvaluation) {
  return {
    coverageSeconds: Number(evaluation.coverageSeconds.toFixed(1)),
    cumulativeSecondsAboveThreshold: Number(evaluation.cumulativeSecondsAboveThreshold.toFixed(1)),
    latestChannelIndex: evaluation.latestChannelIndex,
    latestInterfaceId: evaluation.latestInterfaceId,
    latestMetricDbfs: evaluation.latestMetricDbfs,
    latestPeakDbfs: evaluation.latestPeakDbfs,
    latestRmsDbfs: evaluation.latestRmsDbfs,
    maxMetricDbfs: evaluation.maxMetricDbfs,
    metric: policy.metric,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    sampleCount: evaluation.sampleCount,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
    windowStartedAt: evaluation.windowStartedAt,
  };
}

function signalSample(
  frame: MeterFrame | undefined,
  policy: WatchdogPolicy,
  lastSampleAtMs: number | undefined,
  now: Date,
): SignalSample {
  const durationSeconds = lastSampleAtMs
    ? Math.min(Math.max((now.getTime() - lastSampleAtMs) / 1_000, 0), maxSampleSpanSeconds())
    : 0;

  if (!frame || frame.levels.length === 0) {
    return {
      capturedAtMs: now.getTime(),
      durationSeconds,
      maxPeakDbfs: -160,
      maxRmsDbfs: -160,
      metricDbfs: -160,
    };
  }

  const maxPeak = Math.max(...frame.levels.map((level) => level.peakDbfs));
  const maxRms = Math.max(...frame.levels.map((level) => level.rmsDbfs));
  const metricLevel =
    policy.metric === "peak"
      ? maxBy(frame.levels, (level) => level.peakDbfs)
      : maxBy(frame.levels, (level) => level.rmsDbfs);

  return {
    capturedAtMs: now.getTime(),
    channelIndex: metricLevel.channelIndex,
    durationSeconds,
    interfaceId: frame.interfaceId,
    maxPeakDbfs: Number(maxPeak.toFixed(1)),
    maxRmsDbfs: Number(maxRms.toFixed(1)),
    metricDbfs: Number(metricValue(frame, policy).toFixed(1)),
  };
}

function signalEvaluation(
  history: SignalHistory,
  policy: WatchdogPolicy,
  now: Date,
): SignalEvaluation {
  const windowStartMs = now.getTime() - policy.windowSeconds * 1_000;
  const samples = history.samples.filter((sample) => sample.capturedAtMs >= windowStartMs);
  const latest = samples.at(-1);
  const maxMetricDbfs = samples.length
    ? Math.max(...samples.map((sample) => sample.metricDbfs))
    : -160;
  const coverageSeconds = samples.reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeSecondsAboveThreshold = samples
    .filter((sample) => sample.metricDbfs >= policy.thresholdDbfs)
    .reduce((total, sample) => total + sample.durationSeconds, 0);

  return {
    coverageSeconds,
    cumulativeSecondsAboveThreshold,
    latestChannelIndex: latest?.channelIndex,
    latestInterfaceId: latest?.interfaceId,
    latestMetricDbfs: latest?.metricDbfs ?? -160,
    latestPeakDbfs: latest?.maxPeakDbfs ?? -160,
    latestRmsDbfs: latest?.maxRmsDbfs ?? -160,
    maxMetricDbfs: Number(maxMetricDbfs.toFixed(1)),
    sampleCount: samples.length,
    windowStartedAt: new Date(windowStartMs).toISOString(),
  };
}

function signalIsBelowPolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  if (evaluation.maxMetricDbfs < policy.thresholdDbfs) {
    return true;
  }

  if (evaluation.coverageSeconds < policy.minCumulativeSecondsAboveThreshold) {
    return false;
  }

  return evaluation.cumulativeSecondsAboveThreshold < policy.minCumulativeSecondsAboveThreshold;
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

function historyFor(histories: Map<string, SignalHistory>, recordingId: string) {
  const existing = histories.get(recordingId);

  if (existing) {
    return existing;
  }

  const history: SignalHistory = { samples: [] };

  histories.set(recordingId, history);

  return history;
}

function pruneHistory(history: SignalHistory, policy: WatchdogPolicy, now: Date) {
  const oldestSampleAt = now.getTime() - policy.windowSeconds * 1_000;

  history.samples = history.samples.filter((sample) => sample.capturedAtMs >= oldestSampleAt);
}

function pruneInactiveHistories(
  histories: Map<string, SignalHistory>,
  activeRecordingIds: Set<string>,
) {
  for (const recordingId of histories.keys()) {
    if (!activeRecordingIds.has(recordingId)) {
      histories.delete(recordingId);
    }
  }
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
  const frame = buildMeterFrame();

  return frame.nodeId === nodeId ? frame : undefined;
}

function metricValue(frame: MeterFrame, policy: WatchdogPolicy) {
  if (policy.metric === "peak") {
    return Math.max(...frame.levels.map((level) => level.peakDbfs));
  }

  if (policy.metric === "percentile_95") {
    return percentile(
      frame.levels.map((level) => level.rmsDbfs),
      0.95,
    );
  }

  return Math.max(...frame.levels.map((level) => level.rmsDbfs));
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return -160;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);

  return sorted[index] ?? -160;
}

function maxBy<T>(values: T[], selector: (value: T) => number) {
  return values.reduce((winner, value) => (selector(value) > selector(winner) ? value : winner));
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

function maxSampleSpanSeconds() {
  return positiveInteger(process.env.RAKKR_WATCHDOG_MAX_SAMPLE_SPAN_SECONDS, 30);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
