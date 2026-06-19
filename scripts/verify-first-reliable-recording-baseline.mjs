import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/recordings/FIRST_RELIABLE_RECORDING_BASELINE.md";
const sourceFiles = [
  "docs/recordings/RECORDING_LIBRARY_BASELINE.md",
  "packages/shared/src/index.ts",
  "apps/api/src/recording-routes.ts",
  "apps/api/src/recording-jobs.ts",
  "apps/api/src/recording-cache.ts",
  "apps/api/src/agent-routes.ts",
  "apps/api/src/schedule-runner.ts",
  "apps/api/src/health-sync.ts",
  "apps/api/src/upload-policies.ts",
  "apps/api/src/upload-queue.ts",
  "crates/recorder-agent/src/config.rs",
  "crates/recorder-agent/src/controller.rs",
  "crates/recorder-agent/src/main.rs",
  "apps/web/src/components/recording-card.tsx",
  "apps/web/src/pages/schedule-detail.tsx",
  "apps/web/src/lib/schedule-detail-page-helpers.ts",
  "apps/api/test/recording-routes.test.ts",
  "apps/api/test/agent-routes.test.ts",
  "apps/api/test/schedule-runner.test.ts",
  "apps/api/test/recording-cache.test.ts",
  "apps/web/src/lib/recording-page-helpers.test.ts",
  "apps/web/src/lib/schedule-detail-page-helpers.test.ts",
  "scripts/agent-fake-controller-smoke.mjs",
];
const baselinePhrases = [
  "MVP baseline checked",
  "Ad-hoc recording start",
  "node, profile, upload policy, folder, name, and tags",
  "Scheduled due runs",
  "schedule-owned recordings",
  "claim jobs",
  "claim-next",
  "heartbeat running jobs",
  "bounded simultaneous jobs",
  "RAKKR_MAX_CONCURRENT_RECORDINGS",
  "attach cached audio",
  "auto-queue cached recordings",
  "checksum",
  "duration",
  "waveform preview",
  "playback sessions",
  "download preparation",
  "inline stream",
  "attachment file responses",
  "Stop requests",
  "central health events",
  "Fake-controller smoke",
  "MP3 VBR output",
  "mise run recordings:check-first-reliable",
];
const sourceSnippets = [
  "recordingStartRequestSchema",
  "recordings.start.succeeded",
  "createRecordingJob",
  "claimNextRecordingJob",
  "recording_jobs.claim_next.succeeded",
  "outputBitrateKbps",
  "outputCodec",
  "outputVbr",
  "recordings.cache_file.attach.succeeded",
  "recordings.playback.started",
  "recordings.download.prepare",
  "recordings.playback.stream",
  "recordings.download.file",
  "storeRecordingFile",
  "waveformPreview",
  "syncRecordingHealth",
  "controller.recording.job_failed",
  "controller.recording.job_cancelled",
  "queueCachedRecordingUpload",
  "uploadPolicyForCachedRecording",
  "recordings.upload_queue.auto_enqueue.succeeded",
  "schedules.due_run.succeeded",
  "RecordingCard",
  "playbackPreviewFromSession",
  "schedule detail permissions mirror granular read and action grants",
  "agent.recording_job.output_rendered",
  "agent.recording_job.cache_upload_failed",
  "controller_stop_requested",
  "RAKKR_MAX_CONCURRENT_RECORDINGS",
  "max_concurrent_recordings",
  "spawn_recording_job_workers",
  "JoinSet",
  "--max-concurrent-recordings",
];
const testSnippets = [
  "ad hoc recording start uses requested node profile policy and metadata",
  "ad hoc recording completes through agent cache attach and exposes cached media",
  "claim-next lets one node claim multiple queued recordings independently",
  "scheduled recording completes through agent cache attach and exposes schedule-owned media",
  "playback.status, 202",
  "download.status, 202",
  'stream.headers.get("content-type"), "audio/wav"',
  "stores checksum and wav waveform preview for cached recordings",
  "extracts duration and decoded waveform preview for encoded recordings",
  "agent failed job marks recording metadata failed",
  "agent unexpected cancellation marks recording health warning",
  "controller stop request survives agent cancellation as completed recording",
  "recording playback preview tracks session and file details",
  "schedule detail permissions mirror granular read and action grants",
  "recording:download",
  "recording:playback",
  "agent did not upload cache file",
  "cache upload local health event",
  "concurrent jobs did not overlap as running",
  "concurrent agent did not claim both queued jobs",
];
const errors = [];

const baseline = await readFile(baselineFile, "utf8");
const sourceEntries = await Promise.all(
  sourceFiles.map(async (sourceFile) => ({
    content: await readFile(sourceFile, "utf8"),
    path: sourceFile,
  })),
);
const allSource = sourceEntries.map((entry) => entry.content).join("\n");
const allTests = sourceEntries
  .filter(
    (entry) =>
      entry.path.includes("/test/") ||
      entry.path.endsWith(".test.ts") ||
      entry.path.endsWith("agent-fake-controller-smoke.mjs"),
  )
  .map((entry) => entry.content)
  .join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing first reliable recording evidence file ${sourceFile}`);
  }

  if (sourceFile.includes(".test.") && !baseline.includes(sourceFile)) {
    errors.push(`${baselineFile} should reference ${sourceFile}`);
  }
}

for (const phrase of baselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of sourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`first reliable recording source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`first reliable recording tests must include "${snippet}"`);
  }
}

if (/real x32|test rig validated/iu.test(baseline)) {
  errors.push(`${baselineFile} must not claim paused hardware validation is complete`);
}

if (errors.length > 0) {
  console.error(`Invalid first reliable recording baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified first reliable recording baseline in ${baselineFile}.`);
