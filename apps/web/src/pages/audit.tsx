import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, RotateCcw, Search } from "lucide-react";
import { Fragment, useState } from "react";
import type { AuditEvent, AuditOutcome } from "@rakkr/shared";

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
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<AuditEventFilters>({});
  const auditQuery = useQuery({
    queryFn: () => api.auditEvents(filters),
    queryKey: ["audit-events", filters],
    refetchInterval: 5000,
  });
  const auditExportMutation = useMutation({
    mutationFn: () => api.auditEventsExport(filters),
    onSuccess: downloadAuditExport,
  });

  const events = auditQuery.data?.data ?? [];
  const updateDraft = (key: keyof AuditFilterDraft, value: string) =>
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  const toggleEvent = (eventId: string) =>
    setExpandedEventIds((current) => {
      const next = new Set(current);

      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }

      return next;
    });

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
            disabled={auditExportMutation.isPending}
            onClick={() => auditExportMutation.mutate()}
            type="button"
            variant="outline"
          >
            <Download className="size-4" />
            Export
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
              <th className="px-4 py-3 font-medium">Reason</th>
              <th className="px-4 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-muted-foreground" colSpan={8}>
                  No audit events yet.
                </td>
              </tr>
            ) : (
              events.map((event) => {
                const expanded = expandedEventIds.has(event.id);
                const hasDetails = hasAuditDetails(event);

                return (
                  <Fragment key={event.id}>
                    <tr className="bg-panel">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {formatDateTime(event.createdAt)}
                      </td>
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
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {event.reason ?? "n/a"}
                      </td>
                      <td className="px-4 py-3">
                        {hasDetails ? (
                          <Button
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Hide" : "Show"} audit event details`}
                            onClick={() => toggleEvent(event.id)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {expanded ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                            Inspect
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">n/a</span>
                        )}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="bg-muted/20">
                        <td className="px-4 py-3" colSpan={8}>
                          <AuditEventDetails event={event} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function downloadAuditExport(file: Awaited<ReturnType<typeof api.auditEventsExport>>) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function AuditEventDetails({ event }: { event: AuditEvent }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <AuditDetailBlock title="Reason" value={event.reason} />
      <AuditDetailBlock title="Correlation IDs" value={event.correlationIds} />
      <AuditDetailBlock title="Details" value={event.details} />
      <AuditDetailBlock title="Before" value={event.before} />
      <AuditDetailBlock title="After" value={event.after} />
    </div>
  );
}

function AuditDetailBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="grid gap-1 rounded-md border border-border bg-background p-3">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-40 overflow-auto text-xs whitespace-pre-wrap text-foreground">
        {jsonPreview(value)}
      </pre>
    </div>
  );
}

function hasAuditDetails(event: AuditEvent) {
  return Boolean(
    event.reason ||
    valueHasContent(event.correlationIds) ||
    valueHasContent(event.details) ||
    valueHasContent(event.before) ||
    valueHasContent(event.after),
  );
}

function valueHasContent(value: unknown) {
  if (!value) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return typeof value === "object" ? Object.keys(value).length > 0 : true;
}

function jsonPreview(value: unknown) {
  if (!valueHasContent(value)) {
    return "n/a";
  }

  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
