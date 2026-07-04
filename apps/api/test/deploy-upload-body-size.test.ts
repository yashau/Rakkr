import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { recordingCacheUploadMaxBytes } from "../src/agent-cache-upload-body.js";

// The recorder agent PUTs recording renditions/chunks to
// `{controller}/api/v1/recordings/:id/cache-file`, and the API accepts up to
// recordingCacheUploadMaxBytes() (4 GiB default). In every shipped topology that
// traffic traverses the web tier's nginx (docker-compose `controller-web`, and
// the Helm ingress routes ONLY to the `-web` service), so both proxies must
// allow a body at least that large on the upload path — otherwise nginx's 1 MB
// compiled default silently 413s essentially every upload and no recording ever
// leaves the node. These configs are invisible to the compose/fake-controller
// smokes, which hit the API on :8787 directly and never cross nginx.

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Parse an nginx-style byte size ("0" = unlimited, plus k/m/g suffixes) into a
// byte count; unlimited becomes Infinity so it trivially satisfies any floor.
function parseBodySize(raw: string): number {
  const value = raw.trim().replace(/^"|"$/gu, "");

  if (value === "0") {
    return Number.POSITIVE_INFINITY;
  }

  const match = /^(\d+)([kKmMgG]?)$/u.exec(value);
  assert.ok(match, `unparseable body-size value ${JSON.stringify(raw)}`);

  const scale = { "": 1, g: 1024 ** 3, k: 1024, m: 1024 ** 2 }[match[2].toLowerCase()] ?? 1;

  return Number(match[1]) * scale;
}

test("nginx web tier allows recorder cache-file uploads on the /api path", async () => {
  const template = await readFile(
    path.join(repoRoot, "deploy/nginx/default.conf.template"),
    "utf8",
  );

  const apiBlock = /location\s+\/api\/\s*\{([^}]*)\}/u.exec(template);
  assert.ok(apiBlock, "nginx template must define a `location /api/` block");

  const directive = /client_max_body_size\s+(\S+?);/u.exec(apiBlock[1]);
  assert.ok(
    directive,
    "the /api/ location must set client_max_body_size (else nginx's 1 MB default 413s cache-file uploads)",
  );

  assert.ok(
    parseBodySize(directive[1]) >= recordingCacheUploadMaxBytes(),
    `nginx client_max_body_size (${directive[1]}) must allow at least the API cache-upload cap`,
  );
});

test("helm ingress annotates a proxy body size that admits cache-file uploads", async () => {
  const values = await readFile(
    path.join(repoRoot, "deploy/helm/rakkr-controller/values.yaml"),
    "utf8",
  );

  const annotation = /proxy-body-size:\s*(\S+)/u.exec(values);
  assert.ok(
    annotation,
    "ingress.annotations must set nginx.ingress.kubernetes.io/proxy-body-size (else ingress-nginx's 1 MB default 413s cache-file uploads)",
  );

  assert.ok(
    parseBodySize(annotation[1]) >= recordingCacheUploadMaxBytes(),
    `helm proxy-body-size (${annotation[1]}) must allow at least the API cache-upload cap`,
  );
});
