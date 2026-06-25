import { mkdir } from "node:fs/promises";
import path from "node:path";

import { invariant, readJsonLines, run } from "./agent-fake-controller-smoke-utils.mjs";

export async function runClaimNextFailureScenario({
  address,
  createObserved,
  nodeId,
  repoRoot,
  setActiveScenario,
  smokeRoot,
  token,
}) {
  const healthLogFile = path.join(smokeRoot, "claim-next-failure-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      claimNextFailuresRemaining: 1,
      expectSuccess: false,
      name: "claim-next-failure",
    },
  });

  const result = await run(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(repoRoot, "Cargo.toml"),
      "-p",
      "rakkr-recorder-agent",
      "--",
      "--allow-insecure-controller",
      "--agent-health-log-file",
      healthLogFile,
      "--controller-token",
      token,
      "--controller-url",
      `http://127.0.0.1:${address.port}`,
      "--node-id",
      nodeId,
      "--run-next-job",
    ],
    { cwd: smokeRoot },
  );

  invariant(result.code !== 0, "claim-next failure smoke unexpectedly succeeded");
  const healthLogEvents = await readJsonLines(healthLogFile);
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.claim_next_failed",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.claim_next_failed",
  );

  invariant(observed.claimNextReadFailures === 1, "fake controller did not fail claim-next once");
  invariant(observed.claims === 0, "agent claimed a job after claim-next was rejected");
  invariant(localEvent, "agent local health log did not include claim-next failure");
  invariant(localEvent.severity === "warning", "claim-next failure was not warning");
  invariant(syncedEvent, "agent did not sync claim-next failure health event");
  invariant(
    String(syncedEvent.details?.error).includes("controller rejected next job claim with 503"),
    "claim-next health event did not preserve controller rejection",
  );
  setActiveScenario(undefined);
}

export async function runControlPlaneFailureScenario({
  address,
  captureCommand,
  renderCommand,
  runScenario,
}) {
  await runScenario({
    address,
    captureCommand,
    renderCommand,
    scenario: {
      expectControlPlaneFailure: true,
      expectSuccess: true,
      jobHeartbeatFailuresRemaining: 1,
      jobId: "job_fake_controller_control_plane_failure",
      name: "control-plane-failure",
      outputFileName: "rec_fake_controller_control_plane_failure.mp3",
      recordingId: "rec_fake_controller_control_plane_failure",
    },
  });
}

export async function runChannelMapLookupFailureScenario({
  address,
  captureCommand,
  renderCommand,
  runScenario,
}) {
  await runScenario({
    address,
    captureCommand,
    renderCommand,
    scenario: {
      channelMapFailuresRemaining: 1,
      expectChannelMapLookupFailure: true,
      expectSuccess: true,
      jobId: "job_fake_controller_channel_map_failure",
      name: "channel-map-failure",
      outputFileName: "rec_fake_controller_channel_map_failure.mp3",
      recordingId: "rec_fake_controller_channel_map_failure",
    },
  });
}

export async function runChannelMapAppliedScenario({
  address,
  captureCommand,
  renderCommand,
  runScenario,
}) {
  await runScenario({
    address,
    captureCommand,
    renderCommand,
    scenario: {
      captureInterfaceId: "iface_channel_map_smoke",
      channelMapAssignments: [
        {
          assignment: {
            assignedAt: "2026-06-25T00:00:00.000Z",
            id: "assignment_channel_map_smoke",
            targetId: "iface_channel_map_smoke",
            targetType: "interface",
            templateId: "template_channel_map_smoke",
          },
          template: {
            channelMode: "stereo",
            entries: [
              {
                included: true,
                label: "Vocal left",
                outputChannelIndex: 1,
                sourceChannelIndex: 1,
              },
              {
                included: true,
                label: "Vocal right",
                outputChannelIndex: 2,
                sourceChannelIndex: 2,
              },
            ],
            id: "template_channel_map_smoke",
            name: "Smoke stereo vocal pair",
            tags: ["smoke", "recording"],
          },
        },
      ],
      expectChannelMapApplied: true,
      expectedChannelMap: {
        assignmentId: "assignment_channel_map_smoke",
        captureChannels: 2,
        channelMode: "stereo",
        entryCount: 2,
        templateId: "template_channel_map_smoke",
      },
      expectSuccess: true,
      jobId: "job_fake_controller_channel_map_applied",
      name: "channel-map-applied",
      outputFileName: "rec_fake_controller_channel_map_applied.mp3",
      recordingId: "rec_fake_controller_channel_map_applied",
    },
  });
}

export async function runControllerTerminalStatusScenarios({
  address,
  captureCommand,
  renderCommand,
  runScenario,
}) {
  for (const terminal of [
    {
      jobId: "job_fake_controller_terminal_completed",
      name: "controller-terminal-completed",
      outputFileName: "rec_fake_controller_terminal_completed.mp3",
      recordingId: "rec_fake_controller_terminal_completed",
      status: "completed",
    },
    {
      jobId: "job_fake_controller_terminal_failed",
      name: "controller-terminal-failed",
      outputFileName: "rec_fake_controller_terminal_failed.mp3",
      reason: "controller_marked_failed_during_capture",
      recordingId: "rec_fake_controller_terminal_failed",
      status: "failed",
    },
  ]) {
    await runScenario({
      address,
      captureCommand,
      renderCommand,
      scenario: {
        controllerTerminalReason: terminal.reason,
        controllerTerminalStatus: terminal.status,
        expectSuccess: true,
        jobId: terminal.jobId,
        name: terminal.name,
        outputFileName: terminal.outputFileName,
        recordingId: terminal.recordingId,
      },
    });
  }
}

export async function runCaptureFailureScenarios({
  address,
  deviceLostCaptureCommand,
  failingCaptureCommand,
  missingCaptureCommand,
  recoveringDeviceLostCaptureCommand,
  renderCommand,
  runScenario,
  tinyCaptureCommand,
}) {
  await runScenario({
    address,
    captureCommand: missingCaptureCommand,
    renderCommand,
    scenario: {
      expectCaptureStartFailure: true,
      expectSuccess: false,
      jobId: "job_fake_controller_capture_start_failure",
      name: "capture-start-failure",
      outputFileName: "rec_fake_controller_capture_start_failure.mp3",
      recordingId: "rec_fake_controller_capture_start_failure",
    },
  });
  await runScenario({
    address,
    captureCommand: failingCaptureCommand,
    renderCommand,
    scenario: {
      expectCaptureFailure: true,
      expectSuccess: false,
      jobId: "job_fake_controller_capture_failure",
      name: "capture-failure",
      outputFileName: "rec_fake_controller_capture_failure.mp3",
      recordingId: "rec_fake_controller_capture_failure",
    },
  });
  await runScenario({
    address,
    captureCommand: deviceLostCaptureCommand,
    renderCommand,
    scenario: {
      expectCaptureDeviceLost: true,
      expectSuccess: false,
      jobId: "job_fake_controller_capture_device_lost",
      name: "capture-device-lost",
      outputFileName: "rec_fake_controller_capture_device_lost.mp3",
      recordingId: "rec_fake_controller_capture_device_lost",
    },
  });
  await runScenario({
    address,
    captureCommand: recoveringDeviceLostCaptureCommand,
    renderCommand,
    scenario: {
      expectCaptureRuntimeRecovery: true,
      expectSuccess: true,
      jobId: "job_fake_controller_capture_device_recovered",
      name: "capture-device-recovered",
      outputFileName: "rec_fake_controller_capture_device_recovered.mp3",
      recordingId: "rec_fake_controller_capture_device_recovered",
    },
  });
  await runScenario({
    address,
    captureCommand: tinyCaptureCommand,
    renderCommand,
    scenario: {
      expectTinyCaptureFailure: true,
      expectSuccess: false,
      jobId: "job_fake_controller_tiny_capture_failure",
      name: "tiny-capture-failure",
      outputFileName: "rec_fake_controller_tiny_capture_failure.mp3",
      recordingId: "rec_fake_controller_tiny_capture_failure",
    },
  });
}

export async function runRecorderCacheTrackFailureScenario({
  address,
  captureCommand,
  deferredSweepRetention,
  renderCommand,
  runScenario,
  smokeRoot,
}) {
  const manifestDirectory = path.join(smokeRoot, "manifest-as-directory");
  await mkdir(manifestDirectory);
  await runScenario({
    address,
    captureCommand,
    renderCommand,
    scenario: {
      expectRecorderCacheTrackFailure: true,
      expectSuccess: true,
      jobId: "job_fake_controller_recorder_cache_track_failure",
      name: "recorder-cache-track-failure",
      outputFileName: "rec_fake_controller_recorder_cache_track_failure.mp3",
      recorderCacheManifestFile: manifestDirectory,
      recorderCacheRetention: deferredSweepRetention(),
      recordingId: "rec_fake_controller_recorder_cache_track_failure",
    },
  });
}
