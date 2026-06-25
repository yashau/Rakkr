import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFakeDfCommand(directory) {
  const fakeBin = path.join(directory, "fake-bin");
  const dfScript = path.join(fakeBin, "df");
  const output = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    "rakkr-smoke 1000 900 100 90% /",
  ].join("\n");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    dfScript,
    `#!/usr/bin/env node
console.log(${JSON.stringify(output)});
`,
  );

  if (process.platform === "win32") {
    await writeFile(
      path.join(fakeBin, "df.cmd"),
      `@echo off\r\n"${process.execPath}" "${dfScript}" %*\r\n`,
    );
  } else {
    await chmod(dfScript, 0o755);
  }

  return fakeBin;
}

export async function writeFakeLoadavgFile(directory) {
  const loadavgPath = path.join(directory, "fake-loadavg");
  await writeFile(loadavgPath, "12.50 0.42 0.10 1/200 1234\n");

  return loadavgPath;
}

export async function writeRecoveringSystemHealthFixtures(directory) {
  const fakeBin = path.join(directory, "fake-system-health-bin");
  const dfScript = path.join(fakeBin, "df");
  const stateFile = path.join(directory, "fake-system-health-state.txt");
  const loadavgPath = path.join(directory, "fake-system-health-loadavg");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(loadavgPath, "12.50 0.42 0.10 1/200 1234\n");
  await writeFile(
    dfScript,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = ${JSON.stringify(stateFile)};
const loadavgPath = ${JSON.stringify(loadavgPath)};
const previousRuns = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) : 0;
const pressureActive = previousRuns === 0;
writeFileSync(stateFile, String(previousRuns + 1));

if (pressureActive) {
  writeFileSync(loadavgPath, "12.50 0.42 0.10 1/200 1234\\n");
  console.log("Filesystem 1024-blocks Used Available Capacity Mounted on");
  console.log("rakkr-smoke 1000 900 100 90% /");
} else {
  writeFileSync(loadavgPath, "0.00 0.00 0.00 1/200 1234\\n");
  console.log("Filesystem 1024-blocks Used Available Capacity Mounted on");
  console.log("rakkr-smoke 1000 100 900 10% /");
}
`,
  );

  if (process.platform === "win32") {
    await writeFile(
      path.join(fakeBin, "df.cmd"),
      `@echo off\r\n"${process.execPath}" "${dfScript}" %*\r\n`,
    );
  } else {
    await chmod(dfScript, 0o755);
  }

  return { fakeDfPath: fakeBin, fakeLoadavgPath: loadavgPath };
}

export async function writeRecoveringAudioInventoryFixtures(directory) {
  const fakeBin = path.join(directory, "fake-audio-inventory-bin");
  const arecordScript = path.join(fakeBin, "arecord");
  const stateFile = path.join(directory, "fake-audio-inventory-state.txt");
  const procAsoundPcmPath = path.join(directory, "missing-proc-asound-pcm");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    arecordScript,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--dump-hw-params")) {
  console.log('HW Params of device "hw:7,0":');
  console.log("CHANNELS: [1 2]");
  console.log("RATE: [48000 48000]");
  process.exit(0);
}

const previousRuns = existsSync(${JSON.stringify(stateFile)})
  ? Number(readFileSync(${JSON.stringify(stateFile)}, "utf8"))
  : 0;
writeFileSync(${JSON.stringify(stateFile)}, String(previousRuns + 1));

console.log("**** List of CAPTURE Hardware Devices ****");
if (previousRuns > 1) {
  console.log("card 7: SMOKE [Smoke Audio], device 0: Capture [Capture]");
  console.log("  Subdevices: 1/1");
  console.log("  Subdevice #0: subdevice #0");
}
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(fakeBin, "arecord.cmd");
    await writeFile(commandPath, commandShim(arecordScript));

    return {
      fakeArecordCommand: commandPath,
      fakeArecordPath: fakeBin,
      fakeProcAsoundPcmPath: procAsoundPcmPath,
    };
  } else {
    await chmod(arecordScript, 0o755);
  }

  return {
    fakeArecordCommand: arecordScript,
    fakeArecordPath: fakeBin,
    fakeProcAsoundPcmPath: procAsoundPcmPath,
  };
}

export async function writeFakeCaptureCommand(directory) {
  return writeFakeCaptureCommandScript(directory, "fake-capture", false);
}

export async function writeFakeTemplateCaptureCommand(directory) {
  return writeFakeCaptureCommandScript(directory, "fake-template-capture", true);
}

export async function writeFakeTemplateMeterCommand(directory) {
  const meterScript = path.join(directory, "fake-template-meter.mjs");
  await writeFile(
    meterScript,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const expected = new Map([
  ["--target", "fake-template-meter-device"],
  ["--rate", "48000"],
  ["--format", "S16_LE"],
  ["--duration", "1"],
  ["--raw", "-"],
]);

if (!args.includes("--template-meter")) {
  console.error("missing template meter marker");
  process.exit(2);
}

for (const [flag, value] of expected) {
  const index = args.indexOf(flag);
  if (index < 0 || args[index + 1] !== value) {
    console.error(\`unexpected \${flag}: \${args[index + 1] ?? "<missing>"}\`);
    process.exit(2);
  }
}

const channelsIndex = args.indexOf("--channels");
const channels = Number(args[channelsIndex + 1]);
if (!Number.isInteger(channels) || channels < 1) {
  console.error("invalid template meter channels");
  process.exit(2);
}

writeFileSync(${JSON.stringify(path.join(directory, "fake-template-meter-args.json"))}, JSON.stringify(args));

const samples = Array.from({ length: channels * 6 }, (_, index) =>
  index % 2 === 0 ? 9000 : -9000,
);
const buffer = Buffer.alloc(samples.length * 2);
samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
process.stdout.write(buffer);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-template-meter.cmd");
    await writeFile(commandPath, commandShim(meterScript));

    return commandPath;
  }

  await chmod(meterScript, 0o755);

  return meterScript;
}

export async function writeFakeStalledCaptureCommand(directory) {
  const captureScript = path.join(directory, "fake-stalled-capture.mjs");
  await writeFile(
    captureScript,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = process.argv.at(-1);

if (!outputPath || outputPath.startsWith("-")) {
  console.error("missing output path");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.from("RIFF-stalled-capture"));
await new Promise((resolve) => setTimeout(resolve, 10000));
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-stalled-capture.cmd");
    await writeFile(commandPath, commandShim(captureScript));

    return commandPath;
  }

  await chmod(captureScript, 0o755);

  return captureScript;
}

export async function writeFakeFailingCaptureCommand(directory) {
  const captureScript = path.join(directory, "fake-failing-capture.mjs");
  await writeFile(
    captureScript,
    `#!/usr/bin/env node
console.error("simulated capture failure");
process.exit(43);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-failing-capture.cmd");
    await writeFile(commandPath, commandShim(captureScript));

    return commandPath;
  }

  await chmod(captureScript, 0o755);

  return captureScript;
}

export async function writeFakeDeviceLostCaptureCommand(directory) {
  const captureScript = path.join(directory, "fake-device-lost-capture.mjs");
  await writeFile(
    captureScript,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = process.argv.at(-1);
if (!outputPath || outputPath.startsWith("-")) {
  console.error("missing output path");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.concat([Buffer.from("RIFF-device-lost"), Buffer.alloc(128)]));
console.error("arecord: pcm_read: Input/output error");
process.exit(32);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-device-lost-capture.cmd");
    await writeFile(commandPath, commandShim(captureScript));

    return commandPath;
  }

  await chmod(captureScript, 0o755);

  return captureScript;
}

export async function writeFakeTinyCaptureCommand(directory) {
  const captureScript = path.join(directory, "fake-tiny-capture.mjs");
  await writeFile(
    captureScript,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = process.argv.at(-1);
if (!outputPath || outputPath.startsWith("-")) {
  console.error("missing output path");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.from("tiny"));
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-tiny-capture.cmd");
    await writeFile(commandPath, commandShim(captureScript));

    return commandPath;
  }

  await chmod(captureScript, 0o755);

  return captureScript;
}

export async function writeFakeXrunMeterCommand(directory) {
  const meterScript = path.join(directory, "fake-xrun-meter.mjs");
  await writeFile(
    meterScript,
    `#!/usr/bin/env node
console.error("overrun!!!");
process.exit(1);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-xrun-meter.cmd");
    await writeFile(commandPath, commandShim(meterScript));

    return commandPath;
  }

  await chmod(meterScript, 0o755);

  return meterScript;
}

export async function writeFakeCaptureFailedMeterCommand(directory) {
  const meterScript = path.join(directory, "fake-capture-failed-meter.mjs");
  await writeFile(
    meterScript,
    `#!/usr/bin/env node
console.error("simulated meter capture failure");
process.exit(1);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-capture-failed-meter.cmd");
    await writeFile(commandPath, commandShim(meterScript));

    return commandPath;
  }

  await chmod(meterScript, 0o755);

  return meterScript;
}

export async function writeFakeRecoveringMeterCommand(directory) {
  const meterScript = path.join(directory, "fake-recovering-meter.mjs");
  const stateFile = path.join(directory, "fake-recovering-meter-state.txt");
  await writeFile(
    meterScript,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";

if (!existsSync(${JSON.stringify(stateFile)})) {
  writeFileSync(${JSON.stringify(stateFile)}, "failed-once");
  console.error("overrun!!!");
  process.exit(1);
}

const samples = [0, 12000, -12000, 6000, -6000, 3000, 1000, -1000];
const buffer = Buffer.alloc(samples.length * 2);
samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
process.stdout.write(buffer);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-recovering-meter.cmd");
    await writeFile(commandPath, commandShim(meterScript));

    return commandPath;
  }

  await chmod(meterScript, 0o755);

  return meterScript;
}

export async function writeFakeDeviceUnavailableMeterCommand(directory) {
  const meterScript = path.join(directory, "fake-device-unavailable-meter.mjs");
  await writeFile(
    meterScript,
    `#!/usr/bin/env node
console.error("ALSA lib pcm.c: unknown pcm fake-device");
process.exit(1);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-device-unavailable-meter.cmd");
    await writeFile(commandPath, commandShim(meterScript));

    return commandPath;
  }

  await chmod(meterScript, 0o755);

  return meterScript;
}

async function writeFakeCaptureCommandScript(directory, commandName, requireTemplateOutputFlag) {
  const captureScript = path.join(directory, `${commandName}.mjs`);
  await writeFile(
    captureScript,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputFlagIndex = process.argv.indexOf("--write-output");
const outputPath = outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : process.argv.at(-1);
const channels = optionNumber(["-c", "--channels"], 1);

if (!outputPath || outputPath.startsWith("-")) {
  console.error("missing output path");
  process.exit(2);
}

if (${JSON.stringify(requireTemplateOutputFlag)} && outputFlagIndex < 0) {
  console.error("missing template output flag");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, wavFile(channels, [0, 12000, -12000, 6000, -6000, 3000]));
await new Promise((resolve) => setTimeout(resolve, 750));

function optionNumber(flags, fallback) {
  for (const flag of flags) {
    const index = process.argv.indexOf(flag);
    if (index >= 0) {
      const value = Number(process.argv[index + 1]);
      return Number.isInteger(value) && value > 0 ? value : fallback;
    }
  }

  return fallback;
}

function wavFile(channels, samples) {
  const dataSize = samples.length * channels * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(48000 * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, frameIndex) => {
    for (let channel = 0; channel < channels; channel += 1) {
      const channelSample = Math.max(-32768, Math.min(32767, sample - channel * 500));
      buffer.writeInt16LE(channelSample, 44 + (frameIndex * channels + channel) * 2);
    }
  });

  return buffer;
}
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, `${commandName}.cmd`);
    await writeFile(commandPath, commandShim(captureScript));

    return commandPath;
  }

  await chmod(captureScript, 0o755);

  return captureScript;
}

export async function writeFakeRenderCommand(directory) {
  const renderScript = path.join(directory, "fake-render.mjs");
  await writeFile(
    renderScript,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const inputIndex = process.argv.indexOf("-i");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
const outputPath = process.argv.at(-1);

if (!inputPath || !outputPath || outputPath.startsWith("-")) {
  console.error("missing input or output path");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
const source = readFileSync(inputPath);
const payload = Buffer.concat([Buffer.from("FAKE_MP3_VBR_128\\n"), source]);
writeFileSync(outputPath, payload);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-render.cmd");
    await writeFile(commandPath, commandShim(renderScript));

    return commandPath;
  }

  await chmod(renderScript, 0o755);

  return renderScript;
}

export async function writeFakeFailingRenderCommand(directory) {
  const renderScript = path.join(directory, "fake-render-failure.mjs");
  await writeFile(
    renderScript,
    `#!/usr/bin/env node
console.error("simulated render failure");
process.exit(42);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-render-failure.cmd");
    await writeFile(commandPath, commandShim(renderScript));

    return commandPath;
  }

  await chmod(renderScript, 0o755);

  return renderScript;
}

function commandShim(scriptPath) {
  return `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`;
}
