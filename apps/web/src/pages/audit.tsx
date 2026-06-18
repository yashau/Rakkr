import { useQuery } from "@tanstack/react-query";
import { RotateCcw, Search } from "lucide-react";
import { useState } from "react";
import type { AuditOutcome } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type AuditEventFilters } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

const outcomes = ["allowed", "denied", "failed", "partial", "succeeded"] as const;

interface AuditFilterDraft {
  action: string;
  actor: string;
  from: string;
  outcome: "" | AuditOutcome;
  target: string;
  to: string;
}

const emptyDraft: AuditFilterDraft = {
  action: "",
  actor: "",
  from: "",
  outcome: "",
  target: "",
  to: "",
};

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
  const [draft, setDraft] = useState<AuditFilterDraft>(emptyDraft);
  const [filters, setFilters] = useState<AuditEventFilters>({});
  const auditQuery = useQuery({
    queryFn: () => api.auditEvents(filters),
    queryKey: ["audit-events", filters],
    refetchInterval: 5000,
  });

  const events = auditQuery.data?.data ?? [];
  const updateDraft = (key: keyof AuditFilterDraft, value: string) =>
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));

  return (
    <Card className="overflow-hidden rounded-lg shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Audit Trail</h2>
        <p className="text-sm text-muted-foreground">Permission decisions and controller actions</p>
      </div>

      <form
        className="grid gap-3 border-b border-border bg-panel px-4 py-3 md:grid-cols-[1fr_1fr_1fr_150px] xl:grid-cols-[1fr_1fr_1fr_150px_190px_190px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(filtersFromDraft(draft));
        }}
      >
        <FilterInput
          label="Actor"
          onChange={(value) => updateDraft("actor", value)}
          value={draft.actor}
        />
        <FilterInput
          label="Action"
          onChange={(value) => updateDraft("action", value)}
          value={draft.action}
        />
        <FilterInput
          label="Target"
          onChange={(value) => updateDraft("target", value)}
          value={draft.target}
        />

        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground" htmlFor="audit-outcome">
            Outcome
          </Label>
          <select
            id="audit-outcome"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(event) => updateDraft("outcome", event.target.value)}
            value={draft.outcome}
          >
            <option value="">Any</option>
            {outcomes.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </select>
        </div>

        <FilterInput
          label="From"
          onChange={(value) => updateDraft("from", value)}
          type="datetime-local"
          value={draft.from}
        />
        <FilterInput
          label="To"
          onChange={(value) => updateDraft("to", value)}
          type="datetime-local"
          value={draft.to}
        />

        <div className="flex items-end gap-2">
          <Button className="h-9" type="submit">
            <Search className="size-4" />
            Apply
          </Button>
          <Button
            className="h-9"
            onClick={() => {
              setDraft(emptyDraft);
              setFilters({});
            }}
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-4" />
            Clear
          </Button>
        </div>
      </form>

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

function FilterInput({
  label,
  onChange,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  type?: "datetime-local" | "text";
  value: string;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground" htmlFor={`audit-${label}`}>
        {label}
      </Label>
      <Input
        id={`audit-${label}`}
        className="bg-background"
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
    </div>
  );
}

function filtersFromDraft(draft: AuditFilterDraft): AuditEventFilters {
  return {
    action: valueOrUndefined(draft.action),
    actor: valueOrUndefined(draft.actor),
    from: dateTimeOrUndefined(draft.from),
    outcome: draft.outcome || undefined,
    target: valueOrUndefined(draft.target),
    to: dateTimeOrUndefined(draft.to),
  };
}

function valueOrUndefined(value: string) {
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function dateTimeOrUndefined(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}
