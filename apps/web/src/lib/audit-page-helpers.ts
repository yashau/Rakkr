import type { AuditOutcome, CurrentUser, Permission } from "@rakkr/shared";

import type { AuditEventFilters } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

// Pagination (limit/offset) is owned by the data-table pagination control, not
// the filter draft, so it is excluded from the filter key space.
export type AuditFilterKey = Exclude<keyof AuditEventFilters, "limit" | "offset">;

export interface ActiveAuditFilterChip {
  key: AuditFilterKey;
  label: string;
  value: string;
}

export interface AuditFilterDraft {
  action: string;
  actor: string;
  from: string;
  outcome: "" | AuditOutcome;
  permission: "" | Permission;
  reason: string;
  target: string;
  to: string;
}

export const emptyAuditFilterDraft: AuditFilterDraft = {
  action: "",
  actor: "",
  from: "",
  outcome: "",
  permission: "",
  reason: "",
  target: "",
  to: "",
};

export function auditPagePermissions(user: CurrentUser | undefined) {
  const canRead = user?.permissions.includes("audit:read") ?? false;

  return {
    canExport: canRead,
    canRead,
  };
}

export function auditFiltersFromDraft(draft: AuditFilterDraft): AuditEventFilters {
  return {
    action: valueOrUndefined(draft.action),
    actor: valueOrUndefined(draft.actor),
    from: dateTimeOrUndefined(draft.from),
    outcome: draft.outcome || undefined,
    permission: draft.permission || undefined,
    reason: valueOrUndefined(draft.reason),
    target: valueOrUndefined(draft.target),
    to: dateTimeOrUndefined(draft.to),
  };
}

export function auditFilterChips(filters: AuditEventFilters): ActiveAuditFilterChip[] {
  return auditFilterOrder.flatMap((key) => {
    const value = filters[key];

    if (!value) {
      return [];
    }

    return [
      {
        key,
        label: auditFilterLabels[key],
        value: auditFilterValue(key, value),
      },
    ];
  });
}

function valueOrUndefined(value: string) {
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function dateTimeOrUndefined(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function auditFilterValue(key: AuditFilterKey, value: string) {
  if (key === "from" || key === "to") {
    return formatDateTime(value);
  }

  return value;
}

const auditFilterOrder: AuditFilterKey[] = [
  "actor",
  "action",
  "permission",
  "target",
  "reason",
  "outcome",
  "from",
  "to",
];

const auditFilterLabels: Record<AuditFilterKey, string> = {
  action: "action",
  actor: "actor",
  from: "from",
  outcome: "outcome",
  permission: "permission",
  reason: "reason",
  target: "target",
  to: "to",
};
