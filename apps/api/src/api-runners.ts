import { buildMeterFrame, demoMetersEnabled } from "./demo-data.js";
import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import type { MeterFrameStore } from "./meter-store.js";
import type { NodeStore } from "./node-store.js";
import { createRecordingJobLeaseRunner } from "./recording-job-lease-runner.js";
import type { RecordingStore } from "./recording-store.js";
import { createRetentionRunner } from "./retention-runner.js";
import { createScheduleRunner } from "./schedule-runner.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { UploadDestinationStore } from "./upload-destinations.js";
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
  uploadDestinationStore: UploadDestinationStore;
}

export function createApiRunners({
  auditStore,
  healthEventStore,
  meterFrameStore,
  nodeStore,
  recordingStore,
  scheduleStore,
  settingsStore,
  uploadDestinationStore,
}: ApiRunnerDependencies) {
  return {
    recordingJobLeaseRunner: createRecordingJobLeaseRunner(),
    scheduleRunner: createScheduleRunner({
      auditStore,
      healthEventStore,
      nodeStore,
      recordingStore,
      scheduleStore,
      settingsStore,
    }),
    retentionRunner: createRetentionRunner({
      auditStore,
      recordingStore,
    }),
    uploadRunner: createUploadRunner({
      auditStore,
      destinationStore: uploadDestinationStore,
      healthEventStore,
      recordingStore,
    }),
    watchdogRunner: createWatchdogRunner({
      auditStore,
      healthEventStore,
      meterFrameProvider: (nodeId) => watchdogMeterFrame(meterFrameStore, nodeId),
      nodeStore,
      recordingStore,
    }),
  };
}

export function startApiRunners({
  recordingJobLeaseRunner,
  retentionRunner,
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

  if (process.env.RAKKR_RETENTION_RUNNER_ENABLED !== "0") {
    retentionRunner.start();
  }

  if (process.env.RAKKR_RECORDING_JOB_LEASE_RUNNER_ENABLED !== "0") {
    recordingJobLeaseRunner.start();
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

  if (!demoMetersEnabled()) {
    return undefined;
  }

  const demoFrame = buildMeterFrame();

  return demoFrame.nodeId === nodeId ? demoFrame : undefined;
}
