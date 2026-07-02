import type { Permission, RoomInput, RoomUpdate } from "@rakkr/shared";

export interface RoomPageActionPermissions {
  canRead: boolean;
  canManage: boolean;
  canManageRoster: boolean;
}

export interface RoomDraft {
  building: string;
  description: string;
  floor: string;
  name: string;
  notes: string;
  site: string;
}

export const emptyRoomDraft: RoomDraft = {
  building: "",
  description: "",
  floor: "",
  name: "",
  notes: "",
  site: "",
};

export function roomPageActionPermissions(
  permissions: readonly Permission[],
): RoomPageActionPermissions {
  return {
    canManage: permissions.includes("node:manage"),
    canManageRoster: permissions.includes("auth:manage"),
    canRead: permissions.includes("node:read"),
  };
}

export function roomDraftFromRoom(room: {
  building?: string;
  description?: string;
  floor?: string;
  name: string;
  notes?: string;
  site: string;
}): RoomDraft {
  return {
    building: room.building ?? "",
    description: room.description ?? "",
    floor: room.floor ?? "",
    name: room.name,
    notes: room.notes ?? "",
    site: room.site,
  };
}

export function roomDraftToInput(draft: RoomDraft): RoomInput {
  return {
    building: trimmedOrUndefined(draft.building),
    description: trimmedOrUndefined(draft.description),
    floor: trimmedOrUndefined(draft.floor),
    name: draft.name.trim(),
    notes: trimmedOrUndefined(draft.notes),
    site: draft.site.trim(),
  };
}

export function roomDraftToUpdate(draft: RoomDraft): RoomUpdate {
  return {
    building: trimmedOrNull(draft.building),
    description: trimmedOrNull(draft.description),
    floor: trimmedOrNull(draft.floor),
    name: draft.name.trim(),
    notes: trimmedOrNull(draft.notes),
    site: draft.site.trim(),
  };
}

function trimmedOrUndefined(value: string): string | undefined {
  const next = value.trim();

  return next || undefined;
}

function trimmedOrNull(value: string): string | null {
  const next = value.trim();

  return next || null;
}
