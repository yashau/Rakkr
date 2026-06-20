import type { HealthEventStatus, Permission } from "@rakkr/shared";

export type ListenMonitorMode = "agent_audio_chunk" | "controller_meter_preview";
export type NodeHealthLifecycleAction = "acknowledge" | "reopen" | "resolve" | "suppress";

export interface NodePageActionPermissions {
  canRead: boolean;
  canReadHealth: boolean;
  canAcknowledgeHealth: boolean;
  canListen: boolean;
  canManage: boolean;
}

export function nodePageActionPermissions(permissions: readonly Permission[]) {
  return {
    canRead: permissions.includes("node:read"),
    canReadHealth: permissions.includes("health:read"),
    canAcknowledgeHealth: permissions.includes("health:acknowledge"),
    canListen: permissions.includes("listen:monitor"),
    canManage: permissions.includes("node:manage"),
  } satisfies NodePageActionPermissions;
}

export function rotateNodeTokenTitle(canManage: boolean, isPersistedNode: boolean) {
  if (!canManage) {
    return "Requires node manage";
  }

  return isPersistedNode ? "Rotate node token" : "Demo node tokens are not persisted";
}

export function listenMonitorModeLabel(mode: ListenMonitorMode) {
  return mode === "agent_audio_chunk" ? "Agent audio" : "Meter preview";
}

export function listenMonitorPollInterval(targetLatencyMs: number) {
  if (!Number.isFinite(targetLatencyMs)) {
    return 1500;
  }

  return Math.min(Math.max(Math.round(targetLatencyMs), 750), 3000);
}

export function nodeHealthLifecycleActions(status: HealthEventStatus): NodeHealthLifecycleAction[] {
  if (status === "resolved") {
    return ["reopen"];
  }

  if (status === "open") {
    return ["acknowledge", "suppress", "resolve"];
  }

  if (status === "acknowledged") {
    return ["suppress", "resolve"];
  }

  return ["resolve"];
}

export function defaultNodeHealthSuppressedUntil(now = new Date()) {
  const suppressedUntil = new Date(now);
  suppressedUntil.setHours(suppressedUntil.getHours() + 1);

  return suppressedUntil.toISOString();
}

export function nodeHealthLifecycleInput(eventId: string, action: NodeHealthLifecycleAction) {
  return {
    action,
    eventId,
    suppressedUntil: action === "suppress" ? defaultNodeHealthSuppressedUntil() : undefined,
  };
}
