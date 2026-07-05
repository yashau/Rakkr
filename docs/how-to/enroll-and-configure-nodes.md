---
title: Enroll & configure nodes
description: Bring a recorder node online, edit its inventory and channel-to-room assignments, rotate its token, and run remote host lifecycle actions.
sidebar:
  order: 10
---

# Enroll & configure nodes

A **node** is a Linux machine running the recorder agent. This guide gets one
online and set up. Rakkr keeps an inventory of every node, its audio interfaces
and channels, and its live status.

> **Who can do this:** viewing needs `node:read`; enrolling, configuring, and
> lifecycle actions need `node:manage`.

### Recommended: low-touch day-0 (from the console)

Open **Nodes → Enroll Node** and enter just the node's **identity** (alias,
hostname, site, room). On save, the dialog mints a single-use **bootstrap token**
and shows the copy-paste installer one-liner:

```bash
curl -fsSL https://rakkr.org/agent.sh | sudo sh -s -- \
  --controller-url https://controller.example:8787 \
  --bootstrap-token rakkr_bs_… --node-id node_…
```

Run it on the fresh Linux host: it installs the latest agent, generates the
node's own SSH identity, registers, and receives its controller token — hands-free.
The node then heartbeats and reports its hardware. Until its first contact it
shows as **provisioning** ("Awaiting first contact") and is kept out of offline
alerting. See [Node onboarding](../guides/node-onboarding.md) for the full flow.

> **You don't type in hardware.** The agent is the source of truth for hardware:
> on first startup it reports the real interfaces, and the controller reconciles
> them — preserving your labels and channel-map assignments, and flagging any
> removed device as *absent* rather than deleting it.

### By hand (advanced)

To provision without the installer, rotate a **controller token** from the node
card and start the agent yourself with `--controller-url`, `--controller-token`,
and `--node-id` (see the [recorder-agent CLI](../reference/recorder-agent.md)).

## Configure a node

Each node has a **Configure** dialog (titled **"Configure {node name}"**) where
you edit:

- **Identity** — alias, tags, notes.
- **Location** — site, building, floor, default room.
- **Network** — hostname and IPs.
- **Interface & channel aliases**, hardware paths, serials, sample rates.
- **The room each channel belongs to** — a room is one or more channels, and a
  node usually has more channels than any one room, so its channels can be split
  across several rooms (each channel belongs to just one room).
- **Audio command defaults** (capture backend, device, format, rate, channels)
  and the node's **recording capacity**.

All edits are `node:manage` and audited.

## Rotate a node's token

On the node card, use **Rotate Token** to issue a fresh credential; this revokes
the old one immediately. Do this if a token may have leaked or on a routine
rotation schedule.

## Run remote host lifecycle actions (optional)

If you run the optional Ansible runner, the node card's **lifecycle menu** can run
allowlisted host operations over SSH:

| Action                 | What it does                                            |
| ---------------------- | ------------------------------------------------------ |
| `install_dependencies` | Install recorder packages and create the service user. |
| `update_binary`        | Download and install the recorder-agent release.       |
| `restart_service`      | Restart the recorder-agent service.                    |
| `rotate_trust`         | Refresh the controller CA in the host trust store.     |
| `smoke_check`          | Run a quick inventory check and report the output.     |

Every run is audited with its run ID, exit code, target host, and output. This
subsystem is optional and still maturing — if you don't need remote host
management, run agents by hand. See [Node lifecycle](../guides/node-lifecycle.md).

## See also

- [Node onboarding](../guides/node-onboarding.md) — day-0 bootstrap in full
- [Manage rooms](manage-rooms.md) — assign channels to rooms
- [Monitor a room live](monitor-rooms-live.md) — meters and listen-in from a node
- [Nodes & inventory guide](../guides/nodes-and-inventory.md) — the full inventory model
