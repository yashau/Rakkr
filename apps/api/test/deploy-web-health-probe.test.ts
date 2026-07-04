import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The web pod is nginx: it serves the static console and proxies `/api` to the
// controller. Its Kubernetes probes must reflect *nginx's* own health, not the
// API's — nginx's `/healthz` location proxies straight to the API, so pointing a
// probe there couples the web tier's lifecycle to the API. A liveness probe on a
// proxied `/healthz` means any API outage (or a slow first-install migration)
// restarts the perfectly-healthy web pods into a crash-loop; a readiness probe on
// it pulls every web pod out of the Service on a transient API blip — and since
// the ingress routes ALL traffic (including `/api`) only to `-web`, that makes the
// API unreachable through the ingress exactly when it is trying to recover. Both
// web probes must therefore hit a self-contained nginx location that returns
// locally without proxying. Invisible to the Compose smoke (its healthcheck is a
// readiness-style depends_on gate that never kills the container, and the API is
// always up during the smoke).

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const nginxTemplate = await readFile(
  path.join(repoRoot, "deploy/nginx/default.conf.template"),
  "utf8",
);
const webDeployment = await readFile(
  path.join(repoRoot, "deploy/helm/rakkr-controller/templates/web-deployment.yaml"),
  "utf8",
);

function probePath(kind: "livenessProbe" | "readinessProbe"): string {
  const match = new RegExp(`${kind}:\\s*\\n\\s*httpGet:\\s*\\n\\s*path:\\s*(\\S+)`, "u").exec(
    webDeployment,
  );
  assert.ok(match, `web deployment must define ${kind}.httpGet.path`);

  return match[1];
}

// The body of the nginx `location` block that serves `locationPath`, or null if
// no such location exists.
function nginxLocationBody(locationPath: string): string | null {
  const escaped = locationPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`location\\s*=?\\s*${escaped}\\s*\\{([^}]*)\\}`, "u").exec(
    nginxTemplate,
  );

  return match ? match[1] : null;
}

test("web liveness probe targets an nginx-local health endpoint, not the API-proxied /healthz", () => {
  const probe = probePath("livenessProbe");

  assert.notEqual(
    probe,
    "/healthz",
    "liveness must not ride the API-proxied /healthz — an API outage would crash-loop the healthy web tier",
  );

  const body = nginxLocationBody(probe);
  assert.ok(body, `nginx must define a local 'location ${probe}' block for the web liveness probe`);
  assert.doesNotMatch(
    body,
    /proxy_pass/u,
    "the web liveness location must be served locally, not proxied to the API",
  );
  assert.match(body, /return\s+200/u, "the local health location must return 200");
});

test("web readiness probe is nginx-local too, so an API blip can't pull the web tier (and thus /api) out of service", () => {
  const probe = probePath("readinessProbe");

  const body = nginxLocationBody(probe);
  assert.ok(
    body,
    `nginx must define a local 'location ${probe}' block for the web readiness probe`,
  );
  assert.doesNotMatch(
    body,
    /proxy_pass/u,
    "the web readiness location must be served locally, not proxied to the API",
  );
});
