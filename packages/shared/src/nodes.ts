import { z } from "zod";

import { audioCaptureBackendSchema, dbfsSchema, isoDateTimeSchema } from "./base.js";

// "provisioning" is an enrolled node that has never made contact (no bootstrap,
// no heartbeat). It is excluded from liveness/offline monitoring until its first
// heartbeat flips it to a live status — see node-liveness / watchdog-node-liveness.
export const nodeStatusSchema = z.enum([
  "provisioning",
  "online",
  "offline",
  "degraded",
  "recording",
  "alerting",
]);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

// A node is "reachable" (in contact and reporting) when its status is online,
// recording, degraded, or alerting. "offline" (heartbeat gone stale) and
// "provisioning" (enrolled but never contacted) are NOT reachable. Shared by the
// /metrics `rakkr_node_online` gauge and the dashboard active-node count so the
// two cannot diverge on how a never-contacted provisioning node is treated
// (a naive `status !== "offline"` counts provisioning as online — see audit N1/N2).
export function isNodeReachable(status: NodeStatus): boolean {
  return (
    status === "online" || status === "recording" || status === "degraded" || status === "alerting"
  );
}

export const audioChannelSchema = z.object({
  alias: z.string().min(1),
  index: z.number().int().positive(),
  // Room that owns this channel. Room ownership is per-channel: any set of a
  // node's channels can belong to a room, and each channel belongs to at most one
  // room. Absent means the channel inherits the node default room. `roomName` is a
  // denormalized display copy resolved by the controller.
  roomId: z.string().min(1).optional(),
  roomName: z.string().min(1).optional(),
});

export const audioInterfaceSchema = z.object({
  absent: z.boolean().optional(), // flagged absent by inventory reconcile; see node-store
  alias: z.string().min(1),
  backend: z.enum(["alsa", "jack", "pipewire", "unknown"]),
  channelCount: z.number().int().nonnegative(),
  channels: z.array(audioChannelSchema),
  hardwarePath: z.string().min(1).optional(),
  id: z.string().min(1),
  sampleRates: z.array(z.number().int().positive()),
  serialNumber: z.string().min(1).optional(),
  systemName: z.string().min(1),
  systemRef: z.string().min(1).optional(),
});
export const nodeRuntimeSchema = z.object({
  architecture: z.string().min(1).optional(),
  audioBackends: z.array(z.enum(["alsa", "jack", "pipewire", "unknown"])).default([]),
  kernelRelease: z.string().min(1).optional(),
  osName: z.string().min(1).optional(),
  uptimeSeconds: z.number().int().nonnegative().optional(),
});
export const defaultNodeRecordingCapacity = { maxConcurrentRecordings: 1 } as const;
export const nodeRecordingCapacitySchema = z.object({
  maxConcurrentRecordings: z.number().int().positive().max(128),
});
export const nodeAudioCommandDefaultsSchema = z.object({
  captureArgsTemplate: z.string().trim().min(1).max(1000).optional(),
  captureBackend: audioCaptureBackendSchema.optional(),
  captureChannels: z.number().int().positive().max(256).optional(),
  captureCommand: z.string().trim().min(1).max(255).optional(),
  captureDevice: z.string().trim().min(1).max(255).optional(),
  captureFormat: z.string().trim().min(1).max(80).optional(),
  captureSampleRate: z.number().int().positive().max(384_000).optional(),
  meterArgsTemplate: z.string().trim().min(1).max(1000).optional(),
});

export const audioQualitySchema = z.object({
  channelCorrelation: z
    .object({
      peerChannelIndex: z.number().int().positive(),
      phase: z.enum(["same", "inverted"]),
      score: z.number().min(-1).max(1),
    })
    .optional(),
  broadbandNoiseScore: z.number().min(0).max(1).optional(),
  crestFactorDb: z.number().min(0).max(80),
  estimatedSnrDb: z.number().min(0).max(80).optional(),
  humScore: z.number().min(0).max(1).optional(),
  intelligibilityScore: z.number().min(0).max(1).optional(),
  noiseScore: z.number().min(0).max(1),
  speechLike: z.boolean(),
  speechScore: z.number().min(0).max(1),
  staticScore: z.number().min(0).max(1).optional(),
  zeroCrossingRate: z.number().min(0).max(1),
});
export const recorderNodeSchema = z.object({
  agentVersion: z.string().min(1),
  alias: z.string().min(1),
  hostname: z.string().min(1),
  id: z.string().min(1),
  interfaces: z.array(audioInterfaceSchema),
  ipAddresses: z.array(z.string().min(1)),
  lastSeenAt: isoDateTimeSchema,
  location: z.object({
    building: z.string().optional(),
    floor: z.string().optional(),
    room: z.string().min(1),
    site: z.string().min(1),
  }),
  // Node default room. Room ownership is per-channel (see audioChannelSchema);
  // this is the fallback room for channels with no room of their own, and the
  // display fallback for a node whose channels are all in one room. `location`
  // above is retained for physical-install display.
  roomId: z.string().min(1).optional(),
  notes: z.string().optional(),
  audioDefaults: nodeAudioCommandDefaultsSchema.optional(),
  recordingCapacity: nodeRecordingCapacitySchema.optional(),
  runtime: nodeRuntimeSchema.optional(),
  status: nodeStatusSchema,
  tags: z.array(z.string().min(1)),
});

export const audioLevelSchema = z.object({
  channelIndex: z.number().int().positive(),
  clipping: z.boolean(),
  label: z.string().min(1),
  peakDbfs: dbfsSchema,
  quality: audioQualitySchema.optional(),
  rmsDbfs: dbfsSchema,
});

export const meterFrameSchema = z.object({
  capturedAt: isoDateTimeSchema,
  interfaceId: z.string().min(1),
  // Real interfaces have at most a few dozen channels (X32 = 32). Cap the array
  // so a malformed/hostile node frame cannot wedge the watchdog's
  // `Math.max(...levels)` spread with a RangeError — which would poison the
  // stored `latest` frame and silently disable that node's watchdog.
  levels: z.array(audioLevelSchema).max(512),
  nodeId: z.string().min(1),
});

export type AudioChannel = z.infer<typeof audioChannelSchema>;
export type AudioInterface = z.infer<typeof audioInterfaceSchema>;
export type AudioLevel = z.infer<typeof audioLevelSchema>;
export type AudioQuality = z.infer<typeof audioQualitySchema>;
export type MeterFrame = z.infer<typeof meterFrameSchema>;
export type NodeAudioCommandDefaults = z.infer<typeof nodeAudioCommandDefaultsSchema>;
export type NodeRecordingCapacity = z.infer<typeof nodeRecordingCapacitySchema>;
export type NodeRuntime = z.infer<typeof nodeRuntimeSchema>;
export type RecorderNode = z.infer<typeof recorderNodeSchema>;
