# Agent "GPT-5 review of API architecture" completed

🤖

## Critical Issues & Design Flaws

### 1. Fatal Flaw: Session Users with `["*"]` Scope

**Problem**: Giving session users unlimited scopes (`["*"]`) breaks your entire security model.

- Session auth bypasses the API key scope system completely
- No audit trail for what session users actually did
- Cannot enforce rate limits or usage tracking for session users
- Phase 2/3 expansion makes this worse (session users can call ANY assistant, ANY MCP endpoint)

**Fix**: Session users must get scopes from their role permissions. Map Cognito roles → scope strings. Example: `admin` role → `["graph:*", "assistants:*"]`, `staff` role → `["graph:read", "assistants:123:execute"]`.

**Evidence**: You already have role-based access via `hasToolAccess()`. Reuse that system.

---

### 2. PostgreSQL Rate Limiting Will Not Scale

**Problem**: Querying `api_key_usage` table on EVERY request is a database bottleneck.

- 60 req/min = 1 req/sec per key. With 100 active keys, that's 100 SELECT queries/sec just for rate limit checks.
- Aurora Serverless v2 can handle it NOW, but Phase 2 (external consumers, n8n workflows) will crush this pattern.
- Sliding window requires `COUNT(*) WHERE request_at > NOW() - INTERVAL '1 minute'` — no efficient index on range queries.

**Fix Options**:
1. **Add Redis now** (ElastiCache, ~$15/month for cache.t4g.micro). Use `INCR` with TTL for O(1) rate limit checks.
2. **PostgreSQL materialized view** + trigger to update counter (complex, still slower than Redis).
3. **Application-level in-memory cache** (loses state on ECS task restart, not suitable for rate limiting).

**Recommendation**: Add Redis in Phase 1. PostgreSQL for persistence, Redis for hot path. Cost is negligible vs. risk of database overload.

---

### 3. Missing: API Key Rotation Strategy

**Problem**: "No forced expiration" is fine, but you have NO rotation mechanism.

- What happens when a key is compromised?
- How does a script/n8n workflow update to a new key without downtime?

**Fix**: Add key rotation support:
- Allow multiple active keys per user (max 2-3)
- Rotation flow: Generate new key → update consumer → revoke old key
- Add `previous_key_id` column for audit trail

**Industry Pattern**: AWS IAM access keys allow 2 active keys per user for zero-downtime rotation.

---

### 4. Scope System Lacks Hierarchical Validation

**Problem**: Format "resource:action" or "resource:id:action" is ambiguous.

- How do you validate `"assistant:42:execute"` vs `"assistant:execute:42"`?
- What prevents typos like `"assistants:42:read"` (plural vs singular)?
- No schema for wildcard expansion (`"assistants:*"` → what exactly?)

**Fix**: Define explicit grammar and validation:

```typescript
// Scope format: {resource}:{id}?:{action}
// Examples:
// - "graph:read" (all graphs)
// - "graph:123:update" (specific graph)
// - "assistants:*:execute" (all assistants, execute only)

type Scope = {
  resource: string  // "graph", "assistant", "mcp"
  id?: string       // "123", "*", or undefined (means all)
  action: string    // "read", "write", "execute"
}

function parseScope(scope: string): Scope | null { /* strict parser */ }
function matchesScope(required: Scope, granted: Scope[]): boolean { /* hierarchy check */ }
```

Add scope validation to API key creation (reject malformed scopes).

---

### 5. Missing: IP Allowlisting for Admin Keys

**Problem**: Admin keys have no network-level protection.

- If an admin key leaks, attacker can call from anywhere.
- No defense-in-depth for high-privilege keys.

**Fix**: Add optional `allowed_ips` JSONB column (CIDR ranges). Validate in auth middleware.

**Example**: `["10.0.0.0/8", "203.0.113.5/32"]` (school district internal + specific developer IP).

---

### 6. Phase 3 OAuth2 Provider: Don't Build from Scratch

**Problem**: OAuth2/OIDC is complex (PKCE, token refresh, JWKS rotation, revocation endpoints, discovery metadata). Building from scratch = months of work + security bugs.

**Fix**: Use a library or service:

**Option A: Keycloak** (open-source, self-hosted)
- Runs in ECS Fargate alongside AI Studio
- Full OAuth2/OIDC provider + user federation (can sync from Cognito)
- MCP servers validate tokens via Keycloak's JWKS endpoint
- **Downside**: Another service to manage, but battle-tested.

**Option B: AWS Cognito as OAuth2 Provider**
- Cognito already supports OAuth2/OIDC out of the box
- Issue access tokens for external MCP servers
- AI Studio becomes the client, Cognito is the provider
- **Downside**: Vendor lock-in, but you're already using Cognito.

**Option C: Library (node-oidc-provider)**
- TypeScript library, runs in Next.js
- Still requires implementing JWKS rotation, token storage, revocation
- **Downside**: More work than Option A/B, but more control.

**Recommendation**: Use Cognito as OAuth2 provider in Phase 3. It's already configured, supports JWKS, and handles token lifecycle. Don't reinvent the wheel.

---

### 7. Missing: Usage Analytics Dashboard

**Problem**: You're collecting usage data (`api_key_usage` table) but no plan to surface it.

- Admins need to see: Which keys are active? Which endpoints are slowest? Who's hitting rate limits?
- Without visibility, you can't optimize or troubleshoot.

**Fix**: Add admin dashboard (Phase 1 or early Phase 2):
- Top keys by request count (last 7 days)
- Average response time per endpoint
- Rate limit violations (grouped by key)
- Total requests over time (chart)

**Stack**: Drizzle query → Next.js Server Component → Recharts visualization.

---

### 8. Roadmap Sequencing Issue: MCP Before OAuth2

**Problem**: Phase 3 lists "MCP server + OAuth2 provider" together, but MCP doesn't REQUIRE OAuth2.

**Fix**: Split Phase 3 into 3A and 3B:

- **Phase 3A: MCP Server with API Key Auth**
  - JSON-RPC over SSE, same auth middleware (Bearer tokens)
  - External MCP clients (Claude Desktop, custom tools) use AI Studio API keys
  - No OAuth2 needed yet

- **Phase 3B: OAuth2 Provider (if external MCP servers need it)**
  - Only build this if you need AI Studio to issue tokens for EXTERNAL MCP servers (reverse direction)
  - Example: District-built MCP server validates AI Studio-issued JWTs

**Question**: Do you actually need AI Studio as an OAuth2 provider, or just as an OAuth2 client (consuming external MCPs)? If the latter, skip 3B entirely.

---

### 9. Security: API Keys in Logs

**Problem**: Your server action template logs `sanitizeForLogging(params)`. If an API key is passed as a param (unlikely but possible), it could leak to CloudWatch.

**Fix**: Update `sanitizeForLogging()` to detect and redact patterns like `sk-[a-f0-9]{40}`.

---

### 10. Missing: Versioning Strategy Beyond URL Path

**Problem**: `/api/v1/...` is good for routing, but how do you handle breaking changes?

- What if Phase 2 changes the graph API response format?
- Do you maintain v1 and v2 forever, or deprecate v1?

**Fix**: Add deprecation headers and sunset timeline:

```typescript
// In v1 endpoint (deprecated)
res.setHeader('Deprecation', 'true')
res.setHeader('Sunset', 'Sat, 31 Dec 2026 23:59:59 GMT')
res.setHeader('Link', '</api/v2/graph>; rel="successor-version"')
```

Document deprecation policy (e.g., "v1 supported for 12 months after v2 release").

---

## Industry Pattern Comparison

| Pattern | Stripe | GitHub | OpenAI | Your Design | Recommendation |
|---------|--------|--------|--------|-------------|----------------|
| Key format | `sk_live_...` (base64) | `ghp_...` (base64) | `sk-...` (hex) | `sk-...` (hex) | ✅ Good |
| Hashing | bcrypt | SHA-256 | Unknown | SHA-256 | ⚠️ Use HMAC-SHA256 with secret key (see below) |
| Scopes | Granular (e.g., `charges:write`) | Granular + wildcards | Org-level only | Hierarchical | ⚠️ Add validation |
| Rate limiting | Redis (Stripe) / PostgreSQL (GitHub) | Unknown | Redis | PostgreSQL | ❌ Add Redis |
| Key rotation | Multi-key support | No rotation | No rotation | None | ❌ Add rotation |
| IP allowlisting | Yes (Stripe) | No | No | No | ⚠️ Add for admin keys |
| Versioning | URL path (`/v1/`) | URL path + headers | URL path | URL path | ✅ Good, add sunset headers |

---

## SHA-256 vs HMAC-SHA256 for Key Hashing

**Your Current Approach (SHA-256)**: Secure for high-entropy random keys, but no secret pepper.

**Better Approach (HMAC-SHA256 with secret key)**:
- Store secret key in AWS Secrets Manager (rotate annually)
- Compute `HMAC-SHA256(api_key, secret_key)` before storing
- Even if database dumps leak, attacker needs the secret key to validate keys

**Code Change**:
```typescript
import { createHmac } from 'crypto'

const SECRET_KEY = await getSecretFromSecretsManager('api-key-hmac-secret')

function hashApiKey(key: string): string {
  return createHmac('sha256', SECRET_KEY).update(key).digest('hex')
}
```

**Recommendation**: Use HMAC-SHA256. Minimal effort, significant security gain.

---

## What You're Not Thinking About

### 1. Webhook Signatures (Phase 2)
If external systems call AI Studio APIs, you'll eventually need webhooks (e.g., "assistant task completed"). You'll need HMAC signatures to verify webhook payloads. Plan now.

### 2. Bulk Operations
What if a user wants to create 50 API keys for 50 n8n workflows? Add bulk creation endpoint (`POST /api/v1/keys/bulk`).

### 3. Test Keys
How do developers test without burning production rate limits? Add `is_test_mode` flag (separate rate limit pool, doesn't affect production counters).

### 4. Audit Log Retention
`api_key_usage` table will grow unbounded. Add S3 archival (move rows older than 90 days to S3 via Lambda cron). Query recent data from PostgreSQL, old data from Athena.

### 5. Compliance (FERPA)
If API keys access student data, you need audit logs showing WHO accessed WHAT STUDENT RECORD. Ensure `api_key_usage` includes enough context (e.g., `student_id` in request metadata).

### 6. Key Compromise Detection
Monitor for anomalies: Sudden spike in requests? New IP address? Geographic mismatch? Add CloudWatch alarms on `api_key_usage` metrics.

---

## Evidence-Based Recommendations (Prioritized)

| Issue | Severity | Fix | Phase |
|-------|----------|-----|-------|
| Session users get `["*"]` scopes | 🔴 Critical | Map roles → scopes | Phase 1 (before launch) |
| PostgreSQL rate limiting won't scale | 🔴 Critical | Add Redis | Phase 1 (or early Phase 2) |
| No key rotation mechanism | 🟡 Medium | Allow 2 active keys per user | Phase 2 |
| Scope validation is ambiguous | 🟡 Medium | Add strict parser + schema | Phase 1 |
| No IP allowlisting for admin keys | 🟡 Medium | Add `allowed_ips` column | Phase 2 |
| OAuth2 provider from scratch | 🔴 Critical | Use Cognito or Keycloak | Phase 3 (don't build) |
| No usage analytics dashboard | 🟢 Low | Add admin UI for metrics | Phase 2 |
| MCP doesn't need OAuth2 initially | 🟡 Medium | Split Phase 3 into 3A/3B | Phase 3 |
| API keys in logs | 🟢 Low | Update `sanitizeForLogging()` | Phase 1 |
| No deprecation policy | 🟢 Low | Add sunset headers | Phase 2 |

---

## Final Verdict

**What's Good**:
- Opaque keys with SHA-256 hashing (upgrade to HMAC-SHA256)
- Hierarchical scopes (needs validation)
- Dual-mode auth (fix session scope issue)
- URL versioning

**What's Broken**:
- Session users bypass scope system
- PostgreSQL rate limiting is a time bomb
- No key rotation
- OAuth2 provider plan is naive

**What's Missing**:
- Redis for rate limiting
- IP allowlisting
- Usage dashboard
- Key rotation
- Audit log archival
- Webhook signatures (future)

**Bottom Line**: The architecture is 70% correct, but the 30% that's wrong will cause pain in Phase 2. Fix session scopes and add Redis BEFORE Phase 1 launch. Defer OAuth2 provider until Phase 3B (or skip it entirely if you don't need AI Studio to issue tokens).