import type { RecordingJob, RecordingJobStatus } from "@rakkr/shared";

export interface RecordingJobExportFilters {
  captureBackend?: RecordingJob["command"]["captureBackend"];
  captureInterfaceId?: string;
  search?: string;
  status?: RecordingJobStatus;
}

export function filterRecordingJobsForExport(
  jobs: RecordingJob[],
  filters: RecordingJobExportFilters,
) {
  const search = filters.search?.toLocaleLowerCase();

  return jobs.filter((job) => {
    if (
      filters.captureBackend &&
      (job.command.captureBackend ?? "alsa") !== filters.captureBackend
    ) {
      return false;
    }

    if (
      filters.captureInterfaceId &&
      job.command.captureInterfaceId !== filters.captureInterfaceId
    ) {
      return false;
    }

    if (filters.status && job.status !== filters.status) {
      return false;
    }

    return search ? recordingJobSearchText(job).includes(search) : true;
  });
}

export function recordingJobsCsv(jobs: RecordingJob[]) {
  const headers = [
    "id",
    "recordingId",
    "nodeId",
    "status",
    "claimedBy",
    "createdAt",
    "startedAt",
    "lastHeartbeatAt",
    "leaseExpiresAt",
    "stopRequestedAt",
    "completedAt",
    "failureReason",
    "captureBackend",
    "captureDevice",
    "captureInterfaceId",
    "captureFormat",
    "captureSampleRate",
    "captureChannels",
    "durationSeconds",
    "outputCodec",
    "outputBitrateKbps",
    "outputVbr",
    "outputFileName",
  ];

  return [
    headers.join(","),
    ...jobs.map((job) =>
      [
        job.id,
        job.recordingId,
        job.nodeId,
        job.status,
        job.claimedBy ?? "",
        job.createdAt,
        job.startedAt ?? "",
        job.lastHeartbeatAt ?? "",
        job.leaseExpiresAt ?? "",
        job.stopRequestedAt ?? "",
        job.completedAt ?? "",
        job.failureReason ?? "",
        job.command.captureBackend ?? "alsa",
        job.command.captureDevice,
        job.command.captureInterfaceId ?? "",
        job.command.captureFormat,
        String(job.command.captureSampleRate),
        String(job.command.captureChannels),
        String(job.command.durationSeconds),
        job.command.outputCodec ?? "",
        job.command.outputBitrateKbps ? String(job.command.outputBitrateKbps) : "",
        job.command.outputVbr === undefined ? "" : String(job.command.outputVbr),
        job.command.outputFileName,
      ]
        .map(jobCsvCell)
        .join(","),
    ),
  ].join("\n");
}

export function recordingJobsExportFileName(now = new Date()) {
  return `rakkr-recording-jobs-${now.toISOString().replaceAll(":", "-")}.csv`;
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
    .toLocaleLowerCase();
}

function jobCsvCell(value: string) {
  if (/[",\n\r]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}
