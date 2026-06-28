import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Download,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";
import { permissions, type AuditEvent } from "@rakkr/shared";

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type AuditEventFilters } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import {
  auditFilterChips,
  auditFiltersFromDraft,
  auditPagePermissions,
  emptyAuditFilterDraft,
  type AuditFilterDraft,
  type AuditFilterKey,
} from "@/lib/audit-page-helpers";
import { formatDateTime } from "@/lib/dates";

const outcomes = ["allowed", "denied", "failed", "partial", "succeeded"] as const;

const auditFilterDraftKeys: Record<AuditFilterKey, keyof AuditFilterDraft> = {
  action: "action",
  actor: "actor",
  from: "from",
  limit: "limit",
  outcome: "outcome",
  permission: "permission",
  reason: "reason",
  target: "target",
  to: "to",
};

function outcomeClass(outcome: string) {
  if (outcome === "denied" || outcome === "failed") {
    return toneBadgeClass("critical");
  }

  if (outcome === "allowed" || outcome === "succeeded") {
    return toneBadgeClass("healthy");
  }

  return toneBadgeClass("warning");
}

export function AuditPage() {
  const [draft, setDraft] = useState<AuditFilterDraft>(emptyAuditFilterDraft);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<AuditEventFilters>({});
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const pagePermissions = auditPagePermissions(currentUserQuery.data?.data);
  const auditQuery = useQuery({
    enabled: pagePermissions.canRead,
    queryFn: () => api.auditEvents(filters),
    queryKey: ["audit-events", filters],
    refetchInterval: 5000,
  });
  const auditExportMutation = useMutation({
    mutationFn: () => api.auditEventsExport(filters),
    onSuccess: downloadAuditExport,
  });

  const events = auditQuery.data?.data ?? [];
  const activeFilterChips = auditFilterChips(filters);
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

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading audit trail" />;
  }

  if (!pagePermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Audit Trail</AlertTitle>
        <AlertDescription>Audit trail is unavailable.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="overflow-hidden rounded-lg shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Audit Trail</h2>
        <p className="text-sm text-muted-foreground">Permission decisions and controller actions</p>
      </div>

      <form
        className="grid gap-3 border-b border-border bg-panel px-4 py-3 md:grid-cols-2 xl:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(auditFiltersFromDraft(draft));
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
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground" htmlFor="audit-permission">
            Permission
          </Label>
          <Select
            value={draft.permission || "__all__"}
            onValueChange={(value) =>
              updateDraft(
                "permission",
                (value === "__all__" ? "" : value) as AuditFilterDraft["permission"],
              )
            }
          >
            <SelectTrigger
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              id="audit-permission"
            >
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Any</SelectItem>
              {permissions.map((permission) => (
                <SelectItem key={permission} value={permission}>
                  {permission}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <FilterInput
          label="Target"
          onChange={(value) => updateDraft("target", value)}
          value={draft.target}
        />
        <FilterInput
          label="Reason"
          onChange={(value) => updateDraft("reason", value)}
          value={draft.reason}
        />
        <FilterInput
          label="Limit"
          onChange={(value) => updateDraft("limit", value)}
          type="number"
          value={draft.limit}
        />

        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground" htmlFor="audit-outcome">
            Outcome
          </Label>
          <Select
            value={draft.outcome || "__all__"}
            onValueChange={(value) => updateDraft("outcome", value === "__all__" ? "" : value)}
          >
            <SelectTrigger
              id="audit-outcome"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Any</SelectItem>
              {outcomes.map((outcome) => (
                <SelectItem key={outcome} value={outcome}>
                  {outcome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            disabled={!pagePermissions.canExport || auditExportMutation.isPending}
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
              setDraft(emptyAuditFilterDraft);
              setFilters({});
            }}
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-4" />
            Clear
          </Button>
        </div>
        {activeFilterChips.length > 0 ? (
          <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-4">
            {activeFilterChips.map((filter) => (
              <Badge
                className="max-w-full gap-1 overflow-hidden bg-background pr-1"
                key={filter.key}
                variant="outline"
              >
                <span className="shrink-0 text-muted-foreground">{filter.label}</span>
                <span className="truncate font-mono">{filter.value}</span>
                <button
                  aria-label={`Clear ${filter.label} filter`}
                  className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => clearAuditFilter(filter.key)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => {
                setDraft(emptyAuditFilterDraft);
                setFilters({});
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear all
            </Button>
          </div>
        ) : null}
      </form>

      <div className="overflow-x-auto">
        <Table className="w-full text-left text-sm">
          <TableHeader className="border-b border-border bg-stone-50 text-xs text-muted-foreground uppercase">
            <TableRow>
              <TableHead className="px-4 py-3 font-medium">Time</TableHead>
              <TableHead className="px-4 py-3 font-medium">Actor</TableHead>
              <TableHead className="px-4 py-3 font-medium">Action</TableHead>
              <TableHead className="px-4 py-3 font-medium">Permission</TableHead>
              <TableHead className="px-4 py-3 font-medium">Target</TableHead>
              <TableHead className="px-4 py-3 font-medium">Outcome</TableHead>
              <TableHead className="px-4 py-3 font-medium">Reason</TableHead>
              <TableHead className="px-4 py-3 font-medium">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-border">
            {events.length === 0 ? (
              <TableRow>
                <TableCell className="px-4 py-5 text-muted-foreground" colSpan={8}>
                  No audit events yet.
                </TableCell>
              </TableRow>
            ) : (
              events.map((event) => {
                const expanded = expandedEventIds.has(event.id);
                const hasDetails = hasAuditDetails(event);

                return (
                  <Fragment key={event.id}>
                    <TableRow className="bg-panel">
                      <TableCell className="px-4 py-3 whitespace-nowrap">
                        {formatDateTime(event.createdAt)}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="font-medium">{event.actor.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {event.actor.roles.join(", ")}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 font-mono text-xs">{event.action}</TableCell>
                      <TableCell className="px-4 py-3 font-mono text-xs">
                        {event.permission ?? "n/a"}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="font-medium">
                          {event.target.name ?? event.target.id ?? event.target.type}
                        </div>
                        <div className="text-xs text-muted-foreground">{event.target.type}</div>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <Badge className={outcomeClass(event.outcome)} variant="outline">
                          {event.outcome}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {event.reason ?? "n/a"}
                      </TableCell>
                      <TableCell className="px-4 py-3">
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
                      </TableCell>
                    </TableRow>
                    {expanded ? (
                      <TableRow className="bg-muted/20">
                        <TableCell className="px-4 py-3" colSpan={8}>
                          <AuditEventDetails event={event} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );

  function clearAuditFilter(key: AuditFilterKey) {
    setDraft((current) => ({ ...current, [auditFilterDraftKeys[key]]: "" }));
    setFilters((current) => ({ ...current, [key]: undefined }));
  }
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
  type?: "datetime-local" | "number" | "text";
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
