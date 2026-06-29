import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronRight,
  Download,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { permissions, type AuditEvent } from "@rakkr/shared";

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { defaultPageSize } from "@/lib/server-pagination";
import { useServerPagination } from "@/lib/use-server-pagination";

const outcomes = ["allowed", "denied", "failed", "partial", "succeeded"] as const;

const auditFilterDraftKeys: Record<AuditFilterKey, keyof AuditFilterDraft> = {
  action: "action",
  actor: "actor",
  from: "from",
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

const auditColumns: ColumnDef<AuditEvent>[] = [
  {
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDateTime(row.original.createdAt)}</span>
    ),
    header: "Time",
    id: "time",
  },
  {
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.actor.name}</div>
        <div className="text-xs text-muted-foreground">{row.original.actor.roles.join(", ")}</div>
      </div>
    ),
    header: "Actor",
    id: "actor",
  },
  {
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span>,
    header: "Action",
    id: "action",
  },
  {
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.permission ?? "n/a"}</span>
    ),
    header: "Permission",
    id: "permission",
  },
  {
    cell: ({ row }) => (
      <div>
        <div className="font-medium">
          {row.original.target.name ?? row.original.target.id ?? row.original.target.type}
        </div>
        <div className="text-xs text-muted-foreground">{row.original.target.type}</div>
      </div>
    ),
    header: "Target",
    id: "target",
  },
  {
    cell: ({ row }) => (
      <Badge className={outcomeClass(row.original.outcome)} variant="outline">
        {row.original.outcome}
      </Badge>
    ),
    header: "Outcome",
    id: "outcome",
  },
  {
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.reason ?? "n/a"}
      </span>
    ),
    header: "Reason",
    id: "reason",
  },
  {
    cell: ({ row }) => {
      if (!hasAuditDetails(row.original)) {
        return <span className="text-xs text-muted-foreground">n/a</span>;
      }

      const expanded = row.getIsExpanded();

      return (
        <Button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} audit event details`}
          onClick={row.getToggleExpandedHandler()}
          size="sm"
          type="button"
          variant="outline"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Inspect
        </Button>
      );
    },
    header: "Details",
    id: "details",
  },
];

export function AuditPage() {
  const [draft, setDraft] = useState<AuditFilterDraft>(emptyAuditFilterDraft);
  const [filters, setFilters] = useState<AuditEventFilters>({});
  const pagination = useServerPagination(filters, { defaultPageSize });
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const pagePermissions = auditPagePermissions(currentUserQuery.data?.data);
  const auditQuery = useQuery({
    enabled: pagePermissions.canRead,
    placeholderData: keepPreviousData,
    queryFn: () => api.auditEvents(pagination.query),
    queryKey: ["audit-events", pagination.query],
    refetchInterval: 5000,
  });
  const auditExportMutation = useMutation({
    mutationFn: () => api.auditEventsExport(filters),
    onError: () =>
      toast.error("Export failed", {
        description: "The audit event CSV export could not be generated.",
      }),
    onSuccess: downloadAuditExport,
  });

  const events = auditQuery.data?.data ?? [];
  const meta = auditQuery.data?.meta;
  const activeFilterChips = auditFilterChips(filters);
  const updateDraft = (key: keyof AuditFilterDraft, value: string) =>
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));

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

      <div className="grid gap-2 px-4 py-3">
        <DataTable
          columns={auditColumns}
          data={events}
          emptyMessage="No audit events match the current filters."
          getRowId={(event) => event.id}
          isLoading={auditQuery.isPending}
          renderExpandedRow={(event) => (
            <div className="px-4 py-3">
              <AuditEventDetails event={event} />
            </div>
          )}
        />
        <DataTablePagination
          meta={meta}
          onNext={pagination.nextPage}
          onPageSizeChange={pagination.setPageSize}
          onPrevious={pagination.previousPage}
          pageSize={pagination.pageSize}
          pageSizes={pagination.pageSizes}
        />
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
      {type === "datetime-local" ? (
        <DateTimePicker id={`audit-${label}`} onChange={onChange} value={value} />
      ) : (
        <Input
          id={`audit-${label}`}
          className="bg-background"
          onChange={(event) => onChange(event.target.value)}
          type={type}
          value={value}
        />
      )}
    </div>
  );
}
