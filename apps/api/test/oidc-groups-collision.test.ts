import assert from "node:assert/strict";
import test from "node:test";
import { createPgliteDatabase } from "@rakkr/db";
import { accessGroupSlug, type AzureAdOidcClaims } from "@rakkr/shared";

const { LocalAuthService } = await import("../src/auth-service.js");
const { normalizeAzureAdOidcUser } = await import("../src/oidc-sync.js");

// Lets a test hand the normalizer deliberately malformed claim shapes that the
// static AzureAdOidcClaims type would reject.
function normalizeClaims(claims: unknown, extra: { groupIds?: string[] } = {}) {
  return normalizeAzureAdOidcUser({
    claims: claims as AzureAdOidcClaims,
    ...extra,
  });
}

const identity = { sub: "subject-collision", email: "user@example.com" };

test("maps a display-name group claim onto the same slug operators get", () => {
  const normalized = normalizeClaims({ ...identity, groups: ["Room Council"] });

  // The operator-created "Room Council" group derives id `room-council`; the OIDC
  // claim must resolve to that same id, not a divergent `Room Council` group.
  assert.equal(normalized.groups[0]?.id, accessGroupSlug("Room Council"));
  assert.equal(normalized.groups[0]?.id, "room-council");
  assert.equal(normalized.groups[0]?.name, "Room Council");
});

test("collapses case-only duplicate group claims into one group", () => {
  const normalized = normalizeClaims({
    ...identity,
    groups: ["Council", "council", "COUNCIL"],
  });

  assert.deepEqual(
    normalized.groups.map((group) => group.id),
    ["council"],
  );
});

test("caps derived OIDC group ids at the 120-character id budget", () => {
  const normalized = normalizeClaims({ ...identity, groups: ["a".repeat(150)] });

  assert.equal(normalized.groups[0]?.id.length, 120);
});

test("caps the OIDC group display name at the access_groups.name column budget", () => {
  // An uncapped claim (e.g. a full group DN > 160 chars) would trip the
  // access_groups.name varchar(160) constraint on insert, failing the login and
  // latching the auth service into DB-unavailable memory-fallback.
  const normalized = normalizeClaims({ ...identity, groups: ["CN=" + "x".repeat(200)] });

  assert.ok((normalized.groups[0]?.name.length ?? 0) <= 160);
});

test("gives a symbol-only group claim a stable deterministic id", () => {
  const first = normalizeClaims({ ...identity, groups: ["✓✓✓"] });
  const second = normalizeClaims({ ...identity, groups: ["✓✓✓"] });

  assert.match(first.groups[0]?.id ?? "", /^group-[0-9a-f]{12}$/);
  // Same claim on a later login must not spawn a second group.
  assert.equal(first.groups[0]?.id, second.groups[0]?.id);
});

test("merges explicit group ids with slugged claim groups without duplicates", () => {
  const normalized = normalizeClaims(
    { ...identity, groups: ["Room Council", "site-main"] },
    { groupIds: ["room-council"] },
  );

  assert.deepEqual(
    normalized.groups.map((group) => group.id),
    ["room-council", "site-main"],
  );
});

test("treats a non-array groups claim as no groups instead of failing the login", () => {
  const normalized = normalizeClaims({ ...identity, groups: "room-council" });

  assert.deepEqual(normalized.groups, []);
});

test("drops empty and non-string group claim entries", () => {
  const normalized = normalizeClaims({
    ...identity,
    groups: ["ops", "", "   ", 42, null, { id: "x" }],
  });

  assert.deepEqual(
    normalized.groups.map((group) => group.id),
    ["ops"],
  );
});

test("ignores an Azure groups overage pointer without failing", () => {
  const normalized = normalizeClaims({
    ...identity,
    _claim_names: { groups: "src1" },
    _claim_sources: { src1: { endpoint: "https://graph.microsoft.com/v1.0/me/memberOf" } },
  });

  assert.deepEqual(normalized.groups, []);
});

test("still rejects claims missing the strict identity subject", () => {
  assert.throws(() => normalizeClaims({ email: "user@example.com", groups: ["ops"] }));
});

test("syncs a display-name group claim onto the operator slug through the service", async () => {
  const authService = new LocalAuthService("");
  const user = await authService.syncAzureAdOidcUser({
    claims: {
      email: "council@example.com",
      groups: ["Room Council"],
      sub: "subject-service-collision",
    },
  });

  assert.deepEqual(
    user.groups.map((group) => group.id),
    ["room-council"],
  );
});

test("resolves an OIDC claim to an operator group without renaming it", async () => {
  // Real Postgres SQL semantics via an in-process PGlite (WASM Postgres)
  // database — no running server required. Scoped to this test so the fast
  // in-memory normalizer cases above stay server-free.
  const pglite = await createPgliteDatabase("oidc-groups-collision");
  const authService = new LocalAuthService(pglite.url);

  try {
    const created = await authService.groups.createGroup({
      description: undefined,
      memberIds: [],
      name: "Room Council",
    });

    assert.equal(created.id, "room-council");

    // A login whose claim differs only in casing/spacing must join the existing
    // group (Fix A: shared slug) and must not clobber its curated name (Fix B)
    // nor spawn a divergent "room council" twin.
    const user = await authService.syncAzureAdOidcUser({
      claims: {
        email: "db-collision@example.com",
        groups: ["room council"],
        sub: "subject-db-collision",
      },
    });
    const groups = await authService.groups.localGroups();
    const matching = groups.filter((group) => group.id === "room-council");
    const detail = await authService.groups.group("room-council");

    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.name, "Room Council");
    assert.ok(!groups.some((group) => group.id === "room council"));
    assert.ok(detail?.members.some((member) => member.id === user.id));
  } finally {
    await pglite.close();
  }
});
