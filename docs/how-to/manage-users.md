---
title: Manage users
description: Create, edit, disable, and delete users, assign roles, reset passwords, and enable Azure AD single sign-on.
sidebar:
  order: 11
---

# Manage users

The **Access** page is where you decide who has an account and what role they
hold.

> **Who can do this:** `auth:manage`.

## Add a user

1. Open **Access** in the left nav.
2. In the **Users** section, click **New user**.
3. Set the **name**, **email**, an initial **password**, and one or more
   **roles**.
4. Click **Create**.

The five built-in roles, in plain English:

| Role         | What it's for                                                                 |
| ------------ | ----------------------------------------------------------------------------- |
| **owner**    | Everything, including system-level administration.                            |
| **admin**    | Everything except the reserved `system:admin` capability.                     |
| **operator** | The everyday job: record, schedule, monitor, listen, work alerts.             |
| **viewer**   | Read-only: browse, play back, and download.                                   |
| **auditor**  | Compliance: read audit, health, metrics, and recordings — change nothing.     |

Roles set the *ceiling*; a user still needs to be **in scope** for a resource
(via a [room roster](grant-room-access.md) or
[access policy](manage-groups-and-access.md)) to act on it. `owner` and `admin`
bypass scope. See the [permissions reference](../reference/permissions.md).

## Edit, reset, disable, delete

For any user row:

- **Edit** — change name, roles, and enabled state.
- **Reset password** — set a new password.
- **Enable / disable** — the toggle.
- **Delete** — remove the account.

> You **cannot disable or delete your own account.** Disabling, deleting, or
> resetting a user's password immediately **revokes their active sessions**.

## Turn on Azure AD single sign-on

Rakkr supports Microsoft Entra ID via OIDC (Authorization Code + PKCE),
**disabled by default**. When it's enabled, users get a **Sign In With Azure AD**
button, and group/app-role claims can map into Rakkr roles and scoped grants.
Setup and every `RAKKR_OIDC_*` variable are in the
[configuration reference](../reference/configuration.md#oidc--azure-ad).

## See also

- [Manage groups & access policies](manage-groups-and-access.md) — batch access and allow/deny rules
- [Grant access to a room](grant-room-access.md) — scoped per-room access
- [Authentication & RBAC guide](../guides/authentication-and-rbac.md) — the full model
