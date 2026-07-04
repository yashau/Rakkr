# Rakkr Azure AD OIDC Baseline

Status: MVP baseline checked; live tenant validation remains an integration task.

## Behavior

- Local auth remains available first.
- Azure AD OIDC is disabled by default.
- Enabled OIDC uses Authorization Code + PKCE.
- Login state is stored with a short TTL and protected by the `rakkr_oidc_state` HTTP-only cookie.
- Callback state must match the browser cookie and stored state.
- Successful callbacks create Rakkr bearer sessions for synced OIDC users.
- Logout clears pending OIDC state cookies.
- Public action summaries expose OIDC login readiness without secrets.
- Discovery details and discovery action summaries are visible only through `auth:manage` protected routes.

## Required Environment

| Variable                     | Purpose                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `RAKKR_OIDC_ENABLED`         | Enables Azure AD OIDC when set to `true`, `1`, `yes`, or `on` |
| `RAKKR_OIDC_AZURE_TENANT_ID` | Builds the Azure AD issuer                                    |
| `RAKKR_OIDC_CLIENT_ID`       | Azure app registration client ID                              |
| `RAKKR_OIDC_CLIENT_SECRET`   | Optional confidential-client secret                           |
| `RAKKR_OIDC_REDIRECT_URI`    | Public callback URL ending in `/api/v1/auth/oidc/callback`    |
| `RAKKR_OIDC_SCOPES`          | Optional scopes; defaults to `openid profile email`           |

`RAKKR_OIDC_ISSUER` can override the tenant-derived issuer when needed.

## Routes

| Route                                     | Access                                      |
| ----------------------------------------- | ------------------------------------------- |
| `GET /api/v1/auth/oidc/config`            | Public sanitized config                     |
| `GET /api/v1/auth/oidc/actions`           | Public login/config readiness               |
| `GET /api/v1/auth/oidc/login`             | Starts provider redirect                    |
| `GET /api/v1/auth/oidc/callback`          | Completes login and creates a Rakkr session |
| `GET /api/v1/auth/oidc/discovery/actions` | Requires `auth:manage`                      |
| `GET /api/v1/auth/oidc/discovery`         | Requires `auth:manage`                      |
| `POST /api/v1/auth/logout`                | Clears pending OIDC state cookie            |

## Claim Mapping

| Azure AD Claim                       | Rakkr Use                                |
| ------------------------------------ | ---------------------------------------- |
| `email`, `preferred_username`, `upn` | User email identity                      |
| `name`                               | Display name                             |
| `oid`, `sub`                         | External identity key                    |
| `tid`                                | Tenant identity                          |
| `groups`                             | Rakkr access groups                      |
| `roles`                              | Rakkr roles when names match known roles |

## Account Linking (identity, not email)

An OIDC login is **linked by the IdP subject** (`oid ?? sub`, persisted in
`users.external_id`), never by email — a mutable/attacker-settable email claim
must not let a federated login assume another account. The rules:

- A known subject re-links its existing account (email is a display attribute
  that may change between logins).
- An unknown subject whose email is already owned by a **different** identity
  (a local user — including the built-in local admin — or a different subject)
  is **refused** with `oidc_email_conflict` (HTTP 403); the login is never merged
  onto that row. This closes the email-based local-admin takeover.
- A legacy email-linked OIDC row (created before subject-linking, `external_id`
  null) is adopted on its next login and backfilled with the subject — no
  duplicate account.
- An explicitly `email_verified: false` claim is rejected; absence is tolerated
  because linking is subject-keyed, not email-keyed.

## Group Claim Reconciliation

OIDC `groups` claims and operator-created groups share one store, so they must
derive the same id. Claim values are mapped to a Rakkr group id with the same
`accessGroupSlug` rule used when an operator creates a group:

- A display-name claim (`Room Council`) resolves to the operator slug
  (`room-council`) instead of a divergent second group.
- Case-only variants (`Council`, `council`) collapse to a single group.
- Ids are capped at 120 characters; a claim with no slug-usable characters gets a
  stable, deterministic `group-<hash>` id (so the same claim never spawns
  duplicate groups across logins).
- The raw claim value is kept as the display name. Membership sync creates missing
  groups but never renames an existing one — rename is owned by group management.

`groups` and `roles` are parsed leniently: non-array or malformed values are
treated as no entries so an IdP quirk in these non-identity claims never fails the
login, while identity claims (`sub`, email family) stay strict. An Azure AD groups
overage (`_claim_names.groups`) is detected and logged; those memberships are not
synced (Graph resolution is out of scope).

## Testing

- A real in-process OpenID provider (`oauth2-mock-server`) backs end-to-end OIDC
  tests via `apps/api/test/helpers/oidc-provider-harness.ts`. It serves live
  discovery/JWKS, signs real id_tokens, honours PKCE + nonce, and lets a test set
  the exact claim payload — so the real `openid-client` token-exchange and claim
  path is exercised, not a stubbed login flow.
- `RAKKR_OIDC_ALLOW_INSECURE_ISSUER` permits HTTP for a loopback issuer only, and
  only when explicitly enabled. It exists solely so tests can point the real flow
  at the local fake provider; it can never relax transport security for a remote
  issuer.
- Group-collision and weird-claim coverage lives in
  `apps/api/test/oidc-groups-collision.test.ts`. The in-memory cases run in the
  default suite; the persistence-level cases (group id collision, no-rename on
  login) run in CI via the `node:test-db` task, which provisions a throwaway
  Postgres database (like `db:verify`) and is part of `mise run check`.

## Checked By

| Check                  | Command                    |
| ---------------------- | -------------------------- |
| Azure AD OIDC baseline | `mise run auth:check-oidc` |

`mise run check` runs the OIDC baseline check.
