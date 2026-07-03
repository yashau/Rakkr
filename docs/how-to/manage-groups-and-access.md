---
title: Manage groups & access policies
description: Create access groups, compose allow/deny access policies and resource grants, and understand how effective access is decided.
sidebar:
  order: 12
---

# Manage groups & access policies

Beyond roles, you shape access with **groups** (to grant many people at once) and
**access policies** (to allow or deny access to specific resources). All of this
lives on the **Access** page.

> **Who can do this:** `auth:manage`.

## Access groups

An **access group** is a named set of users you can assign in one shot to
schedules, room rosters, and access policies.

1. Open **Access** and find the **Groups** section.
2. Click **New group** and give it a **name** and optional **description**.
3. Use **Members** to add or remove users.
4. **Delete** a group to remove it everywhere it was used.

If you use [Azure AD single sign-on](manage-users.md#turn-on-azure-ad-single-sign-on),
group claims from your identity provider sync into these same groups — there is
no separate group system.

## Access policies

An **access policy** is a structured **allow** or **deny** rule for a **subject**
(a user, a group, or everyone) on a **resource**, with a reason. Compose them in
the **Access Policies** section to widen or narrow access beyond what roles give.

- Use an **allow** policy to put a subject *in scope* for a resource.
- Use a **deny** policy to block a subject from a resource.

## How effective access is decided

Access is evaluated in layers:

```text
role permissions ─┐
resource grants   ├─►  allowed?  ──►  unless an explicit DENY policy applies
access policies  ─┘
```

1. **Role** grants the permission (the ceiling).
2. **Scope** — the subject must be in scope for the target (via a resource grant,
   an allow policy, or a [room roster](grant-room-access.md)). `owner` and
   `admin` bypass scope.
3. **Explicit deny wins.** A deny policy overrides any grant or inherited access.

Scope is **hierarchical**: a grant on a node covers the recordings captured
there; a deny on a node blocks its recordings, meters, and controls together.

## See also

- [Manage users](manage-users.md) — accounts and roles
- [Grant access to a room](grant-room-access.md) — per-room scoped capabilities
- [Authentication & RBAC guide](../guides/authentication-and-rbac.md) · [Permissions reference](../reference/permissions.md)
