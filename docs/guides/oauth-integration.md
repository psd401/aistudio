# OAuth2 Integration Guide

Authenticate external applications with AI Studio using OAuth2/OIDC with Authorization Code Flow and PKCE.

## Overview

AI Studio acts as an OAuth2/OIDC Provider, allowing external applications to:
- Authenticate users via their AI Studio identity
- Request scoped access to AI Studio APIs and MCP tools
- Use standard OIDC tokens (access, refresh, ID)

**When to use OAuth vs API keys:**
- **API keys**: Personal automation, CLI tools, scripts
- **OAuth**: Third-party apps that act on behalf of multiple users

## Registering an OAuth Client

1. Log in as an **administrator**
2. Navigate to **Admin > OAuth Clients** (`/admin/oauth-clients`)
3. Click **Register New Client**
4. Fill in:
   - **Client Name**: Display name shown during consent
   - **Redirect URIs**: Where users return after authorization (e.g., `http://localhost:3000/callback`)
   - **Client Type**: Public (PKCE only, for SPAs/mobile) or Confidential (with client secret, for backends)
   - **Allowed Scopes**: Select which permissions the client can request
5. Save — copy the **Client ID** (and **Client Secret** for confidential clients) immediately

## OIDC Discovery

The discovery document is at:
```
https://your-domain.com/.well-known/openid-configuration
```

## Authorization Code Flow with PKCE

All clients must use PKCE (S256). Plain challenge method is disabled.

### Step 1: Generate PKCE Parameters

```javascript
// Generate code verifier (43-128 chars, base64url)
const array = new Uint8Array(32)
crypto.getRandomValues(array)
const codeVerifier = btoa(String.fromCharCode(...array))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

// Generate code challenge (SHA-256 hash of verifier)
const digest = await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(codeVerifier))
const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
```

### Step 2: Redirect to Authorization

```
GET https://your-domain.com/api/oauth/auth?
  client_id=YOUR_CLIENT_ID
  &response_type=code
  &redirect_uri=http://localhost:3000/callback
  &scope=openid profile mcp:search_decisions
  &code_challenge=CODE_CHALLENGE
  &code_challenge_method=S256
  &state=RANDOM_STATE_VALUE
```

The user sees a consent screen listing requested scopes, then approves or denies.

### Step 3: Exchange Code for Tokens

After the user approves, they're redirected to your `redirect_uri` with `?code=AUTH_CODE&state=STATE`.

```bash
curl -X POST https://your-domain.com/api/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "code_verifier=CODE_VERIFIER" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "redirect_uri=http://localhost:3000/callback"
```

For confidential clients, also include `-d "client_secret=YOUR_SECRET"`.

### Step 4: Use Tokens

**Response:**
```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "rt_...",
  "id_token": "eyJhbGc..."
}
```

Use the access token for API and MCP requests:
```bash
curl https://your-domain.com/api/v1/assistants \
  -H "Authorization: Bearer eyJhbGc..."
```

### Step 5: Refresh Tokens

Access tokens expire after 15 minutes. Use the refresh token to get a new one:

```bash
curl -X POST https://your-domain.com/api/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=rt_..." \
  -d "client_id=YOUR_CLIENT_ID"
```

Refresh tokens are valid for 24 hours.

## Token Lifetimes

| Token | TTL |
|-------|-----|
| Access Token | 15 minutes |
| Refresh Token | 24 hours |
| ID Token | 1 hour |
| Authorization Code | 60 seconds |

## Available Scopes

### OIDC Scopes
- `openid` — Required for OIDC, returns sub claim
- `profile` — User's name
- `email` — User's email address
- `offline_access` — Enables refresh tokens

### API Scopes
- `chat:read`, `chat:write` — Chat operations
- `assistants:read`, `assistants:write`, `assistants:list`, `assistants:execute` — Assistants
- `models:read` — List AI models
- `documents:read`, `documents:write` — Documents
- `graph:read`, `graph:write` — Context graph

### MCP Scopes
- `mcp:search_decisions`, `mcp:capture_decision`, `mcp:execute_assistant`, `mcp:list_assistants`, `mcp:get_decision_graph`

## Example: Node.js App

```javascript
import { randomBytes, createHash } from 'crypto'

const ISSUER = 'https://your-domain.com'
const CLIENT_ID = 'your-client-id'
const REDIRECT_URI = 'http://localhost:3000/callback'

// 1. Generate PKCE
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')

// 2. Build auth URL
const authUrl = new URL(`${ISSUER}/api/oauth/auth`)
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('scope', 'openid profile mcp:list_assistants')
authUrl.searchParams.set('code_challenge', challenge)
authUrl.searchParams.set('code_challenge_method', 'S256')
authUrl.searchParams.set('state', randomBytes(16).toString('hex'))

// 3. After redirect, exchange code
async function exchangeCode(code) {
  const res = await fetch(`${ISSUER}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  })
  return res.json() // { access_token, refresh_token, id_token }
}
```

## Endpoints Reference

| Endpoint | Path |
|----------|------|
| Authorization | `GET /api/oauth/auth` |
| Token | `POST /api/oauth/token` |
| UserInfo | `GET /api/oauth/userinfo` |
| JWKS | `GET /api/oauth/jwks` |
| Revocation | `POST /api/oauth/revocation` |
| Discovery | `GET /.well-known/openid-configuration` |

## Troubleshooting

### "invalid_client"
- Verify Client ID matches exactly
- For confidential clients, ensure client_secret is correct
- Check that the client hasn't been revoked in Admin > OAuth Clients

### "invalid_grant"
- Authorization codes expire in 60 seconds — exchange promptly
- Codes are single-use — can't be exchanged twice
- Verify `redirect_uri` matches exactly (including trailing slashes)

### "invalid_scope"
- The client can only request scopes that were allowed during registration
- Check allowed scopes in Admin > OAuth Clients

### PKCE errors
- Ensure `code_challenge_method` is `S256` (plain is disabled)
- The `code_verifier` must match the `code_challenge` sent during authorization
- Verifier must be 43-128 characters

---

*See also: [API Quickstart](./api-quickstart.md) | [MCP Integration](./mcp-integration.md)*
