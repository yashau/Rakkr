---
title: Read the audit log
description: Filter the immutable record of every privileged action, expand before/after detail, and export a scoped CSV.
sidebar:
  order: 18
---

# Read the audit log

Every privileged action in Rakkr writes an **audit event** — **including denied
attempts and automated service actions** (the scheduler, upload runner, switcher
router). The **Audit** page is your answer to "who changed this, and when?"

> **Who can do this:** `audit:read`.

## What an event records

- the **actor** (and their roles),
- the **permission** that was checked,
- the **target** resource,
- the **outcome** — `allowed`, `denied`, `failed`, `succeeded`, or `partial`,
- a **reason**, correlation IDs, and **before/after snapshots** for writes.

## Find events

1. Open **Audit** in the left nav.
2. Filter by **actor, action, permission, target, outcome, reason,** and **time**.
3. **Expand** any row to see the full detail, including the before/after values
   for a change.
4. **Export** the filtered set as a scoped **CSV** for reporting or archival.

## Why this matters

Nothing in Rakkr happens invisibly. Denied attempts are recorded, so you can see
*attempted* as well as *completed* actions, and automated actions are attributed
to their service identity (for example `system:scheduler`). This is the backbone
of Rakkr's accountability model.

## See also

- [Manage users](manage-users.md) · [Manage groups & access policies](manage-groups-and-access.md) — the access decisions that get audited
- [Authentication & RBAC guide](../guides/authentication-and-rbac.md#audit) — the audit contract
