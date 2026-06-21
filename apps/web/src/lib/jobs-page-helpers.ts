import type { CurrentUser, RecorderNode, RecordingJob, RecordingSummary } from "@rakkr/shared";

import type { RecordingJobFilters } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

export type RecordingJobFilterKey = keyof RecordingJobFilters;

export interface ActiveRecordingJobFilterChip {
  key: RecordingJobFilterKey;
  label: string;
  value: string;
}

export interface JobsPageFilters {
  captureBackend: "" | NonNullable<RecordingJob["command"]["captureBackend"]>;
  captureInterfaceId: string;
  createdFrom: string;
  createdTo: string;
  nodeId: string;
  search: string;
  status: "" | RecordingJob["status"];
}

export const emptyJobsPageFilters: JobsPageFilters = {
  captureBackend: "",
  captureInterfaceId: "",
  createdFrom: "",
  createdTo: "",
  nodeId: "",
  search: "",
  status: "",
};

export function jobsPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canControlJobs: permissions.includes("recording:control"),
    canReadJobs: permissions.includes("recording:read"),
    canReadNodes: permissions.includes("node:read"),
    canReadRecordings: permissions.includes("recording:read"),
  };
}

export function recordingJobStopActionState(job: RecordingJob, canControl: boolean) {
  if (!canControl) {
    return {
      canStop: false,
      title: "Requires recording control permission",
    };
  }

  if (stoppableJobStatuses.includes(job.status)) {
    return {
      canStop: true,
      title: "Request stop",
    };
  }

  if (job.status === "stop_requested") {
    return {
      canStop: false,
      title: "Stop already requested",
    };
  }

  return {
    canStop: false,
    title: "Job is terminal",
  };
}

export function recordingJobRetryActionState(job: RecordingJob, canControl: boolean) {
  if (!canControl) {
    return {
      canRetry: false,
      title: "Requires recording control permission",
    };
  }

  if (retryableJobStatuses.includes(job.status)) {
    return {
      canRetry: true,
      title: "Retry job",
    };
  }

  if (activeJobStatuses.includes(job.status)) {
    return {
      canRetry: false,
      title: "Job is active",
    };
  }

  return {
    canRetry: false,
    title: "Job completed",
  };
}

export function recordingJobBulkStopTargets(
  jobs: RecordingJob[],
  selectedJobIds: string[],
  canControl: boolean,
) {
  if (!canControl) {
    return [];
  }

  const selected = new Set(selectedJobIds);

  return jobs
    .filter((job) => selected.has(job.id) && stoppableJobStatuses.includes(job.status))
    .map((job) => job.id);
}

export function recordingJobBulkRetryTargets(
  jobs: RecordingJob[],
  selectedJobIds: string[],
  canControl: boolean,
) {
  if (!canControl) {
    return [];
  }

  const selected = new Set(selectedJobIds);
  const retryableJobs = jobs.filter(
    (job) => selected.has(job.id) && retryableJobStatuses.includes(job.status),
  );
  const activeRecordingIds = new Set(
    jobs.filter((job) => activeJobStatuses.includes(job.status)).map((job) => job.recordingId),
  );

  return retryableJobs
    .filter((job) => !activeRecordingIds.has(job.recordingId))
    .map((job) => job.id);
}

export function recordingJobSummary(jobs: RecordingJob[]) {
  return {
    active: jobs.filter((job) => activeJobStatuses.includes(job.status)).length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    stopRequested: jobs.filter((job) => job.status === "stop_requested").length,
    total: jobs.length,
  };
}

export function recordingJobFilterChips(
  filters: RecordingJobFilters,
): ActiveRecordingJobFilterChip[] {
  return recordingJobFilterOrder.flatMap((key) => {
    const value = filters[key];

    if (!value) {
      return [];
    }

    return [
      {
        key,
        label: recordingJobFilterLabels[key],
        value: recordingJobFilterValue(key, value),
      },
    ];
  });
}

export function filterRecordingJobs(jobs: RecordingJob[], filters: JobsPageFilters) {
  const nodeId = filters.nodeId.trim();
  const search = filters.search.trim().toLowerCase();
  const createdFrom = localDateStart(filters.createdFrom);
  const createdTo = localDateEnd(filters.createdTo);

  return jobs.filter((job) => {
    const createdAt = Date.parse(job.createdAt);

    if (createdFrom !== undefined && createdAt < createdFrom) {
      return false;
    }

    if (createdTo !== undefined && createdAt > createdTo) {
      return false;
    }

    if (filters.status && job.status !== filters.status) {
      return false;
    }

    if (
      filters.captureBackend &&
      (job.command.captureBackend ?? "alsa") !== filters.captureBackend
    ) {
      return false;
    }

    if (nodeId && job.nodeId !== nodeId) {
      return false;
    }

    if (
      filters.captureInterfaceId.trim() &&
      job.command.captureInterfaceId !== filters.captureInterfaceId.trim()
    ) {
      return false;
    }

    if (!search) {
      return true;
    }

    return recordingJobSearchText(job).includes(search);
  });
}

export function recordingJobRelationshipLabel(
  job: RecordingJob,
  lookups: {
    nodes?: RecorderNode[];
    recordings?: RecordingSummary[];
  },
) {
  const node = lookups.nodes?.find((candidate) => candidate.id === job.nodeId);
  const recording = lookups.recordings?.find((candidate) => candidate.id === job.recordingId);

  return [
    node ? `Node ${node.alias}` : job.nodeId,
    recording ? `Recording ${recording.name}` : job.recordingId,
  ].join(" / ");
}

export function recordingJobCaptureDetails(job: RecordingJob) {
  const details = [
    { label: "backend", value: job.command.captureBackend ?? "alsa" },
    { label: "device", value: job.command.captureDevice },
    { label: "format", value: job.command.captureFormat },
    { label: "rate", value: `${job.command.captureSampleRate} Hz` },
    { label: "channels", value: String(job.command.captureChannels) },
    { label: "duration", value: `${job.command.durationSeconds}s` },
    { label: "output", value: outputProfileLabel(job) },
  ];

  if (job.command.captureInterfaceId) {
    details.push({ label: "interface", value: job.command.captureInterfaceId });
  }

  if (job.command.channelMap) {
    const includedChannels = job.command.channelMap.entries
      .filter((entry) => entry.included)
      .map((entry) => entry.sourceChannelIndex)
      .sort((left, right) => left - right);

    details.push({ label: "map", value: job.command.channelMap.templateName });
    details.push({ label: "mode", value: job.command.channelMap.channelMode });
    details.push({
      label: "mapped",
      value:
        includedChannels.length > 0
          ? includedChannels.join(",")
          : `${job.command.channelMap.sourceChannels}`,
    });
  }

  return details;
}

export function recordingJobStatusClass(status: RecordingJob["status"]) {
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

function outputProfileLabel(job: RecordingJob) {
  const codec = job.command.outputCodec ?? "wav";
  const bitrate = job.command.outputBitrateKbps ? ` ${job.command.outputBitrateKbps}kbps` : "";
  const vbr = job.command.outputVbr ? " VBR" : "";

  return `${codec}${bitrate}${vbr}`;
}

function recordingJobSearchText(job: RecordingJob) {
  return [
    job.claimedBy,
    job.command.captureBackend,
    job.command.captureDevice,
    job.command.captureFormat,
    job.command.captureInterfaceId,
    job.command.channelMap?.templateName,
    job.command.outputFileName,
    job.failureReason,
    job.id,
    job.nodeId,
    job.recordingId,
    job.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

const activeJobStatuses: Array<RecordingJob["status"]> = ["queued", "running", "stop_requested"];
const retryableJobStatuses: Array<RecordingJob["status"]> = ["cancelled", "failed"];
const stoppableJobStatuses: Array<RecordingJob["status"]> = ["queued", "running"];

function recordingJobFilterValue(key: RecordingJobFilterKey, value: string) {
  if (key === "createdFrom" || key === "createdTo") {
    return formatDateTime(value);
  }

  return value;
}

const recordingJobFilterOrder: RecordingJobFilterKey[] = [
  "search",
  "status",
  "nodeId",
  "captureBackend",
  "captureInterfaceId",
  "createdFrom",
  "createdTo",
];

const recordingJobFilterLabels: Record<RecordingJobFilterKey, string> = {
  captureBackend: "backend",
  captureInterfaceId: "interface",
  createdFrom: "created from",
  createdTo: "created to",
  nodeId: "node",
  search: "search",
  status: "status",
};

function localDateStart(value: string) {
  const parts = localDateParts(value);

  if (!parts) {
    return undefined;
  }

  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime();
}

function localDateEnd(value: string) {
  const parts = localDateParts(value);

  if (!parts) {
    return undefined;
  }

  return new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999).getTime();
}

function localDateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);

  if (!match) {
    return undefined;
  }

  return {
    day: Number(match[3]),
    month: Number(match[2]),
    year: Number(match[1]),
  };
}
