import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// With the /api body-size cap lifted to 0 (so nginx never 413s a legitimate
// recorder cache-file upload), stock `proxy_request_buffering on` would spool the
// ENTIRE request body to the web pod's disk before forwarding a single byte to
// the API — defeating the controller's pre-buffer 413 and risking ENOSPC on a
// multi-GB upload. The /api location must therefore stream to the upstream
// (`proxy_request_buffering off`), and because streaming makes the nginx→upstream
// exchange concurrent with the slow client read, the read/send timeouts must
// comfortably exceed a slow multi-GB upload (matching the agent's 3600s overall
// request-timeout default) so a legit slow upload isn't cut. The same must hold
// at the ingress via nginx-ingress annotations. Invisible to the compose/fake-
// controller smokes, which hit the API on :8787 directly and never cross nginx.

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Minimum seconds the streaming read/send timeouts must allow, matching the
// recorder agent's overall request-timeout default (3600s).
const MIN_STREAM_TIMEOUT_SECONDS = 3600;

function parseNginxDurationSeconds(raw: string): number {
  const value = raw.trim().replace(/^"|"$/gu, "");
  const match = /^(\d+)(ms|s|m|h|d)?$/u.exec(value);
  assert.ok(match, `unparseable nginx duration ${JSON.stringify(raw)}`);

  const scale = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 }[match[2] ?? "s"] ?? 1;

  return Number(match[1]) * scale;
}

test("nginx /api location streams the request body to the upstream instead of buffering it to disk", async () => {
  const template = await readFile(
    path.join(repoRoot, "deploy/nginx/default.conf.template"),
    "utf8",
  );

  const apiBlock = /location\s+\/api\/\s*\{([^}]*)\}/u.exec(template);
  assert.ok(apiBlock, "nginx template must define a `location /api/` block");
  const body = apiBlock[1];

  const buffering = /proxy_request_buffering\s+(\S+?);/u.exec(body);
  assert.ok(
    buffering,
    "the /api/ location must set proxy_request_buffering (else nginx spools the whole upload to disk before forwarding)",
  );
  assert.equal(
    buffering[1],
    "off",
    "proxy_request_buffering must be `off` so uploads stream to the upstream",
  );

  const readTimeout = /proxy_read_timeout\s+(\S+?);/u.exec(body);
  assert.ok(
    readTimeout,
    "the /api/ location must set proxy_read_timeout for slow streamed uploads",
  );
  assert.ok(
    parseNginxDurationSeconds(readTimeout[1]) >= MIN_STREAM_TIMEOUT_SECONDS,
    `proxy_read_timeout (${readTimeout[1]}) must allow a slow multi-GB upload (>= ${MIN_STREAM_TIMEOUT_SECONDS}s)`,
  );

  const sendTimeout = /proxy_send_timeout\s+(\S+?);/u.exec(body);
  assert.ok(
    sendTimeout,
    "the /api/ location must set proxy_send_timeout for slow streamed uploads",
  );
  assert.ok(
    parseNginxDurationSeconds(sendTimeout[1]) >= MIN_STREAM_TIMEOUT_SECONDS,
    `proxy_send_timeout (${sendTimeout[1]}) must allow a slow multi-GB upload (>= ${MIN_STREAM_TIMEOUT_SECONDS}s)`,
  );
});

test("helm ingress annotates request-buffering off and raised timeouts for streamed uploads", async () => {
  const values = await readFile(
    path.join(repoRoot, "deploy/helm/rakkr-controller/values.yaml"),
    "utf8",
  );

  const buffering = /nginx\.ingress\.kubernetes\.io\/proxy-request-buffering:\s*(\S+)/u.exec(
    values,
  );
  assert.ok(
    buffering,
    "ingress.annotations must set nginx.ingress.kubernetes.io/proxy-request-buffering (else ingress-nginx buffers the whole upload)",
  );
  assert.equal(
    buffering[1].replace(/^"|"$/gu, ""),
    "off",
    "the ingress proxy-request-buffering annotation must be `off`",
  );

  const readTimeout = /nginx\.ingress\.kubernetes\.io\/proxy-read-timeout:\s*(\S+)/u.exec(values);
  assert.ok(
    readTimeout,
    "ingress.annotations must set nginx.ingress.kubernetes.io/proxy-read-timeout",
  );
  assert.ok(
    parseNginxDurationSeconds(readTimeout[1]) >= MIN_STREAM_TIMEOUT_SECONDS,
    `ingress proxy-read-timeout (${readTimeout[1]}) must allow a slow multi-GB upload (>= ${MIN_STREAM_TIMEOUT_SECONDS}s)`,
  );

  const sendTimeout = /nginx\.ingress\.kubernetes\.io\/proxy-send-timeout:\s*(\S+)/u.exec(values);
  assert.ok(
    sendTimeout,
    "ingress.annotations must set nginx.ingress.kubernetes.io/proxy-send-timeout",
  );
  assert.ok(
    parseNginxDurationSeconds(sendTimeout[1]) >= MIN_STREAM_TIMEOUT_SECONDS,
    `ingress proxy-send-timeout (${sendTimeout[1]}) must allow a slow multi-GB upload (>= ${MIN_STREAM_TIMEOUT_SECONDS}s)`,
  );
});
