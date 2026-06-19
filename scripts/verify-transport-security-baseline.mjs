import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/security/TRANSPORT_SECURITY_BASELINE.md";
const sourceFiles = [
  "apps/api/src/transport-security.ts",
  "apps/api/test/transport-security.test.ts",
  "crates/recorder-agent/src/config.rs",
  "docs/observability/prometheus-mimir.example.yml",
];
const requiredEnvVars = [
  "RAKKR_API_TLS_CERT_PATH",
  "RAKKR_API_TLS_KEY_PATH",
  "RAKKR_API_TLS_CA_PATH",
  "RAKKR_CONTROLLER_URL",
  "RAKKR_ALLOW_INSECURE_CONTROLLER",
];
const requiredBaselinePhrases = [
  "transport-layer encryption",
  "HTTPS",
  "non-loopback",
  "Localhost HTTP",
  "explicit development exception",
  "certificate rotation",
  "mutual TLS",
  "mise run security:check-transport",
];
const requiredSourceSnippets = [
  "createHttpsServer",
  'protocol: "https"',
  "readFileSync(certPath)",
  "RAKKR_API_TLS_CERT_PATH and RAKKR_API_TLS_KEY_PATH must be set together",
  "validate_controller_transport",
  "accepts_https_controller_urls",
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
