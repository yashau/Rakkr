import { expireRecordingJobLeases } from "./recording-jobs.js";
import { reportRunnerTickError } from "./runner-tick.js";

export function createRecordingJobLeaseRunner() {
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(now = new Date()) {
    if (running) {
      return [];
    }

    running = true;

    try {
      return await expireRecordingJobLeases(now);
    } finally {
      running = false;
    }
  }

  return {
    async runOnce(now = new Date()) {
      return tick(now);
    },
    start(intervalMs = recordingJobLeaseRunnerIntervalMs()) {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        void tick().catch(reportRunnerTickError("recording-job lease runner"));
      }, intervalMs);
      void tick().catch(reportRunnerTickError("recording-job lease runner"));
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export type RecordingJobLeaseRunner = ReturnType<typeof createRecordingJobLeaseRunner>;

function recordingJobLeaseRunnerIntervalMs() {
  return positiveInteger(process.env.RAKKR_RECORDING_JOB_LEASE_RUNNER_INTERVAL_SECONDS, 10) * 1_000;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
