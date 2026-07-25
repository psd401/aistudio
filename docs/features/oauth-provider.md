# OAuth2/OIDC Provider

Issue #686 — AI Studio as an OAuth2 authorization server and OpenID Connect provider.

## Overview

AI Studio issues JWTs for external service authentication, allowing MCP clients and other applications to authenticate users and access AI Studio APIs.

## OIDC Discovery

```
GET /.well-known/openid-configuration
```

Returns the standard OpenID Connect discovery document with all endpoint URLs.

## Endpoints

| Endpoint | Path | Purpose |
|----------|------|---------|
| Authorization | `/api/oauth/auth` | Start auth code flow |
| Token | `/api/oauth/token` | Exchange code for tokens |
| UserInfo | `/api/oauth/userinfo` | Get user claims |
| JWKS | `/api/oauth/jwks` | Public signing keys |
| Introspection | `/api/oauth/introspection` | Validate tokens |
| Revocation | `/api/oauth/revocation` | Revoke tokens |

oidc-provider's signed, single-use interaction continuation uses the internal
`/auth/:uid` route. Middleware exposes only the provider's exact
43-character URL-safe UID shape, not the surrounding `/auth/*` tree.

## Auth Code Flow with PKCE

1. Client generates `code_verifier` and `code_challenge` (S256)
2. Client redirects user to `/api/oauth/auth?client_id=...&code_challenge=...&redirect_uri=...`
3. AI Studio completes the provider's login prompt with the authenticated
   district user
4. Explicitly trusted first-party clients return immediately; standard clients
   see the consent screen at `/oauth/authorize`
5. When required, the user approves → redirect back with `code`
6. Client exchanges code + `code_verifier` at `/api/oauth/token`
7. Client receives a JWT access token + rotating refresh token

The App Router bridge preserves oidc-provider's status, exact `Location`,
response body, and individual `Set-Cookie` headers. Custom login and consent
completion use oidc-provider's public interaction APIs; no resume URL is
constructed by application code.

## First-party clients

`oauth_clients.is_first_party` is an explicit, default-false trust decision.
It is never inferred from a client name, application type, redirect URI, or
requested scopes. Migration 134 marks only the existing Atrium Capture browser
extension and Mac client IDs as first-party, and only when their exact redirect
and public S256 PKCE registration still match the expected production profile.

First-party authorization still requires a valid district user session. Once
an account is known, `loadExistingGrant` reuses or creates a provider grant
containing only requested scopes present in that client's registered
allowlist. OIDC scopes are stored in the OIDC grant portion; `content:*` scopes
are stored under the AI Studio resource server. Standard clients continue
through explicit consent.

## Security

- **PKCE required** (S256 only) per OAuth 2.1 best practices
- **OIDC JWT signing**: shared RSA-3072 JWK set in Secrets Manager; local RSA only in non-production development
- **Delegated-token signing**: separate non-exportable AWS KMS key
- **Token TTLs**: Access=15min, AuthCode=60s, Refresh=24hr
- **Public-client refresh rotation**: every refresh is single-use; replay revokes the grant family
- **Durability**: provider sessions, interactions, grants, codes, and tokens persist in PostgreSQL across ECS tasks/restarts
- **Application types**: web, browser extension, and native
- **Public clients**: browser extensions and native apps have no secret and always use S256 PKCE
- **First-party trust**: explicit default-deny client metadata; does not bypass
  login, redirect validation, scope allowlists, active-client checks, or PKCE
- **Consent integrity**: grant scopes come from signed provider interaction
  state, never browser-submitted scope lists
- Client secrets hashed with Argon2id

## JWT Claims

```json
{
  "sub": "123",
  "email": "user@example.com",
  "name": "User Name",
  "scope": "openid profile mcp:search_decisions",
  "client_id": "uuid",
  "iss": "https://aistudio.example.com",
  "aud": "https://aistudio.example.com",
  "exp": 1234567890,
  "iat": 1234567890
}
```

## Admin UI

OAuth clients are managed at `/admin/oauth-clients`:
- Register web, browser-extension, and native clients
- Configure redirect URIs and allowed scopes
- Public clients automatically include `openid`, `profile`, and
  `offline_access`; the admin form displays these as required, and the database
  enforces the same invariant
- Revoke clients (deactivates all issued tokens)
- View whether a client has the privileged `First-party` trust designation

First-party trust changes are written to `oauth_client_trust_audit`. Migration
backfills have an explicit source, and later database changes are captured by
the trust audit rule.

Redirect URI validation is application-aware:

| Application type | Accepted redirects |
|---|---|
| Web | Hosted HTTPS URI; no localhost or loopback |
| Browser extension | Exact `https://<32-character-extension-id>.chromiumapp.org/<fixed-path>` |
| Native | Claimed HTTPS DNS URI, reverse-domain private scheme with a fixed path, or HTTP on literal `127.0.0.1`/`[::1]` |

Native loopback redirects may choose an ephemeral port at runtime; scheme,
literal host, path, and query must still match the registration. All profiles
reject fragments, userinfo, wildcards, and dangerous schemes. Stored client
metadata is revalidated when the OIDC provider loads it, so direct database
writes cannot bypass the registration policy.

## Database Tables

| Table | Purpose |
|-------|---------|
| `oauth_clients` | Registered applications |
| `oauth_client_trust_audit` | Append-only first-party trust changes |
| `oauth_authorization_codes` | Short-lived auth codes |
| `oauth_access_tokens` | Issued JWT metadata |
| `oauth_refresh_tokens` | Refresh token rotation |
| `jwks_keys` | Signing key metadata |

## JWT Auth Path

When an API receives a Bearer token that doesn't start with `sk-`, it's treated as a JWT:

```
authenticateRequest() → token starts with "sk-"?
  Yes → API key validation (existing path)
  No  → JWT verification via JWKS
    → Decode kid from header
    → Fetch public key from JWKS cache
    → Verify signature + expiry
    → Extract sub → look up user → ApiAuthContext { authType: "jwt" }
```

## Files

| Path | Purpose |
|------|---------|
| `lib/oauth/oidc-provider-config.ts` | Provider initialization |
| `lib/oauth/drizzle-adapter.ts` | Database adapter for oidc-provider |
| `lib/oauth/first-party-grants.ts` | Explicit first-party grant and interaction policy |
| `lib/oauth/node-http-adapter.ts` | Node/Web request-response bridge |
| `lib/oauth/interaction-service.ts` | Read-only public interaction API adapter |
| `lib/oauth/redirect-uri-policy.ts` | Application-aware redirect security policy |
| `lib/oauth/jwt-signer.ts` | JWT signing factory (KMS or local) |
| `lib/oauth/kms-jwt-service.ts` | AWS KMS signing implementation |
| `lib/oauth/jwks-cache.ts` | JWKS key caching for verification |
| `app/api/oauth/[...oidc]/route.ts` | OIDC endpoint routing |
| `app/auth/[uid]/route.ts` | Provider-generated authorization resume routing |
| `app/.well-known/openid-configuration/route.ts` | Discovery document |
| `app/(protected)/oauth/authorize/page.tsx` | Consent UI |
| `app/(protected)/oauth/authorize/interaction/[uid]/[action]/route.ts` | Login/consent completion |
| `actions/oauth/consent.actions.ts` | Consent server actions |
| `actions/oauth/oauth-client.actions.ts` | Client CRUD actions |

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OIDC_SIGNING_JWKS_SECRET_ARN` | Production | — | Secrets Manager ARN for the shared OIDC-only RSA JWK set |
| `KMS_SIGNING_KEY_ARN` | Prod only | — | Separate KMS key for delegated-agent JWT signing |
| `KMS_SIGNING_KEY_KID` | Prod only | — | Delegated-token KMS key ID |
| `OIDC_COOKIE_SECRET` | Production | AUTH_SECRET (local only) | Dedicated provider cookie encryption/signing key; provisioned and injected by `FrontendStackEcs` |
| `NEXTAUTH_URL` | Yes | — | Issuer URL |

See [OIDC signing-key operations](../operations/oauth-signing-keys.md) for the
threat model, bootstrap, rotation, overlap, health check, and incident runbook.
