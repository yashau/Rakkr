// Per-channel room resolution. Room ownership lives on channels
// (audio_channels.room_id); a channel with no room of its own inherits the node
// default room (nodes.room_id). These helpers are the single place that applies
// that fallback so scoping, recording attribution, and meter filtering agree.

import type { RecorderNode } from "@rakkr/shared";

// The interface a capture actually runs against when none is explicitly pinned:
// an explicit id wins, then the RAKKR_AGENT_CAPTURE_INTERFACE_ID env default (what
// the recorder runtime falls back to), then the node's first interface. This is
// the SINGLE source of truth shared by room attribution (resolveScheduleRoom), the
// channel-selection validator, and the runtime capture-target paths, so a persisted
// roomId can never diverge from the interface actually captured (e.g. when the env
// var points at a non-first interface owned by a different room).
export function effectiveCaptureInterfaceId(
  node: Pick<RecorderNode, "interfaces"> | undefined,
  requestedCaptureInterfaceId: string | null | undefined,
): string | undefined {
  if (requestedCaptureInterfaceId) {
    return requestedCaptureInterfaceId;
  }

  // The env default is process-wide, but interface ids are per-node. Only honor it
  // when it actually exists on THIS node; otherwise fall through to the node's first
  // interface. A fleet-wide env naming an interface absent on this node would
  // otherwise make the validator (scheduleChannelSelectionFailure) hard-reject a
  // valid schedule while room attribution (resolveScheduleRoom) silently accepts it
  // against the node default — the two must resolve the same interface. (With no node
  // to check against, keep the raw env fallback.)
  const envInterfaceId = process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID;

  if (
    envInterfaceId &&
    (!node || node.interfaces.some((candidate) => candidate.id === envInterfaceId))
  ) {
    return envInterfaceId;
  }

  return node?.interfaces[0]?.id;
}

// A channel's effective owning room: its own room, else the node default. Returns
// undefined when neither is set (channel belongs to no room).
export function channelRoomId(
  node: RecorderNode,
  interfaceId: string,
  channelIndex: number,
): string | undefined {
  const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);
  const channel = audioInterface?.channels.find((candidate) => candidate.index === channelIndex);

  return channel?.roomId ?? node.roomId;
}

// The set of rooms a node participates in: the effective room of every channel.
// A node with no enumerated channels falls back to its default room so a freshly
// enrolled node stays visible to its room roster. A node whose channels are all
// assigned away from the default no longer surfaces the default room — this is
// what keeps shared-node visibility strict (see scoped* filters).
export function nodeRoomIds(node: RecorderNode): Set<string> {
  const roomIds = new Set<string>();
  let channelCount = 0;

  for (const audioInterface of node.interfaces) {
    for (const channel of audioInterface.channels) {
      channelCount += 1;

      const roomId = channel.roomId ?? node.roomId;

      if (roomId) {
        roomIds.add(roomId);
      }
    }
  }

  if (channelCount === 0 && node.roomId) {
    roomIds.add(node.roomId);
  }

  return roomIds;
}

// The set of rooms an interface participates in: the effective room of each of
// its channels. Used to scope an interface-level target to exactly the rooms it
// serves (an interface may now span rooms).
export function interfaceRoomIds(node: RecorderNode, interfaceId: string): Set<string> {
  const roomIds = new Set<string>();
  const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);

  if (!audioInterface) {
    return roomIds;
  }

  let channelCount = 0;

  for (const channel of audioInterface.channels) {
    channelCount += 1;

    const roomId = channel.roomId ?? node.roomId;

    if (roomId) {
      roomIds.add(roomId);
    }
  }

  if (channelCount === 0 && node.roomId) {
    roomIds.add(node.roomId);
  }

  return roomIds;
}

export type SelectionRoomResolution =
  | { ok: true; roomId: string | undefined }
  | { ok: false; roomIds: string[] };

// The single room a recording/schedule captures, resolved from its selected
// channels (or the whole interface when `channels` is "all"). A recording is one
// room only: when the selection spans more than one room this returns ok:false so
// the caller can reject it. When every selected channel is unassigned the room
// falls back to the node default.
export function resolveSelectionRoom(
  node: RecorderNode,
  interfaceId: string,
  channels: number[] | "all",
): SelectionRoomResolution {
  const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);
  const indexes =
    channels === "all"
      ? (audioInterface?.channels.map((channel) => channel.index) ?? [])
      : channels;
  const rooms = new Set<string>();

  for (const index of indexes) {
    const roomId = channelRoomId(node, interfaceId, index);

    if (roomId) {
      rooms.add(roomId);
    }
  }

  if (rooms.size > 1) {
    return { ok: false, roomIds: [...rooms] };
  }

  const [roomId] = [...rooms];

  return { ok: true, roomId: roomId ?? node.roomId };
}
