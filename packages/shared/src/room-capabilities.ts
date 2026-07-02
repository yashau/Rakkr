import { z } from "zod";

import type { Permission } from "./index.js";

// The independently-grantable per-action room capabilities. A room roster entry
// carries any subset of these; effective access is the union across a subject's
// direct + group entries for a room.
export const roomCapabilities = [
  "view",
  "listen",
  "download",
  "operate",
  "book",
  "edit",
  "delete",
] as const;
export const roomCapabilitySchema = z.enum(roomCapabilities);
export type RoomCapability = (typeof roomCapabilities)[number];

// Each capability maps to the controller permissions it unlocks WHEN the request
// target resolves to that room. No new global permissions are introduced, and
// node/settings/onboarding/credential permissions are deliberately absent — they
// stay role-based (AV/IT). node:control (recorder-service lifecycle) is NOT part
// of OPERATE for the same reason; OPERATE is start/stop recordings only.
export const roomCapabilityPermissions: Record<RoomCapability, readonly Permission[]> = {
  book: ["schedule:manage"],
  delete: ["recording:delete"],
  download: ["recording:download"],
  edit: ["recording:edit"],
  listen: ["listen:monitor"],
  operate: ["recording:create", "recording:control"],
  view: ["node:read", "recording:read", "recording:playback", "schedule:read", "health:read"],
};

// Default capabilities a calendar meeting-assignment confers on the room. New
// assignments use this; the migration seeds the full prior bundle to avoid a
// silent revoke. (A configurable controller setting can override this later.)
export const defaultCalendarGrantCapabilities: readonly RoomCapability[] = ["view", "operate"];

// The capability a permission requires to be authorized via a room roster, or
// undefined when the permission can never be room-granted (it stays role-based).
export function permissionRequiresCapability(permission: Permission): RoomCapability | undefined {
  return roomCapabilities.find((capability) =>
    roomCapabilityPermissions[capability].includes(permission),
  );
}
