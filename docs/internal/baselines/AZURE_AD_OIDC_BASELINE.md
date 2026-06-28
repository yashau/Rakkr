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

## Checked By

| Check                  | Command                    |
| ---------------------- | -------------------------- |
| Azure AD OIDC baseline | `mise run auth:check-oidc` |

`mise run check` runs the OIDC baseline check.
