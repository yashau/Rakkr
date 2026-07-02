import type { Permission, ScheduleSummary } from "@rakkr/shared";

// Minimal structural shapes so this policy module stays dependency-light and
// unit-testable without the full request/auth machinery. Real CurrentUser and
// NodeRecord values satisfy these by structural typing.
export type AssignmentUser = { groups: { id: string }[]; id: string };
export type AssignmentNode = { id: string; location: { room: string; site: string } };
type ScopeTarget = { id?: string; type: string };
type AssignableSchedule = Pick<
  ScheduleSummary,
  "assignedGroupIds" | "assignedUserIds" | "nodeId"
>;

// The "maximum flexibility" capability bundle a schedule assignment confers over
// its room's resources (see requirePermission in index.ts). Every entry is a
// RESOURCE-SCOPABLE operational permission — what an operator does inside a room.
// Global/infrastructure permissions (auth:manage, node:manage, settings:*,
// metrics:read, audit:read, system:admin) are deliberately excluded; they have
// no room target to resolve against, so assignment can never escalate to them.
// Two invariants keep this safe: (1) an explicit deny access-policy always
// overrides an assignment, and (2) assignment only authorizes a permission when
// the request target resolves to an assigned room. Narrow this set to reduce
// what assignment unlocks (keep RBAC_AUDIT_BASELINE.md + its verifier in sync).
export const ASSIGNMENT_CAPABILITIES: ReadonlySet<Permission> = new Set<Permission>([
  "health:acknowledge",
  "health:read",
  "listen:monitor",
  "node:control",
  "node:read",
  "recording:control",
  "recording:create",
  "recording:delete",
  "recording:download",
  "recording:edit",
  "recording:playback",
  "recording:read",
  "schedule:manage",
  "schedule:read",
]);

export function scheduleAssignsUser(schedule: AssignableSchedule, user: AssignmentUser) {
  return (
    schedule.assignedUserIds.includes(user.id) ||
    schedule.assignedGroupIds.some((groupId) => user.groups.some((group) => group.id === groupId))
  );
}

// Composite `<site>/<room>` key — the stable room identity used to match a
// target's expanded room scope against a user's assigned rooms. Keyed on the
// physical site+room so access follows the hardware, not free-text labels.
export function compositeRoomKey(site: string | undefined, room: string | undefined) {
  return site && room ? `${site}/${room}` : undefined;
}

// Every room the user is assigned to (directly or via an access group), keyed on
// the assigned schedule's NODE's physical room. Schedules whose node is unknown
// or lacks a site/room contribute nothing.
export function assignedRoomKeysFor(
  schedules: AssignableSchedule[],
  nodes: AssignmentNode[],
  user: AssignmentUser,
) {
  const keys = new Set<string>();

  for (const schedule of schedules) {
    if (!scheduleAssignsUser(schedule, user)) {
      continue;
    }

    const node = nodes.find((candidate) => candidate.id === schedule.nodeId);
    const key = node ? compositeRoomKey(node.location.site, node.location.room) : undefined;

    if (key) {
      keys.add(key);
    }
  }

  return keys;
}

export function nodeInAssignedRoom(node: AssignmentNode, assignedKeys: ReadonlySet<string>) {
  const key = compositeRoomKey(node.location.site, node.location.room);

  return key !== undefined && assignedKeys.has(key);
}

// True when any of the target's expanded scope entries is a room the user is
// assigned to. Only composite `<site>/<room>` room targets can match (assigned
// keys are always composite), so bare-room and site targets never over-match.
export function roomTargetsMatchAssignedKeys(
  targets: ScopeTarget[],
  assignedKeys: ReadonlySet<string>,
) {
  if (assignedKeys.size === 0) {
    return false;
  }

  return targets.some(
    (target) => target.type === "room" && target.id !== undefined && assignedKeys.has(target.id),
  );
}
