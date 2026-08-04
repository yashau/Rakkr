---
title: Releases & versioning
description: How Rakkr's components are versioned and released — calendar versions, per-component git tags, and the workflows each tag triggers.
sidebar:
  order: 2
---

# Releases & versioning

Rakkr is a monorepo with several independently deployable parts (the recorder
agent, the documentation site, and the controller API/web images). Each ships on
its own cadence through a single, deliberate mechanism: **a pushed git tag.**

## Principles

- **Merging to `main` never deploys.** The CI workflow
  (`.github/workflows/ci.yml`) runs checks and builds on every pull request and
  every push to `main`, but it publishes nothing.
- **A pushed tag triggers exactly one component's release.** Each release workflow
  filters on a component-specific tag prefix, so releasing the docs never touches
  the agent.
- **Versions are calendar-based:** `YYYY.MM.DD-N`, where `N` is a same-day counter
  starting at `1` (e.g. `2026.06.28-1`, then `2026.06.28-2` for a second release
  the same day).

## Tag scheme

Tags are `‹component›-v‹YYYY.MM.DD-N›`:

| Component  | Tag example              | Triggers                      |
| ---------- | ------------------------ | ----------------------------- |
| agent      | `agent-v2026.06.28-1`    | `release-agent.yml`           |
| docs       | `docs-v2026.06.28-1`     | `release-docs.yml`            |
| controller | `controller-v2026.06.28-1` | `release-controller.yml`     |

The prefix is slash-free so it is safe inside GitHub release-download URLs and
asset filenames.

## Cutting a release

Use the helper task — it computes the next same-day counter from existing tags,
then creates and pushes the tag:

```powershell
mise run release agent        # or: docs, controller
```

Preview the tag without creating it:

```powershell
node scripts/release.mjs docs --dry-run
```

The pushed tag is what triggers the workflow. You can also run any release
workflow manually from the Actions tab (`workflow_dispatch`) by supplying the
version.

## What each release produces

### Agent (`agent-v*`)

`release-agent.yml` cross-compiles static musl binaries for
`x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` with `cargo-zigbuild`,
stamping the calendar version into the binary via `RAKKR_AGENT_VERSION`. It
publishes a GitHub release (tagged `agent-v…`) with both `.tar.gz` artifacts and
their `.sha256` checksums. The Ansible `update_binary` action consumes these
releases — see [Node lifecycle](../guides/node-lifecycle.md). Asset filenames use
the bare calendar version (`rakkr-recorder-agent-2026.06.28-1-‹target›.tar.gz`).

### Docs (`docs-v*`)

`release-docs.yml` builds the Starlight site and deploys it to Cloudflare Workers
with `wrangler`, served at **docs.rakkr.org**. The deployed version is passed to the
Worker as a variable and is verifiable at `https://docs.rakkr.org/version.json`.
There is no GitHub release — Cloudflare stores the deployment. Requires the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

The docs build also publishes machine-readable discovery artifacts:

- `/llms.txt` points agents to complete and abridged Markdown documentation sets;
- `/llms-full.txt` and `/llms-small.txt` are generated from the same public
  Starlight content collection as the HTML site;
- each public page has a source-aligned Markdown asset at its trailing
  `/index.md` path;
- `/robots.txt` allows crawling and advertises `/sitemap-index.xml`;
- Starlight generates `/sitemap-index.xml` and its sitemap shard from the public
  routes.

The docs Worker implements the **Markdown for Agents** content-negotiation
contract directly, so it also works on Cloudflare's Free plan: a request with
`Accept: text/markdown` returns the matching page's generated Markdown with
`Content-Type: text/markdown`, `Vary: Accept`, and the site's content-use signal.
Static scripts, styles, images, sitemaps, and discovery files remain on
Cloudflare's asset-first path. Verify both discovery paths after a docs release:

```powershell
Invoke-WebRequest https://docs.rakkr.org/llms.txt
Invoke-WebRequest https://docs.rakkr.org/getting-started/introduction/ `
  -Headers @{ Accept = "text/markdown" }
```

### Controller (`controller-v*`)

`release-controller.yml` builds and pushes versioned images to GHCR:
`ghcr.io/‹repo›-api` and `ghcr.io/‹repo›-web` (each tagged with the version and
`latest`). The version is baked in via build args and surfaced on the API's
`/healthz` (`version` field) and the console footer. Publishing the images is the
release; rolling them out with Compose or Helm stays a separate, deliberate step —
see [Deployment](deployment.md).

## Verifying what is deployed

| Component  | How to check the running version            |
| ---------- | ------------------------------------------- |
| agent      | `rakkr-recorder-agent --version`; node inventory `agent_version` |
| docs       | `GET /version.json`                         |
| controller | `GET /healthz` → `version`; console sidebar footer |

Builds that were not stamped from a release tag report `0.0.0-dev`.

## Prerequisites

- **Cloudflare** (docs): a Cloudflare account with the `rakkr.org` zone (so the
  `docs.rakkr.org` custom domain can be provisioned on deploy), plus the
  `CLOUDFLARE_API_TOKEN` (Workers edit scope) and `CLOUDFLARE_ACCOUNT_ID`
  repository secrets.
- **GHCR** (controller): uses the built-in `GITHUB_TOKEN`; the packages may need to
  be made visible after the first push.
