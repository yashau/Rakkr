import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The web pod's nginx serves the built SPA. Without cache headers the entry
// `index.html` can be cached by browsers/CDNs and pin an operator on a stale
// console after an image bump, while the content-hashed `/assets/` bundles —
// which are safe to cache forever — aren't marked immutable, so they get
// needlessly revalidated. And no gzip means the JS/CSS/JSON payloads ship
// uncompressed. FIX: gzip on for text assets, `Cache-Control: no-cache` on
// index.html (so a fresh build is always picked up), and a far-future immutable
// cache on the hashed /assets/. The SPA `try_files … /index.html` fallback must
// keep working. Invisible to the compose smoke (it never inspects response
// headers or the built asset layout).

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const nginxTemplatePromise = readFile(
  path.join(repoRoot, "deploy/nginx/default.conf.template"),
  "utf8",
);

// The body of the nginx `location` block that serves `locationPath` (matching an
// optional `=` exact-match modifier), or null when absent.
function nginxLocationBody(template: string, locationPath: string): string | null {
  const escaped = locationPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`location\\s*=?\\s*${escaped}\\s*\\{([^}]*)\\}`, "u").exec(template);

  return match ? match[1] : null;
}

test("nginx enables gzip for text/JS/CSS/JSON/SVG payloads", async () => {
  const template = await nginxTemplatePromise;

  assert.match(template, /\bgzip\s+on;/u, "nginx must enable gzip (`gzip on;`)");

  const types = /gzip_types\s+([^;]*);/u.exec(template);
  assert.ok(types, "nginx must set gzip_types so text assets are actually compressed");
  const list = types[1];
  for (const needle of ["javascript", "css", "json", "svg"]) {
    assert.match(
      list,
      new RegExp(needle, "u"),
      `gzip_types should cover ${needle} (got: ${list.trim()})`,
    );
  }
});

test("index.html is served no-cache so a fresh build is always picked up", async () => {
  const template = await nginxTemplatePromise;

  const body = nginxLocationBody(template, "/index.html");
  assert.ok(body, "nginx must define a `location = /index.html` block");
  assert.match(
    body,
    /add_header\s+Cache-Control\s+"no-cache"/u,
    "index.html must carry Cache-Control: no-cache to avoid pinning a stale SPA",
  );
});

test("hashed /assets/ are marked public, immutable, far-future cacheable", async () => {
  const template = await nginxTemplatePromise;

  const body = nginxLocationBody(template, "/assets/");
  assert.ok(body, "nginx must define a `location /assets/` block");
  assert.match(
    body,
    /add_header\s+Cache-Control\s+"public,\s*max-age=31536000,\s*immutable"/u,
    "content-hashed /assets/ should be immutable + far-future cacheable",
  );
});

test("the SPA try_files fallback to /index.html is preserved", async () => {
  const template = await nginxTemplatePromise;

  assert.match(
    template,
    /try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/u,
    "the SPA `try_files $uri $uri/ /index.html` fallback must remain",
  );
});
