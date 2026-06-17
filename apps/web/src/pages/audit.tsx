import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

function outcomeClass(outcome: string) {
  if (outcome === "denied" || outcome === "failed") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (outcome === "allowed" || outcome === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  return "border-amber-200 bg-amber-50 text-amber-700";
}

export function AuditPage() {
  const auditQuery = useQuery({
    queryFn: api.auditEvents,
    queryKey: ["audit-events"],
    refetchInterval: 5000,
  });

  const events = auditQuery.data?.data ?? [];

  return (
    <Card className="overflow-hidden rounded-lg shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Audit Trail</h2>
        <p className="text-sm text-muted-foreground">Permission decisions and controller actions</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-stone-50 text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Actor</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Permission</th>
              <th className="px-4 py-3 font-medium">Target</th>
              <th className="px-4 py-3 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-muted-foreground" colSpan={6}>
                  No audit events yet.
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr className="bg-panel" key={event.id}>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(event.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{event.actor.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {event.actor.roles.join(", ")}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{event.action}</td>
                  <td className="px-4 py-3 font-mono text-xs">{event.permission ?? "n/a"}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {event.target.name ?? event.target.id ?? event.target.type}
                    </div>
                    <div className="text-xs text-muted-foreground">{event.target.type}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={outcomeClass(event.outcome)} variant="outline">
                      {event.outcome}
                    </Badge>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
