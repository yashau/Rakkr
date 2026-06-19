import {
  defaultScheduledVoiceWatchdogPolicy,
  defaultStubUploadPolicy,
  defaultVoiceRecordingProfile,
  type MeterFrame,
  type RecorderNode,
  type RecordingSummary,
  type ScheduleSummary,
} from "@rakkr/shared";

export const nodes: RecorderNode[] = [
  {
    agentVersion: "0.1.0",
    alias: "Council Chamber Rack",
    hostname: "rakkr-x32-01",
    id: "node_x32_test",
    interfaces: [
      {
        alias: "X32 USB",
        backend: "alsa",
        channelCount: 32,
        channels: Array.from({ length: 8 }, (_, index) => ({
          alias: `X32 Channel ${index + 1}`,
          index: index + 1,
        })),
        id: "iface_x32_usb",
        sampleRates: [48000],
        systemName: "Behringer X32 Rack USB",
        systemRef: "alsa:hw:X32,0",
      },
    ],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: new Date().toISOString(),
    location: {
      room: "Council Chamber",
      site: "Main Office",
    },
    notes: "Initial Debian test rig with X32 Rack over USB.",
    runtime: {
      architecture: "x86_64",
      audioBackends: ["alsa"],
      kernelRelease: "test-rig-pending",
      osName: "Debian",
    },
    status: "online",
    tags: ["x32", "voice", "test-rig"],
  },
];

export const schedules: ScheduleSummary[] = [
  {
    enabled: true,
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    id: "sched_council_weekly",
    name: "Council Meeting",
    nodeId: "node_x32_test",
    recurrence: {
      daysOfWeek: ["monday"],
      endTime: "11:00",
      interval: 1,
      mode: "weekly",
      startTime: "09:00",
    },
    recordingProfileId: defaultVoiceRecordingProfile.id,
    room: "Council Chamber",
    tags: ["council", "scheduled", "voice"],
    timezone: "Indian/Maldives",
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}_{{node.alias}}",
    uploadPolicyId: defaultStubUploadPolicy.id,
    watchdogPolicyId: defaultScheduledVoiceWatchdogPolicy.id,
  },
];

export const recordings: RecordingSummary[] = [
  {
    cached: false,
    durationSeconds: 3720,
    folder: "Meetings/2026/06/Council Meeting",
    healthStatus: "unknown",
    id: "rec_demo_001",
    name: "2026-06-15_0900_Council Meeting_Council Chamber Rack",
    nodeId: "node_x32_test",
    recordedAt: "2026-06-15T04:00:00.000Z",
    recordingProfileId: defaultVoiceRecordingProfile.id,
    scheduleId: "sched_council_weekly",
    source: "schedule",
    status: "completed",
    tags: ["council", "voice"],
    uploadPolicyId: defaultStubUploadPolicy.id,
    watchdogPolicyId: defaultScheduledVoiceWatchdogPolicy.id,
  },
];

export function buildMeterFrame(): MeterFrame {
  const capturedAt = new Date().toISOString();
  const phase = Date.now() / 650;
  const forcedLevel = demoMeterDbfsOverride();

  return {
    capturedAt,
    interfaceId: "iface_x32_usb",
    levels: Array.from({ length: 8 }, (_, index) => {
      const wave = Math.sin(phase + index * 0.58);
      const bump = Math.cos(phase / 2 + index * 0.23);
      const rmsDbfs = forcedLevel ?? Math.max(-72, -42 + wave * 12 + bump * 5);
      const peakDbfs = Math.min(-3, rmsDbfs + 11 + Math.abs(wave) * 6);

      return {
        channelIndex: index + 1,
        clipping: peakDbfs > -1,
        label: `Ch ${index + 1}`,
        peakDbfs: Number(peakDbfs.toFixed(1)),
        quality: {
          crestFactorDb: Number((peakDbfs - rmsDbfs).toFixed(2)),
          noiseScore: Number(Math.max(0, 0.3 - Math.abs(wave) * 0.12).toFixed(2)),
          speechLike: rmsDbfs > -55,
          speechScore: Number(Math.max(0, Math.min(1, (rmsDbfs + 65) / 35)).toFixed(2)),
          zeroCrossingRate: Number((0.08 + Math.abs(bump) * 0.08).toFixed(2)),
        },
        rmsDbfs: Number(rmsDbfs.toFixed(1)),
      };
    }),
    nodeId: "node_x32_test",
  };
}

function demoMeterDbfsOverride() {
  const raw = process.env.RAKKR_DEMO_METER_DBFS;

  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? Math.min(24, Math.max(-160, parsed)) : undefined;
}

export function prometheusMetrics() {
  const frame = buildMeterFrame();
  const lines = [
    "# HELP rakkr_node_online Whether a recorder node is online.",
    "# TYPE rakkr_node_online gauge",
    'rakkr_node_online{node_id="node_x32_test",alias="Council Chamber Rack"} 1',
    "# HELP rakkr_recording_active Active recording jobs on a node.",
    "# TYPE rakkr_recording_active gauge",
    'rakkr_recording_active{node_id="node_x32_test"} 0',
    "# HELP rakkr_input_rms_dbfs Current RMS level by audio channel.",
    "# TYPE rakkr_input_rms_dbfs gauge",
    ...frame.levels.map(
      (level) =>
        `rakkr_input_rms_dbfs{node_id="node_x32_test",interface_id="iface_x32_usb",channel="${level.channelIndex}"} ${level.rmsDbfs}`,
    ),
    "# HELP rakkr_input_peak_dbfs Current peak level by audio channel.",
    "# TYPE rakkr_input_peak_dbfs gauge",
    ...frame.levels.map(
      (level) =>
        `rakkr_input_peak_dbfs{node_id="node_x32_test",interface_id="iface_x32_usb",channel="${level.channelIndex}"} ${level.peakDbfs}`,
    ),
  ];

  return `${lines.join("\n")}\n`;
}
