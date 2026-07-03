---
title: Web console
description: The React operator console — stack, client auth, permission-aware UI, navigation, and the pages operators use.
sidebar:
  order: 4
---

# Web console

The operator console is a React single-page app in `apps/web`, entrypoint
`src/main.tsx`. It is the day-to-day surface for operators; everything it does
goes through the [controller API](controller-api.md), and every privileged
control mirrors the same RBAC the API enforces.

## Stack

- **React 19 + Vite** with TypeScript.
- **TanStack Router** for code-defined routing and **TanStack Query** for server
  state (most screens auto-refetch on a short interval).
- **Tailwind 4** with local shadcn/ui-style primitives (`src/components/ui`) over
  Radix, `lucide-react` icons, and `sonner` toasts.
- Shared domain types come from `@rakkr/shared`, so request/response shapes stay
  in sync with the API.

## Client auth and session

Auth is bearer-token based. The token is stored in `localStorage`
(`rakkr.authToken`) and attached to every request. `RootLayout` is the gate: with
no valid token it renders the login screen; otherwise it loads the current user
(`GET /auth/me`) and renders the shell.

- **Local login** posts email/password and stores the returned token.
- **Azure AD / OIDC**, when enabled, redirects to the IdP and reads the token back
  from the callback URL hash.
- **Logout** revokes the session and clears cached queries.

## Permission-aware UI

The current user carries a `permissions` array. Each page derives booleans from
it via a tested `*PagePermissions` helper in `src/lib`. The consistent rule:

- Missing **read** permission → the page renders an "unavailable" card.
- Granular `canX` flags **disable** (not just hide) controls, usually with a
  tooltip explaining what's required.

This mirrors server RBAC for usability — but the **API is the enforcement
point**. UI gating never substitutes for it. The console has regression tests
that prevent inline permission checks from creeping in outside the helpers.

## Navigation shell

`RootLayout` is a fixed sidebar (desktop) + sticky header, with a drawer on small
screens. Nav items are filtered by permission (`rootLayoutNavItems`): Dashboard
and Nodes need `node:read`, Rooms need `node:read`, Health needs `health:read`,
Schedules need `schedule:read`, Recordings and Jobs need `recording:read`,
Settings needs `settings:read`, Audit needs `audit:read`, Access needs
`auth:manage`. The header
**Record** quick-action is enabled only with `recording:create` + `node:read` +
`settings:read`.

## Dark mode

The console theme is provided by `next-themes` (`ThemeProvider` with
`attribute="class"`, `defaultTheme="system"`, and `enableSystem`), so it follows
the OS preference by default. Operators flip it with the `theme-toggle`
component. Styling uses `.dark` design tokens throughout — never hardcode
light-only colors.

## Pages

| Page                | Path             | What operators do                                                                                                                                                   | Gated by                                                                         |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Dashboard**       | `/`              | KPI tiles, a live meter bank for a selected node, active jobs, quick-record, and active incidents with acknowledge/resolve.                                         | `node:read`; actions need `recording:*` / `health:acknowledge`                   |
| **Nodes**           | `/nodes`         | Enroll nodes; filter/search/export inventory; per-node health tiles, trend, listen, token rotation, lifecycle menu, identity/interface editors.                     | `node:read`; manage actions need `node:manage`; listen needs `listen:monitor`    |
| **Recordings**      | `/recordings`    | Browse the library with filters/facets/sort/pagination; play, download, edit metadata, delete, queue uploads; bulk organize; export manifests.                      | `recording:read`; actions need `recording:control/edit/delete/playback/download` |
| **Jobs**            | `/jobs`          | Monitor recording jobs with status tiles and filters; retry/stop (single + bulk); export.                                                                           | `recording:read`; control needs `recording:control`                              |
| **Schedules**       | `/schedules`     | Create/edit schedules (recurrence, buffers, pauses, templates, policies); run-now, skip-next, delete.                                                               | `schedule:read`; mutations need `schedule:manage`                                |
| **Schedule detail** | `/schedules/$scheduleId` | Upcoming windows, linked recordings/jobs, quality timelines, health events, audit timeline.                                                                 | `schedule:read` + granular reads                                                 |
| **Schedule calendar** | `/schedules/calendar` | Windowed occurrences across all schedules with room + assignee context and window navigation; drag an occurrence to reschedule it.                              | `schedule:read`; drag-to-reschedule needs `schedule:manage`                      |
| **Rooms**           | `/rooms`         | Browse rooms; create/edit/delete room identity and their access roster.                                                                                             | `node:read`; the roster editor needs `auth:manage`                               |
| **Room detail**     | `/rooms/$roomId` | Editable name/location/notes, the room's node inventory, upcoming scheduled occurrences (with who booked), recent recordings, and the roster editor.                | `node:read`; the roster editor needs `auth:manage`                               |
| **Health**          | `/health`        | Search/filter health events; acknowledge, suppress, resolve, reopen (single + bulk); export.                                                                        | `health:read`; lifecycle needs `health:acknowledge`                              |
| **Settings**        | `/settings`      | A controller section (controller name + "Week starts on" selector), recording profiles, watchdog policies (+ calibration), Upload Destinations, Upload Policies, retention, the upload runner, channel maps (templates, assignments, rollout), and an audio-matrix Switchers section. | `settings:read`; mutations need `settings:manage`                                |
| **Access**          | `/access`        | Manage access policies, local users, roles, groups, and resource grants.                                                                                            | entire page needs `auth:manage`                                                  |
| **Audit**           | `/audit`         | Filter the audit log by actor/action/permission/target/outcome/time; expand before/after and correlation IDs; export.                                               | `audit:read`                                                                     |

## Notable components

- **`meter-bank`** — live per-channel meters with RMS bars, peak markers, clip
  indicators, and per-channel speech/SNR/correlation stats.
- **`node-lifecycle-menu`** — the allowlisted SSH lifecycle actions; renders only
  with `node:manage`.
- **`listen-monitor-panel`** — live listen-in into an `<audio>` element.
- **`recording-card`** / **`recording-playback-dock`** / **`quality-timeline`** —
  the recording library row, the docked player, and the per-recording health
  timeline.
- **`recording-start-panel`** — the ad-hoc/quick recording form.
- **`room-roster-editor`** — edits a room's manual access roster (subject +
  capabilities); calendar-derived entries are read-only.
- **`subject-combobox`** / **`user-multi-select`** / **`group-multi-select`** —
  the shared searchable user/group picker used by schedules, room rosters, and
  the access-policy composer.
- Settings panels (watchdog policy card with calibration, upload runner/policy,
  retention) and access composers (policy + resource grant builders).

## Dev server and API wiring

`pnpm --filter @rakkr/web dev` runs Vite on **port 5173**. In dev, Vite proxies
`/api`, `/healthz`, and `/metrics` to the API on `8787`, so the browser uses a
single origin (no CORS). The only client env var is `VITE_API_BASE` (default
empty = same-origin); set it to point a build at a non-proxied API host. In
production the console is served by nginx, which performs the same proxying — see
[Deployment](../operations/deployment.md).
