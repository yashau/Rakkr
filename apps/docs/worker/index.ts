/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker entry for the Rakkr documentation site.
//
// The Starlight build is uploaded as static assets (see `wrangler.jsonc`).
// Cloudflare serves a matching asset before invoking this Worker, so the handler
// only runs for non-asset routes. It answers `/version.json` (so the deployed
// release is verifiable from the edge) and delegates everything else back to the
// static assets, including Starlight's generated `404.html`.

interface Env {
  ASSETS: Fetcher;
  RAKKR_DOCS_VERSION: string;
  RAKKR_DOCS_COMMIT: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/version.json") {
      return Response.json(
        {
          version: env.RAKKR_DOCS_VERSION || "0.0.0-dev",
          commit: env.RAKKR_DOCS_COMMIT || "unknown",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
