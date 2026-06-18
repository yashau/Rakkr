import type { Context, MiddlewareHandler } from "hono";
import type { AuditEvent, AuditOutcome, Permission } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";

export type AppBindings = {
  Variables: {
    auth: AuthResult;
  };
};

export type AuditTarget = AuditEvent["target"];

export type RecordAuditEvent = (
  c: Context<AppBindings>,
  input: {
    action: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
    correlationIds?: Record<string, string>;
    details?: Record<string, unknown>;
    outcome: AuditOutcome;
    permission?: Permission;
    reason?: string;
    target: AuditTarget;
    auth?: AuthResult;
  },
) => Promise<AuditEvent>;

export type RequirePermission = (
  permission: Permission,
  action: string,
  target?: (c: Context<AppBindings>) => AuditTarget | Promise<AuditTarget>,
) => MiddlewareHandler<AppBindings>;
