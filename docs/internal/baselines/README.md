---
title: Verification baselines
description: Machine-checked baseline documents — assertion targets for the Rakkr test gate, not end-user documentation.
sidebar:
  order: 99
---

# Verification baselines

> **These are internal contracts, not end-user documentation.** Each file here is
> an **assertion target** for a `scripts/verify-*-baseline.mjs` script that runs in
> `mise run check`. Read [Baselines & verification](../../contributing/baselines.md)
> for how the system works, and the [user-facing guides](../../guides/recording.md)
> for how the features actually behave.

Each baseline describes a subsystem's contracted behavior and is verified against
the source so documentation can't silently drift.

| Baseline                                                                  | Verifier                          | User-facing guide                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| [AZURE_AD_OIDC_BASELINE](AZURE_AD_OIDC_BASELINE.md)                       | `auth:check-oidc`                 | [Authentication & RBAC](../../guides/authentication-and-rbac.md)                                  |
| [RBAC_AUDIT_BASELINE](RBAC_AUDIT_BASELINE.md)                             | `security:check-rbac`             | [Authentication & RBAC](../../guides/authentication-and-rbac.md)                                  |
| [TRANSPORT_SECURITY_BASELINE](TRANSPORT_SECURITY_BASELINE.md)             | `security:check-transport`        | [Transport security](../../guides/transport-security.md)                                          |
| [SCHEDULER_BASELINE](SCHEDULER_BASELINE.md)                               | `scheduler:check`                 | [Scheduling](../../guides/scheduling.md)                                                          |
| [SETTINGS_TEMPLATES_BASELINE](SETTINGS_TEMPLATES_BASELINE.md)             | `settings:check`                  | [Recording](../../guides/recording.md)                                                            |
| [RECORDING_LIBRARY_BASELINE](RECORDING_LIBRARY_BASELINE.md)               | `recordings:check`                | [Recording](../../guides/recording.md)                                                            |
| [FIRST_RELIABLE_RECORDING_BASELINE](FIRST_RELIABLE_RECORDING_BASELINE.md) | `recordings:check-first-reliable` | [Recording](../../guides/recording.md)                                                            |
| [GENERIC_DEVICE_BASELINE](GENERIC_DEVICE_BASELINE.md)                     | `devices:check-generic`           | [Nodes & inventory](../../guides/nodes-and-inventory.md)                                          |
| [HEALTH_WATCHDOG_BASELINE](HEALTH_WATCHDOG_BASELINE.md)                   | `health:check-watchdog`           | [Health watchdog](../../guides/health-watchdog.md)                                                |
| [STORAGE_UPLOAD_BASELINE](STORAGE_UPLOAD_BASELINE.md)                     | `storage:check`                   | [Storage & uploads](../../guides/storage-and-uploads.md)                                          |
| [OPERATIONS_BASELINE](OPERATIONS_BASELINE.md)                             | `operations:check`                | [Recording](../../guides/recording.md) · [Storage & uploads](../../guides/storage-and-uploads.md) |
| [DATE_TIME_BASELINE](DATE_TIME_BASELINE.md)                               | `time:check`                      | —                                                                                                 |
