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

export async function writeFakeCaptureCommand(directory) {
  const captureScript = path.join(directory, "fake-capture.mjs");
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
writeFileSync(outputPath, wavFile([0, 12000, -12000, 6000, -6000, 3000]));
await new Promise((resolve) => setTimeout(resolve, 750));

function wavFile(samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(96000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));

  return buffer;
}
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-capture.cmd");
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

function commandShim(scriptPath) {
  return `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`;
}
