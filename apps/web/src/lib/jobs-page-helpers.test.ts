import assert from "node:assert/strict";
import test from "node:test";
import type {
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingJob,
  RecordingSummary,
} from "@rakkr/shared";

import {
  emptyJobsPageFilters,
  filterRecordingJobs,
  jobsPagePermissions,
  recordingJobBulkRetryTargets,
  recordingJobBulkStopTargets,
  recordingJobCaptureDetails,
  recordingJobRelationshipLabel,
  recordingJobRetryActionState,
  recordingJobStopActionState,
  recordingJobSummary,
} from "./jobs-page-helpers";

test("jobs page permissions are closed by default", () => {
  assert.deepEqual(jobsPagePermissions(undefined), {
    canControlJobs: false,
    canReadJobs: false,
    canReadNodes: false,
    canReadRecordings: false,
  });
});

test("jobs page reads require recording read and optional node lookups", () => {
  assert.deepEqual(jobsPagePermissions(user(["recording:read"])), {
    canControlJobs: false,
    canReadJobs: true,
    canReadNodes: false,
    canReadRecordings: true,
  });
  assert.deepEqual(jobsPagePermissions(user(["node:read", "recording:read"])), {
    canControlJobs: false,
    canReadJobs: true,
    canReadNodes: true,
    canReadRecordings: true,
  });
  assert.deepEqual(jobsPagePermissions(user(["recording:control", "recording:read"])), {
    canControlJobs: true,
    canReadJobs: true,
    canReadNodes: false,
    canReadRecordings: true,
  });
});

test("recording job summary counts active and terminal states", () => {
  assert.deepEqual(
    recordingJobSummary([
      job({ id: "job_queued", status: "queued" }),
      job({ id: "job_running", status: "running" }),
      job({ id: "job_stop", status: "stop_requested" }),
      job({ id: "job_done", status: "completed" }),
      job({ id: "job_failed", status: "failed" }),
      job({ id: "job_cancelled", status: "cancelled" }),
    ]),
    {
      active: 3,
      cancelled: 1,
      completed: 1,
      failed: 1,
      queued: 1,
      running: 1,
      stopRequested: 1,
      total: 6,
    },
  );
});

test("recording job filters match status and searchable job fields", () => {
  const jobs = [
    job({ id: "job_1", command: { ...job().command, captureDevice: "hw:CARD=Loopback,DEV=0" } }),
    job({
      id: "job_2",
      command: { ...job().command, captureBackend: "pipewire" },
      claimedBy: "agent-node-2",
      failureReason: "encoder failed",
      status: "failed",
    }),
  ];

  assert.deepEqual(filterRecordingJobs(jobs, { ...emptyJobsPageFilters, status: "failed" }), [
    jobs[1],
  ]);
  assert.deepEqual(filterRecordingJobs(jobs, { ...emptyJobsPageFilters, search: "loopback" }), [
    jobs[0],
  ]);
  assert.deepEqual(filterRecordingJobs(jobs, { ...emptyJobsPageFilters, search: "encoder" }), [
    jobs[1],
  ]);
  assert.deepEqual(filterRecordingJobs(jobs, { ...emptyJobsPageFilters, search: "pipewire" }), [
    jobs[1],
  ]);
  assert.deepEqual(
    filterRecordingJobs(jobs, { ...emptyJobsPageFilters, captureBackend: "pipewire" }),
    [jobs[1]],
  );
});

test("recording job relationship labels prefer permitted friendly names", () => {
  assert.equal(
    recordingJobRelationshipLabel(job({ nodeId: "node_1", recordingId: "rec_1" }), {
      nodes: [node("node_1", "Council Node")],
      recordings: [recording("rec_1", "Council Meeting")],
    }),
    "Node Council Node / Recording Council Meeting",
  );
  assert.equal(
    recordingJobRelationshipLabel(job({ nodeId: "node_1", recordingId: "rec_1" }), {}),
    "node_1 / rec_1",
  );
});

test("recording job capture details expose capture output and channel-map context", () => {
  assert.deepEqual(
    recordingJobCaptureDetails(
      job({
        command: {
          ...job().command,
          captureInterfaceId: "iface_1",
          channelMap: {
            assignmentId: "assign_1",
            channelMode: "stereo",
            entries: [
              { included: true, label: "Left", outputChannelIndex: 1, sourceChannelIndex: 1 },
              { included: true, label: "Right", outputChannelIndex: 2, sourceChannelIndex: 2 },
            ],
            sourceChannels: 2,
            targetId: "iface_1",
            targetType: "interface",
            templateId: "map_1",
            templateName: "Stereo Pair",
          },
          outputBitrateKbps: 128,
          outputCodec: "mp3",
          outputVbr: true,
        },
      }),
    ),
    [
      { label: "backend", value: "alsa" },
      { label: "device", value: "hw:0,0" },
      { label: "format", value: "S16_LE" },
      { label: "rate", value: "48000 Hz" },
      { label: "channels", value: "2" },
      { label: "duration", value: "3600s" },
      { label: "output", value: "mp3 128kbps VBR" },
      { label: "interface", value: "iface_1" },
      { label: "map", value: "Stereo Pair" },
      { label: "mode", value: "stereo" },
      { label: "mapped", value: "1,2" },
    ],
  );
});

test("recording job stop action state mirrors permission and lifecycle", () => {
  assert.deepEqual(recordingJobStopActionState(job({ status: "queued" }), false), {
    canStop: false,
    title: "Requires recording control permission",
  });
  assert.deepEqual(recordingJobStopActionState(job({ status: "queued" }), true), {
    canStop: true,
    title: "Request stop",
  });
  assert.deepEqual(recordingJobStopActionState(job({ status: "running" }), true), {
    canStop: true,
    title: "Request stop",
  });
  assert.deepEqual(recordingJobStopActionState(job({ status: "stop_requested" }), true), {
    canStop: false,
    title: "Stop already requested",
  });
  assert.deepEqual(recordingJobStopActionState(job({ status: "completed" }), true), {
    canStop: false,
    title: "Job is terminal",
  });
});

test("recording job retry action state mirrors permission and lifecycle", () => {
  assert.deepEqual(recordingJobRetryActionState(job({ status: "failed" }), false), {
    canRetry: false,
    title: "Requires recording control permission",
  });
  assert.deepEqual(recordingJobRetryActionState(job({ status: "failed" }), true), {
    canRetry: true,
    title: "Retry job",
  });
  assert.deepEqual(recordingJobRetryActionState(job({ status: "cancelled" }), true), {
    canRetry: true,
    title: "Retry job",
  });
  assert.deepEqual(recordingJobRetryActionState(job({ status: "running" }), true), {
    canRetry: false,
    title: "Job is active",
  });
  assert.deepEqual(recordingJobRetryActionState(job({ status: "completed" }), true), {
    canRetry: false,
    title: "Job completed",
  });
});

test("recording job bulk targets include only eligible selected jobs", () => {
  const jobs = [
    job({ id: "job_queued", recordingId: "rec_queued", status: "queued" }),
    job({ id: "job_running", recordingId: "rec_running", status: "running" }),
    job({ id: "job_failed", recordingId: "rec_failed", status: "failed" }),
    job({ id: "job_cancelled", recordingId: "rec_cancelled", status: "cancelled" }),
    job({ id: "job_done", recordingId: "rec_done", status: "completed" }),
    job({ id: "job_retry_active", recordingId: "rec_failed", status: "queued" }),
  ];
  const selected = jobs.map((recordingJob) => recordingJob.id);

  assert.deepEqual(recordingJobBulkStopTargets(jobs, selected, true), [
    "job_queued",
    "job_running",
    "job_retry_active",
  ]);
  assert.deepEqual(recordingJobBulkRetryTargets(jobs, selected, true), ["job_cancelled"]);
  assert.deepEqual(recordingJobBulkStopTargets(jobs, selected, false), []);
  assert.deepEqual(recordingJobBulkRetryTargets(jobs, selected, false), []);
});

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "operator@example.test",
    groups: [],
    id: "user_operator",
    name: "Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function job(input: Partial<RecordingJob> = {}): RecordingJob {
  return {
    command: {
      captureChannels: 2,
      captureDevice: "hw:0,0",
      captureFormat: "S16_LE",
      captureSampleRate: 48000,
      durationSeconds: 3600,
      outputCodec: "wav",
      outputFileName: "recording.wav",
      type: "alsa_capture",
    },
    createdAt: "2026-06-20T12:00:00.000Z",
    id: "job_1",
    nodeId: "node_1",
    recordingId: "rec_1",
    status: "queued",
    ...input,
  };
}

function node(id: string, alias: string): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias,
    hostname: "node.local",
    id,
    interfaces: [],
    ipAddresses: ["10.0.0.10"],
    lastSeenAt: "2026-06-20T12:00:00.000Z",
    location: { room: "Council", site: "Town Hall" },
    status: "online",
    tags: [],
  };
}

function recording(id: string, name: string): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 3600,
    folder: "Council",
    healthStatus: "unknown",
    id,
    name,
    recordedAt: "2026-06-20T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: [],
  };
}
