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

## Auth Code Flow with PKCE

1. Client generates `code_verifier` and `code_challenge` (S256)
2. Client redirects user to `/api/oauth/auth?client_id=...&code_challenge=...&redirect_uri=...`
3. User sees consent screen at `/oauth/authorize`
4. User approves → redirect back with `code`
5. Client exchanges code + `code_verifier` at `/api/oauth/token`
6. Receives JWT access token + refresh token

## Security

- **PKCE required** (S256 only) per OAuth 2.1 best practices
- **JWT signing**: AWS KMS (RS256) in production, local RSA in dev
- **Token TTLs**: Access=15min, AuthCode=60s, Refresh=24hr
- **Client types**: Public (PKCE only) and Confidential (with client_secret)
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
- Register new clients (public or confidential)
- Configure redirect URIs and allowed scopes
- Revoke clients (deactivates all issued tokens)

## Database Tables

| Table | Purpose |
|-------|---------|
| `oauth_clients` | Registered applications |
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
| `lib/oauth/jwt-signer.ts` | JWT signing factory (KMS or local) |
| `lib/oauth/kms-jwt-service.ts` | AWS KMS signing implementation |
| `lib/oauth/jwks-cache.ts` | JWKS key caching for verification |
| `app/api/oauth/[...oidc]/route.ts` | OIDC endpoint routing |
| `app/.well-known/openid-configuration/route.ts` | Discovery document |
| `app/(protected)/oauth/authorize/page.tsx` | Consent UI |
| `actions/oauth/consent.actions.ts` | Consent server actions |
| `actions/oauth/oauth-client.actions.ts` | Client CRUD actions |

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `KMS_SIGNING_KEY_ARN` | Prod only | — | AWS KMS key for JWT signing |
| `KMS_SIGNING_KEY_KID` | Prod only | — | Key ID for JWKS |
| `OIDC_COOKIE_SECRET` | Recommended | NEXTAUTH_SECRET | Cookie encryption |
| `NEXTAUTH_URL` | Yes | — | Issuer URL |
