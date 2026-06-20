import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/devices/GENERIC_DEVICE_BASELINE.md";
const sourceFiles = [
  ".mise.toml",
  "packages/shared/src/index.ts",
  "apps/api/src/node-store.ts",
  "apps/api/src/node-routes.ts",
  "apps/api/src/agent-node-config-route.ts",
  "apps/api/src/recording-job-targets.ts",
  "apps/api/src/recording-jobs.ts",
  "apps/api/test/recording-jobs.test.ts",
  "apps/api/test/node-routes.test.ts",
  "apps/api/test/agent-routes.test.ts",
  "apps/web/src/components/node-inventory-editors.tsx",
  "crates/recorder-agent/src/alsa_device.rs",
  "crates/recorder-agent/src/command_template.rs",
  "crates/recorder-agent/src/config.rs",
  "crates/recorder-agent/src/capture.rs",
  "crates/recorder-agent/src/main.rs",
  "crates/recorder-agent/src/meter_command.rs",
  "crates/recorder-agent/src/node_config.rs",
  "crates/recorder-agent/src/inventory.rs",
  "crates/recorder-agent/src/telemetry.rs",
  "crates/recorder-agent/src/channel_map.rs",
  "scripts/alsa-loopback-smoke.sh",
  "scripts/agent-loopback-meter-smoke.sh",
  "scripts/alsa-loopback-render-smoke.sh",
  "scripts/agent-fake-controller-smoke-devices.mjs",
  "scripts/agent-fake-controller-smoke.mjs",
];
const baselinePhrases = [
  "Partial baseline checked",
  "X32 Rack is only the first test fixture",
  "generic Linux audio interfaces",
  "ALSA is the default capture and meter backend",
  "PipeWire and JACK have first-class command presets",
  "command, optional argument templates, device, format, sample rate, channel count",
  "Capture and meter argument templates",
  "Controller-managed node audio defaults",
  "capture backend",
  "hyphen-leading template values",
  "Fake-controller smoke coverage",
  "arecord",
  "/proc/asound/pcm",
  "arecord --dump-hw-params",
  "plughw:2,0",
  "hw:CARD=Loopback,DEV=1",
  "hw:Loopback,1,0",
  "PipeWire",
  "JACK",
  "sysfs hardware paths",
  "Synthetic meters",
  "fake-controller",
  "template-driven capture arguments",
  "snd-aloop",
  "Remaining gaps",
  "Linux loopback smoke execution",
  "mise run devices:check-generic",
];
const sourceSnippets = [
  "RAKKR_CAPTURE_DEVICE",
  "RAKKR_CAPTURE_COMMAND",
  "RAKKR_CAPTURE_BACKEND",
  "RAKKR_CAPTURE_ARGS_TEMPLATE",
  "RAKKR_METER_ARGS_TEMPLATE",
  "RAKKR_CAPTURE_FORMAT",
  "RAKKR_CAPTURE_SAMPLE_RATE",
  "RAKKR_CAPTURE_CHANNELS",
  "nodeAudioCommandDefaultsSchema",
  "NodeAudioDefaultsEditor",
  "captureBackend",
  "audioDefaults",
  "apply_audio_defaults",
  "recording jobs carry node audio command defaults",
  "ControllerAudioDefaults",
  "audioDefaultsConfigured",
  "capture_command_args",
  "meter_command_args",
  "command_template_args",
  "builds_arecord_capture_args",
  "builds_pipewire_capture_args",
  "builds_jack_capture_args",
  "builds_templated_capture_args",
  "keeps_quoted_capture_template_segments_as_single_args",
  "accepts_hyphen_leading_command_templates",
  "writeFakeTemplateCaptureCommand",
  "--capture-args-template",
  "job_fake_controller_template_capture",
  "writeFakeTemplateMeterCommand",
  "runTemplateMeterScenario",
  "--meter-args-template",
  "fake-template-meter-device",
  "fake-template-meter-args.json",
  "builds_default_arecord_meter_args",
  "builds_pipewire_meter_args_for_stdout_pcm",
  "builds_jack_meter_args_for_stdout_pcm",
  "builds_templated_meter_args_for_stdout_pcm",
  "parse_alsa_capture_devices",
  "parses_proc_asound_pcm_capture_devices",
  "parse_alsa_stream_metadata",
  "parse_alsa_hw_params_metadata",
  "dump-hw-params",
  "maps_named_alsa_capture_device_to_inventory_id",
  "maps_named_plughw_capture_device_to_inventory_id",
  "maps_key_value_alsa_capture_device_to_inventory_id",
  "maps_named_key_value_plughw_capture_device_to_inventory_id",
  "maps_numeric_plughw_capture_device_to_inventory_id",
  "alsa_device_suffix",
  "parse_alsa_device_request",
  "runtime_audio_backends",
  "runtime_audio_backends_include_available_pipewire_and_jack",
  "accepts_pipewire_capture_and_meter_backends",
  "accepts_jack_capture_and_meter_backends",
  "pipewire_job_uses_pipewire_capture_backend_and_default_command",
  "jack_job_uses_jack_capture_backend_and_default_command",
  "normalize_alsa_token",
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
