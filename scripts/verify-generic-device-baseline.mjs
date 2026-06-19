import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/devices/GENERIC_DEVICE_BASELINE.md";
const sourceFiles = [
  ".mise.toml",
  "crates/recorder-agent/src/config.rs",
  "crates/recorder-agent/src/capture.rs",
  "crates/recorder-agent/src/inventory.rs",
  "crates/recorder-agent/src/telemetry.rs",
  "crates/recorder-agent/src/channel_map.rs",
  "scripts/alsa-loopback-smoke.sh",
  "scripts/agent-loopback-meter-smoke.sh",
  "scripts/alsa-loopback-render-smoke.sh",
  "scripts/agent-fake-controller-smoke.mjs",
];
const baselinePhrases = [
  "Partial baseline checked",
  "X32 Rack is only the first test fixture",
  "generic Linux audio interfaces",
  "ALSA is the MVP backend",
  "command, device, format, sample rate, channel count",
  "arecord",
  "/proc/asound/pcm",
  "sysfs hardware paths",
  "Synthetic meters",
  "fake-controller",
  "snd-aloop",
  "Remaining gaps",
  "Linux loopback smoke execution",
  "JACK/PipeWire adapters",
  "mise run devices:check-generic",
];
const sourceSnippets = [
  "RAKKR_CAPTURE_DEVICE",
  "RAKKR_CAPTURE_COMMAND",
  "RAKKR_CAPTURE_FORMAT",
  "RAKKR_CAPTURE_SAMPLE_RATE",
  "RAKKR_CAPTURE_CHANNELS",
  "capture_command_args",
  "builds_arecord_capture_args",
  "parse_alsa_capture_devices",
  "parses_proc_asound_pcm_capture_devices",
  "parse_alsa_stream_metadata",
  "parses_serial_from_sysfs_uevent",
  "alsa_meter_frame",
  "synthetic_meter_frame",
  "agent:loopback-smoke",
  "agent:loopback-meter-smoke",
  "agent:loopback-render-smoke",
  "snd-aloop",
  "speaker-test",
  "ffprobe",
  "--print-meter-frame",
  "Agent fake-controller smoke passed",
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

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing generic device evidence file ${sourceFile}`);
  }

  if (!baseline.includes(sourceFile)) {
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
    errors.push(`generic device source must include "${snippet}"`);
  }
}

if (/Status:\s*MVP baseline checked/iu.test(baseline)) {
  errors.push(
    `${baselineFile} must remain partial until Linux loopback and physical-device validation close`,
  );
}

if (errors.length > 0) {
  console.error(`Invalid generic device baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified generic device partial baseline in ${baselineFile}.`);
