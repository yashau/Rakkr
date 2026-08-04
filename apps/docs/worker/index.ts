/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker entry for the Rakkr documentation site.
//
// The Starlight build is uploaded as static assets (see `wrangler.jsonc`).
// Cloudflare serves a matching asset before invoking this Worker, so the handler
// runs first for canonical page paths so agents can negotiate Markdown, while
// CSS, JavaScript, images, and other static files still use asset-first routing.
// It also answers `/version.json` so the deployed release is verifiable from the
// edge and delegates everything else back to the static assets.

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

    if (acceptsMarkdown(request) && (request.method === "GET" || request.method === "HEAD")) {
      const markdownResponse = await getPageMarkdown(request, env, url);
      if (markdownResponse) return markdownResponse;
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function acceptsMarkdown(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return false;

  return accept.split(",").some((range) => {
    const [mediaType, ...parameters] = range.split(";").map((part) => part.trim().toLowerCase());
    if (mediaType !== "text/markdown") return false;

    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    return quality ? Number(quality.slice(2)) > 0 : true;
  });
}

async function getPageMarkdown(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | undefined> {
  if (!url.pathname.endsWith("/")) return;

  const markdownUrl = new URL(`${url.pathname}index.md`, url);
  const assetResponse = await env.ASSETS.fetch(
    new Request(markdownUrl, { method: request.method, headers: request.headers }),
  );
  if (!assetResponse.ok) return;

  const headers = new Headers(assetResponse.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set("content-signal", "ai-train=yes, search=yes, ai-input=yes");
  headers.set("vary", appendVary(headers.get("vary"), "Accept"));

  return new Response(request.method === "HEAD" ? null : assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

function appendVary(current: string | null, value: string): string {
  const values = current?.split(",").map((entry) => entry.trim()) ?? [];
  if (values.includes("*")) return "*";
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(", ");
}
