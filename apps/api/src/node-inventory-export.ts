import { defaultNodeRecordingCapacity, type RecorderNode } from "@rakkr/shared";

export function nodeInventoryCsv(nodes: RecorderNode[]) {
  return [
    csvRow([
      "id",
      "alias",
      "status",
      "site",
      "building",
      "floor",
      "room",
      "hostname",
      "ip_addresses",
      "agent_version",
      "last_seen_at",
      "os_name",
      "kernel_release",
      "architecture",
      "audio_backends",
      "max_concurrent_recordings",
      "interface_count",
      "interfaces",
      "tags",
      "notes",
    ]),
    ...nodes.map((node) =>
      csvRow([
        node.id,
        node.alias,
        node.status,
        node.location.site,
        node.location.building,
        node.location.floor,
        node.location.room,
        node.hostname,
        node.ipAddresses.join("; "),
        node.agentVersion,
        node.lastSeenAt,
        node.runtime?.osName,
        node.runtime?.kernelRelease,
        node.runtime?.architecture,
        node.runtime?.audioBackends.join("; "),
        String((node.recordingCapacity ?? defaultNodeRecordingCapacity).maxConcurrentRecordings),
        String(node.interfaces.length),
        node.interfaces.map(interfaceCsvSummary).join("; "),
        node.tags.join("; "),
        node.notes,
      ]),
    ),
  ].join("\n");
}

export function nodeExportFileName(now = new Date()) {
  return `rakkr-nodes-${now.toISOString().replaceAll(":", "-")}.csv`;
}

function interfaceCsvSummary(audioInterface: RecorderNode["interfaces"][number]) {
  return [
    `${audioInterface.alias} [${audioInterface.backend}]`,
    audioInterface.systemName,
    `channels=${audioInterface.channelCount}`,
    audioInterface.sampleRates.length > 0
      ? `rates=${audioInterface.sampleRates.join("/")}`
      : undefined,
    audioInterface.serialNumber ? `serial=${audioInterface.serialNumber}` : undefined,
    audioInterface.hardwarePath ? `path=${audioInterface.hardwarePath}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function csvRow(values: Array<number | string | undefined>) {
  return values.map(csvCell).join(",");
}

function csvCell(value: number | string | undefined) {
  const text = value === undefined ? "" : String(value);

  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
