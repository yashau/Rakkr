import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/security/TRANSPORT_SECURITY_BASELINE.md";
const sourceFiles = [
  "apps/api/src/transport-security.ts",
  "apps/api/test/transport-security.test.ts",
  "apps/api/test/fixtures/tls/active-cert.pem",
  "apps/api/test/fixtures/tls/active-key.pem",
  "apps/api/test/fixtures/tls/next-cert.pem",
  "apps/api/test/fixtures/tls/next-key.pem",
  "apps/api/test/fixtures/tls/client-ca.pem",
  "crates/recorder-agent/src/config.rs",
  "crates/recorder-agent/src/controller_http.rs",
  "docs/observability/prometheus-mimir.example.yml",
];
const requiredEnvVars = [
  "RAKKR_API_TLS_CERT_PATH",
  "RAKKR_API_TLS_KEY_PATH",
  "RAKKR_API_TLS_CA_PATH",
  "RAKKR_API_TLS_NEXT_CERT_PATH",
  "RAKKR_API_TLS_NEXT_KEY_PATH",
  "RAKKR_API_TLS_NEXT_NOT_BEFORE",
  "RAKKR_API_TLS_CLIENT_CA_PATH",
  "RAKKR_API_TLS_CLIENT_CERT_MODE",
  "RAKKR_CONTROLLER_URL",
  "RAKKR_CONTROLLER_CA_CERT_PATH",
  "RAKKR_ALLOW_INSECURE_CONTROLLER",
];
const requiredBaselinePhrases = [
  "transport-layer encryption",
  "HTTPS",
  "non-loopback",
  "Localhost HTTP",
  "internal controller CA",
  "explicit development exception",
  "certificate-rotation",
  "mutual TLS scaffold",
  "Local TLS fixtures",
  "live certificate reload",
  "mise run security:check-transport",
];
const requiredSourceSnippets = [
  "createHttpsServer",
  "createHash",
  'protocol: "https"',
  "readFileSync(certPath)",
  "certFingerprintSha256",
  "RAKKR_API_TLS_NEXT_CERT_PATH and RAKKR_API_TLS_NEXT_KEY_PATH must be set together",
  "RAKKR_API_TLS_CLIENT_CA_PATH or RAKKR_API_TLS_CA_PATH",
  "RAKKR_API_TLS_CLIENT_CERT_MODE must be off, optional, or required",
  "requestCert",
  "rejectUnauthorized",
  "API listener exposes next certificate material for rotation planning",
  "API listener can require client certificates with a client CA",
  "API listener can request optional client certificates",
  "RAKKR_API_TLS_CERT_PATH and RAKKR_API_TLS_KEY_PATH must be set together",
  "validate_controller_transport",
  "controller_http_client",
  "add_root_certificate",
  "accepts_https_controller_urls",
  "accepts_controller_ca_cert_path",
  "reports_invalid_controller_ca_cert_path",
  "rejects_non_loopback_http_by_default",
  "can_explicitly_allow_insecure_controller_transport",
  "must use HTTPS for non-loopback hosts",
  "scheme: https",
];
const errors = [];

const baseline = await readFile(baselineFile, "utf8");
const sourceEntries = await Promise.all(
  sourceFiles.map(async (sourceFile) => ({
    content: await readFile(sourceFile, "utf8"),
    path: sourceFile,
  })),
);
const allSource = sourceEntries.map((entry) => entry.content).join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing transport evidence file ${sourceFile}`);
  }

  if (!baseline.includes(sourceFile)) {
    errors.push(`${baselineFile} should reference ${sourceFile}`);
  }
}

for (const envVar of requiredEnvVars) {
  if (!baseline.includes(envVar)) {
    errors.push(`${baselineFile} must document ${envVar}`);
  }

  if (!allSource.includes(envVar)) {
    errors.push(`transport source does not reference ${envVar}`);
  }
}

for (const phrase of requiredBaselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of requiredSourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`transport evidence must include "${snippet}"`);
  }
}

if (errors.length > 0) {
  console.error(`Invalid transport security baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified transport security baseline in ${baselineFile}.`);
