# Authentication & Security

AI Studio uses AWS Cognito with Google OAuth federation, managed through NextAuth v5 with JWT-based sessions. The platform implements comprehensive security features designed for K-12 educational environments.

## Authentication Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│   Cognito   │────▶│  NextAuth   │────▶│   JWT Session       │
│   OAuth     │     │   v5        │     │   Cookie            │
└─────────────┘     └─────────────┘     └─────────────────────┘
        │                   │
        ▼                   ▼
  PKCE + State +      Token stored in
  Nonce (CSRF)        encrypted JWT cookie
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| NextAuth Config | `/auth.ts` | Cognito provider setup, JWT/session callbacks, NaN guard for maxAge |
| Token Refresh | `/lib/auth/token-refresh-client.ts` | Edge-compatible token refresh |
| Server Session | `/lib/auth/server-session.ts` | Server-side session retrieval |
| Polling Session Cache | `/lib/auth/polling-session-cache.ts` | High-performance cache for polling ops (5-min TTL) |
| Optimized Polling Auth | `/lib/auth/optimized-polling-auth.ts` | Reduces auth overhead from ~500ms to ~5ms |
| Edge Logger | `/lib/auth/edge-logger.ts` | Edge-compatible auth logging (warn/error emit in production) |
| Middleware | `/middleware.ts` | Route protection, security headers, CSP |

### Session Details

- **Session Max Age**: Configurable via `SESSION_MAX_AGE` (default: 24 hours); validated to prevent NaN
- **Tokens Stored**: `accessToken`, `idToken`, `refreshToken` in encrypted JWT cookie
- **Token Refresh**: Proactive refresh at 25% remaining lifetime
- **CSRF Protection**: PKCE + state + nonce checks enabled
- **Agent Token Sync**: Cognito refresh token mirrored to AWS Secrets Manager for AgentCore
- **Polling Optimization**: High-frequency polling endpoints use cached sessions (5-min TTL) to reduce database load

### Polling Session Cache

Long-running operations (chat polling, status checks) use an optimized authentication path:

```
authenticatePollingRequest()
  → getServerSession() → JWT validation
  → Check pollingSessionCache (keyed by sub)
  → Cache hit → Return cached userId/roles
  → Cache miss → DB lookup → Cache result
```

**Performance**: Reduces auth overhead from ~500ms to ~5ms per request.

**Cache Invalidation**: Call `invalidateUserSessions(sub)` on logout or role changes.

### JIT User Provisioning

Handled in `/lib/auth/resolve-user.ts`:
1. Lookup by `cognitoSub` → if found, return user
2. Lookup by email (migration case) → link cognitoSub
3. Create new user with default role

## Role-Based Access Control (RBAC)

### Role Hierarchy

| Role | Level | Description |
|------|-------|-------------|
| `student` | 0 | Basic chat access |
| `staff` | 1 | Extended feature access |
| `administrator` | 2 | Full system access |

**Source**: `/utils/roles.ts`

### Database Schema

- `roles` table: `id`, `name`, `description`, `isSystem`
- `user_roles` table: Maps users to roles
- `role_capabilities` table: Maps roles to capabilities
- `capabilities` table: UI feature gates

### Capabilities System

Capabilities are role-gated UI features checked via `hasCapabilityAccess()`:

| Capability | Default Roles | Purpose |
|------------|---------------|---------|
| `assistant-architect` | admin, staff | Build custom AI assistants |
| `model-compare` | admin, staff | Compare AI model responses |
| `knowledge-repositories` | admin only | Manage knowledge bases |
| `decision-capture` | admin only | Extract decisions from transcripts |
| `voice-mode` | admin only | Real-time voice conversations |

**Source**: `/lib/capabilities/manifest.ts`

### Access Check Flow

```
hasCapabilityAccess(identifier)
  → getServerSession() → resolve cognitoSub
  → DB query: users ↔ user_roles ↔ role_capabilities ↔ capabilities
  → Check capability is active
  → Return boolean
```

## API Authentication

### API Keys

**Generation & Storage**:
- Format: `sk-` + 64 hex chars (256-bit random)
- Stored as Argon2id hashes (never plaintext)
- Max 10 keys per user

**Validation Flow** (`/lib/api-keys/key-service.ts`):
1. Format validation with regex
2. Lookup by key prefix (first 8 hex chars)
3. Constant-time Argon2 verification
4. Check active/expired/revoked status

### OAuth 2.0 / OIDC Provider

**Provider**: `node-oidc-provider` with Drizzle adapter

Features:
- Client Credentials flow (machine-to-machine)
- JWT access tokens signed via KMS
- JWKS endpoint at `/api/oauth/jwks`
- Introspection & revocation
- Consent decisions stored in DB with atomic consume-once semantics

#### Consent Decision Security

OAuth consent decisions use a **server-only module pattern** to prevent unauthorized consumption:

- Consent stored in `oauth_consent_decisions` table with 5-minute TTL
- Consumption is atomic: `DELETE ... RETURNING` prevents race conditions
- The `consumeConsentDecision` function is in a `server-only` module, making client imports fail at build time

**Why server-only?**: Previously, consent consumption was in a `"use server"` module, making it a public unauthenticated endpoint that could consume any user's pending consent by UID. The fix moves it to `/lib/oauth/consent-decisions.ts` with `import "server-only"`.

**Sources**: 
- `/lib/oauth/consent-decisions.ts` - Consent consumption (server-only)
- `/actions/oauth/consent.actions.ts` - Consent approval/denial actions

### Delegated Tokens (Agent-on-Behalf-of-User)

Autonomous agents can mint short-lived delegated tokens:
- **TTL**: 300 seconds (5 minutes)
- **Scope Intersection**: `requested ∩ agent_scopes ∩ user_role_scopes`
- **Claim Structure**: `sub` = system user, `delegated_for` = human user ID

**Source**: `/lib/oauth/delegated-token.ts`

## API Scopes

| Scope | Description | Roles |
|-------|-------------|-------|
| `chat:read/write` | Chat operations | student, staff, admin |
| `assistants:read/execute` | Use assistants | staff, admin |
| `assistants:write` | Create assistants | admin only |
| `mcp:*` | MCP server operations | staff, admin |
| `content:*` | Atrium content ops | staff, admin (varies) |

**Source**: `/lib/api-keys/scopes.ts`

## K-12 Content Safety

### Content Filtering (Bedrock Guardrails)

| Category | Input Action | Output Action |
|----------|--------------|---------------|
| Hate Speech | Blocked (LOW) | Detect only |
| Violence | Detect only | Detect only |
| Sexual Content | Detect only | Detect only |
| Self-Harm | Detect only | Detect only |
| Bullying | Detect only | Detect only |

**Source**: `/lib/safety/bedrock-guardrails-service.ts`

### PII Tokenization

**Detection**: Amazon Comprehend + custom regex patterns

**PII Types Protected**:
- Standard: Names, emails, phones, addresses, SSN
- Custom: Student IDs (7-digit patterns), district identifiers

**Tokenization Flow**:
```
User Input → PII Detection → Token Replacement → AI Provider
                 ↓                                     ↓
           DynamoDB Store                        Token response
                 ↓                                     ↓
            1-hour TTL                           Detokenize
                                                     ↓
                                               User receives original
```

**Source**: `/lib/safety/pii-tokenization-service.ts`

### Compliance

- **COPPA**: PII never transmitted to third-party AI providers
- **FERPA**: Student records stay within district infrastructure
- **CIPA**: Content filtering for inappropriate material

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTHENTICATION LAYER                          │
│  Cognito OAuth → NextAuth v5 → JWT Session Cookie               │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    AUTHORIZATION LAYER                           │
│  Roles → Capabilities → Scope Derivation                        │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    API AUTH LAYER                                │
│  API Key (Argon2) | OAuth Client Creds | Delegated Token        │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    SAFETY LAYER                                  │
│  Bedrock Guardrails → PII Tokenization → AI Provider            │
└─────────────────────────────────────────────────────────────────┘
```

## Source References

| Category | Files |
|----------|-------|
| Auth Core | `/auth.ts`, `/lib/auth/server-session.ts` |
| Polling Cache | `/lib/auth/polling-session-cache.ts`, `/lib/auth/optimized-polling-auth.ts` |
| Edge Runtime | `/lib/auth/edge-logger.ts`, `/lib/auth/token-refresh-client.ts` |
| RBAC | `/lib/capabilities/manifest.ts`, `/lib/db/drizzle/capabilities.ts` |
| API Keys | `/lib/api-keys/key-service.ts`, `/lib/api-keys/scopes.ts` |
| OAuth | `/lib/oauth/oidc-provider-config.ts`, `/lib/oauth/delegated-token.ts`, `/lib/oauth/drizzle-adapter.ts` |
| Safety | `/lib/safety/content-safety-service.ts`, `/lib/safety/pii-tokenization-service.ts` |
| Docs | `/docs/features/k12-content-safety.md` |
