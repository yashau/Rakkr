import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/auth/AZURE_AD_OIDC_BASELINE.md";
const sourceFiles = [
  "apps/api/src/auth-oidc-routes.ts",
  "apps/api/src/oidc-config.ts",
  "apps/api/src/oidc-login.ts",
  "apps/api/src/oidc-sync.ts",
  "apps/api/src/index.ts",
  "apps/web/src/lib/api.ts",
  "apps/web/src/main.tsx",
  "apps/api/test/oidc-config.test.ts",
  "apps/api/test/oidc-sync.test.ts",
];
const requiredEnvVars = [
  "RAKKR_OIDC_ENABLED",
  "RAKKR_OIDC_AZURE_TENANT_ID",
  "RAKKR_OIDC_CLIENT_ID",
  "RAKKR_OIDC_CLIENT_SECRET",
  "RAKKR_OIDC_REDIRECT_URI",
  "RAKKR_OIDC_SCOPES",
  "RAKKR_OIDC_ISSUER",
];
const requiredRoutes = [
  "GET /api/v1/auth/oidc/config",
  "GET /api/v1/auth/oidc/login",
  "GET /api/v1/auth/oidc/callback",
  "GET /api/v1/auth/oidc/discovery",
  "POST /api/v1/auth/logout",
];
const requiredClaims = ["email", "preferred_username", "upn", "name", "oid", "sub", "tid", "groups", "roles"];
const requiredPhrases = [
  "Authorization Code + PKCE",
  "disabled by default",
  "local auth",
  "rakkr_oidc_state",
  "HTTP-only cookie",
  "short TTL",
  "auth:manage",
  "Logout clears",
  "live tenant validation",
];
const requiredTestPhrases = [
  "derives Azure AD issuer",
  "starts OIDC login with PKCE state cookie",
  "completes OIDC callback into a Rakkr bearer session",
  "rejects OIDC callbacks",
  "clears pending OIDC login state cookies",
  "syncs Azure AD OIDC users",
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
const tests = sourceEntries
  .filter((entry) => entry.path.includes("/test/"))
  .map((entry) => entry.content)
  .join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing OIDC evidence file ${sourceFile}`);
  }
}

for (const envVar of requiredEnvVars) {
  if (!baseline.includes(envVar)) {
    errors.push(`${baselineFile} must document ${envVar}`);
  }

  if (!allSource.includes(envVar)) {
    errors.push(`OIDC source does not reference ${envVar}`);
  }
}

for (const route of requiredRoutes) {
  const routePath = route.replace(/^(GET|POST) /u, "");

  if (!baseline.includes(route)) {
    errors.push(`${baselineFile} must document ${route}`);
  }

  if (!allSource.includes(routePath)) {
    errors.push(`OIDC source does not reference route ${routePath}`);
  }
}

for (const claim of requiredClaims) {
  if (!baseline.includes(`\`${claim}\``)) {
    errors.push(`${baselineFile} must document claim ${claim}`);
  }

  if (!allSource.includes(claim)) {
    errors.push(`OIDC source does not reference claim ${claim}`);
  }
}

for (const phrase of requiredPhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const phrase of requiredTestPhrases) {
  if (!tests.includes(phrase)) {
    errors.push(`OIDC tests must include "${phrase}"`);
  }
}

if (!baseline.includes("mise run auth:check-oidc")) {
  errors.push(`${baselineFile} must document mise run auth:check-oidc`);
}

if (errors.length > 0) {
  console.error(`Invalid Azure AD OIDC baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified Azure AD OIDC baseline in ${baselineFile}.`);
