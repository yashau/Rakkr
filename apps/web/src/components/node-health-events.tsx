import type { HealthEvent } from "@rakkr/shared";
import { CheckCircle2, RotateCcw, ShieldOff } from "lucide-react";

import { HintButton } from "@/components/hint-button";
import { Badge } from "@/components/ui/badge";
import {
  nodeHealthLifecycleActions,
  type NodeHealthLifecycleAction,
} from "@/lib/node-page-helpers";

export type NodeHealthTone = "critical" | "healthy" | "unknown" | "warning";

export function NodeHealthEvents({
  canManage,
  events,
  healthBadgeClass,
  healthEventDetails,
  healthTone,
  onAction,
  pending,
  readableHealthType,
  renderDateTime,
}: {
  canManage: boolean;
  events: HealthEvent[];
  healthBadgeClass: (tone: NodeHealthTone) => string;
  healthEventDetails: (event: HealthEvent) => string;
  healthTone: (event: HealthEvent) => NodeHealthTone;
  onAction: (event: HealthEvent, action: NodeHealthLifecycleAction) => void;
  pending: boolean;
  readableHealthType: (type: string) => string;
  renderDateTime: (value: string) => string;
}) {
  const recentEvents = [...events]
    .sort((left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt))
    .slice(0, 3);
  const tone = recentEvents.reduce<NodeHealthTone>(
    (current, event) => highestTone(current, healthTone(event)),
    recentEvents.length > 0 ? "healthy" : "unknown",
  );

  return (
    <div className="rounded-md border border-border bg-transparent p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Recent Health Events</div>
        <Badge className={healthBadgeClass(tone)} variant="outline">
          {recentEvents.length}
        </Badge>
      </div>
      {recentEvents.length > 0 ? (
        <div className="grid gap-2">
          {recentEvents.map((event) => (
            <div
              className="grid gap-2 rounded-md border border-border bg-muted/20 p-2"
              key={event.id}
            >
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge className={healthBadgeClass(healthTone(event))} variant="outline">
                      {event.severity}
                    </Badge>
                    <span className="font-medium">{readableHealthType(event.type)}</span>
                    <span className="text-muted-foreground">{event.status}</span>
                    <span className="text-muted-foreground">{renderDateTime(event.openedAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {healthEventDetails(event)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {event.acknowledgedAt ? (
                      <span>Ack {renderDateTime(event.acknowledgedAt)}</span>
                    ) : null}
                    {event.suppressedUntil ? (
                      <span>Muted until {renderDateTime(event.suppressedUntil)}</span>
                    ) : null}
                    {event.resolvedAt ? (
                      <span>Resolved {renderDateTime(event.resolvedAt)}</span>
                    ) : null}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    {nodeHealthLifecycleActions(event.status).map((action) => (
                      <HintButton
                        disabled={pending}
                        hint={nodeHealthActionTitle(action)}
                        key={action}
                        onClick={() => onAction(event, action)}
                        size="sm"
                        variant="outline"
                      >
                        <NodeHealthActionIcon action={action} />
                        {nodeHealthActionLabel(action)}
                      </HintButton>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No node health events.</p>
      )}
    </div>
  );
}

function NodeHealthActionIcon({ action }: { action: NodeHealthLifecycleAction }) {
  if (action === "reopen") {
    return <RotateCcw className="size-4" />;
  }

  if (action === "suppress") {
    return <ShieldOff className="size-4" />;
  }

  return <CheckCircle2 className="size-4" />;
}

function nodeHealthActionLabel(action: NodeHealthLifecycleAction) {
  if (action === "acknowledge") {
    return "Ack";
  }

  return action === "suppress" ? "Mute 1h" : titleCase(action);
}

function nodeHealthActionTitle(action: NodeHealthLifecycleAction) {
  if (action === "suppress") {
    return "Suppress this health event for one hour";
  }

  return titleCase(action);
}

function highestTone(current: NodeHealthTone, next: NodeHealthTone) {
  const order = { critical: 3, warning: 2, unknown: 1, healthy: 0 };

  return order[next] > order[current] ? next : current;
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
