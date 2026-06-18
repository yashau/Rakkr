import { buildMeterFrame } from "./demo-data.js";
import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import type { MeterFrameStore } from "./meter-store.js";
import type { NodeStore } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";
import { createScheduleRunner } from "./schedule-runner.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { UploadProviderStore } from "./upload-providers.js";
import { createUploadRunner } from "./upload-runner.js";
import { createWatchdogRunner } from "./watchdog-runner.js";

interface ApiRunnerDependencies {
  auditStore: AuditStore;
  healthEventStore: HealthEventStore;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordingStore: RecordingStore;
  scheduleStore: ScheduleStore;
  settingsStore: SettingsStore;
  uploadProviderStore: UploadProviderStore;
}

export function createApiRunners({
  auditStore,
  healthEventStore,
  meterFrameStore,
  nodeStore,
  recordingStore,
  scheduleStore,
  settingsStore,
  uploadProviderStore,
}: ApiRunnerDependencies) {
  return {
    scheduleRunner: createScheduleRunner({
      auditStore,
      nodeStore,
      recordingStore,
      scheduleStore,
      settingsStore,
    }),
    uploadRunner: createUploadRunner({
      auditStore,
      providerStore: uploadProviderStore,
    }),
    watchdogRunner: createWatchdogRunner({
      auditStore,
      healthEventStore,
      meterFrameProvider: (nodeId) => watchdogMeterFrame(meterFrameStore, nodeId),
      recordingStore,
    }),
  };
}

export function startApiRunners({
  scheduleRunner,
  uploadRunner,
  watchdogRunner,
}: ReturnType<typeof createApiRunners>) {
  if (process.env.RAKKR_SCHEDULE_RUNNER_ENABLED !== "0") {
    scheduleRunner.start();
  }

  if (process.env.RAKKR_UPLOAD_RUNNER_ENABLED !== "0") {
    uploadRunner.start();
  }

  if (process.env.RAKKR_WATCHDOG_RUNNER_ENABLED !== "0") {
    watchdogRunner.start();
  }
}

async function watchdogMeterFrame(meterFrameStore: MeterFrameStore, nodeId: string) {
  const frame = await meterFrameStore.latest(nodeId);

  if (frame) {
    return frame;
  }

  const demoFrame = buildMeterFrame();

  return demoFrame.nodeId === nodeId ? demoFrame : undefined;
}
