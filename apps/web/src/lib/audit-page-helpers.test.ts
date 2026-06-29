import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import {
  auditFilterChips,
  auditFiltersFromDraft,
  auditPagePermissions,
  emptyAuditFilterDraft,
} from "./audit-page-helpers";
import { formatDateTime } from "./dates";

test("audit page read and export require audit read permission", () => {
  assert.deepEqual(auditPagePermissions(undefined), {
    canExport: false,
    canRead: false,
  });
  assert.deepEqual(auditPagePermissions(user(["recording:read"])), {
    canExport: false,
    canRead: false,
  });
  assert.deepEqual(auditPagePermissions(user(["audit:read"])), {
    canExport: true,
    canRead: true,
  });
});

test("audit filters trim draft values and expose active chips", () => {
  const filters = auditFiltersFromDraft({
    ...emptyAuditFilterDraft,
    action: " recordings.download ",
    actor: " alice ",
    from: "2026-06-20T09:30",
    outcome: "succeeded",
    permission: "recording:read",
    reason: " operator ",
    target: " room-101 ",
  });

  assert.deepEqual(filters, {
    action: "recordings.download",
    actor: "alice",
    from: new Date("2026-06-20T09:30").toISOString(),
    outcome: "succeeded",
    permission: "recording:read",
    reason: "operator",
    target: "room-101",
    to: undefined,
  });
  assert.deepEqual(auditFilterChips(filters), [
    { key: "actor", label: "actor", value: "alice" },
    { key: "action", label: "action", value: "recordings.download" },
    { key: "permission", label: "permission", value: "recording:read" },
    { key: "target", label: "target", value: "room-101" },
    { key: "reason", label: "reason", value: "operator" },
    { key: "outcome", label: "outcome", value: "succeeded" },
    {
      key: "from",
      label: "from",
      value: formatDateTime(new Date("2026-06-20T09:30").toISOString()),
    },
  ]);
});

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "auditor@example.test",
    groups: [],
    id: "user_auditor",
    name: "Auditor",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["auditor"],
  };
}
