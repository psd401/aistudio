# Agent "Gemini review of API architecture" completed

Perfect. Now I have enough context. Let me provide a critical architectural review.

---

## Critical Architecture Review - API Platform

### Evidence-Based Analysis

**Current State Verified:**
- PostgreSQL Aurora Serverless v2 (2-8 ACU, max ~600-1200 connections)
- Connection pool: 20 per ECS task, postgres.js driver
- In-memory rate limiting exists (`/lib/rate-limit.ts`, Map-based)
- NextAuth v5 session auth (Cognito)
- No API key infrastructure exists yet
- Graph tables: `graph_nodes`, `graph_edges` (UUID-based)

---

## 1. Fundamental Design Flaws

### CRITICAL: PostgreSQL Rate Limiting at Scale

**The Problem:**
```typescript
// Your proposed approach
api_key_usage table with sliding window queries
```

**Evidence Against:**
- Your Aurora config: 2-10 ECS tasks × 20 connections = 40-200 concurrent pool connections
- 60 req/min × 10 API keys = 600 writes/min minimum to `api_key_usage` table
- Sliding window queries require: `SELECT COUNT(*) WHERE request_at > NOW() - INTERVAL '1 minute'` on **every request**
- This creates table-level lock contention and index bloat on high-write tables
- Aurora Serverless scales on ACU, but connection pool exhaustion happens before ACU scaling kicks in

**Real-World Data:**
- GitHub uses Redis (confirmed in their public blog posts)
- Stripe uses distributed rate limiting with Stripe-RateLimit headers (not database)
- OpenAI uses API Gateway (AWS) with token bucket algorithm

**Recommendation:**
- **Phase 1:** Keep in-memory Map (adequate for server-to-server, single-tenant K-12 district)
- **Phase 2:** If you scale beyond 10 API consumers, move to ElastiCache Redis (separate from Aurora)
- **Phase 3:** If you become multi-tenant, use AWS API Gateway with usage plans

**Why in-memory works for you:**
- ECS tasks are long-lived (not Lambda cold starts)
- Server-to-server only (no public API)
- Small # of consumers (CIO team + n8n + scripts)
- Rate limiting is protective, not billing-critical

---

### CRITICAL: Scope System Design Gap

**Your Scope Format:**
```
"resource:action"           → graph:read
"resource:id:action"        → assistant:42:execute
"mcp:search_decisions"      → inconsistent pattern
```

**Problems Identified:**

1. **No Tenant Isolation:** K-12 districts are multi-school. What happens when:
   - `assistant:42:execute` — Which school owns assistant 42?
   - Student data from School A leaks to School B via shared assistant?

2. **Wildcard Ambiguity:** `"assistants:*"` means what?
   - All assistants for all schools?
   - All actions on assistants I created?
   - All assistants I have access to?

3. **No Version Strategy:** `/api/v1/graph` today, but scopes are `graph:read`. When you deploy v2 with breaking changes, how do you:
   - Invalidate v1 scopes?
   - Migrate keys to v2 scopes?
   - Run v1 and v2 simultaneously?

**Recommendation - Hierarchical Scope Spec:**
```typescript
// RFC 6749 OAuth2-compatible format
scope ::= scope-token *( SP scope-token )
scope-token ::= 1*NQCHAR

// Your implementation:
"api:v1:graph:read"                    // Version-aware
"api:v1:graph:node:create"             
"api:v1:assistant:uuid:execute"        // Specific resource
"api:v1:assistants:*:read"             // Wildcard read-only
"api:v2:*"                             // Future-proof

// For Phase 3 (MCP):
"mcp:tool:search_decisions:invoke"     
"mcp:resource:decision_log:read"       

// FERPA-aware:
"api:v1:students:school_id:read"       // Scoped by school
"api:v1:students:*:read"               // District-wide (admin only)
```

**Implementation:**
```typescript
type ScopePattern = {
  version: string;        // "v1", "v2"
  resource: string;       // "graph", "assistants"
  identifier?: string;    // UUID, "*", school_id
  action: string;         // "read", "write", "execute"
}

function matchesScope(required: string, granted: string[]): boolean {
  // Implement RFC 6749 scope matching with wildcard support
  // CRITICAL: Deny by default, explicit grant required
}
```

---

### CRITICAL: SHA-256 for API Keys - Wrong Algorithm

**Your Reasoning:**
> "Keys are high-entropy random, not passwords. No argon2 needed."

**You're Partially Correct, But Missing the Threat Model:**

SHA-256 is **cryptographically secure** but **computationally fast**:
- 2.5 billion SHA-256/sec on modern GPU (RTX 4090)
- If your database leaks (SQL injection, backup exposure), attacker can:
  1. Extract SHA-256 hashes
  2. Brute-force 40 hex chars (2^160 keyspace) — infeasible
  3. **BUT:** Rainbow table attack if you don't salt

**Wait, you're using random keys, not user input. So why does this matter?**

**The Real Flaw:** SHA-256 offers **no rate limiting on verification**
- Attacker with stolen hash can test millions of keys/sec offline
- Compare to bcrypt/argon2: ~100 hashes/sec by design

**Industry Standard:**
- **Stripe:** API keys are `sk_live_...` (32 bytes), stored as bcrypt hash with per-key salt
- **GitHub:** Personal access tokens stored as SHA-256 **with HMAC** (secret key in HSM)
- **AWS:** IAM access keys use PBKDF2 with 10,000+ iterations

**Recommendation:**
```typescript
// Phase 1: SHA-256 with HMAC (AWS KMS for secret key)
import { createHmac } from 'crypto';
import { KMSClient, GenerateDataKeyCommand } from '@aws-sdk/client-kms';

async function hashApiKey(rawKey: string): Promise<string> {
  const hmacKey = await getHmacKeyFromKMS(); // Cached, rotated daily
  return createHmac('sha256', hmacKey).update(rawKey).digest('hex');
}

// Phase 2: Consider argon2id if you add per-key salts
// (overkill for server-to-server, but required for FERPA compliance review)
```

**Why HMAC > Plain SHA-256:**
- Offline attacks require KMS key (which they don't have)
- Key rotation supported (re-hash with new HMAC key)
- FIPS 140-2 compliant (required for some federal K-12 grants)

---

## 2. Missing Considerations

### FERPA Compliance - Critical Gap

**Your Data Model:**
```sql
api_key_usage: id, api_key_id, endpoint, method, status_code, 
               request_at, response_time_ms, ip_address
```

**FERPA 34 CFR § 99.31 Requires:**
- Audit trail of **who accessed what student data**
- **Purpose of access** (legitimate educational interest)
- **Data minimization** (don't log student PII in API logs)

**Problem:** Your `endpoint` field will contain:
```
/api/v1/students/12345/grades   ← Student ID in logs
/api/v1/assistants/chat?query=help+John+Smith  ← PII in query string
```

**FERPA Violation:** Logs become "education records" themselves, subject to parent access requests.

**Recommendation:**
```typescript
// api_key_usage table
{
  endpoint_template: string,  // "/api/v1/students/:id/grades" (parameterized)
  resource_type: string,      // "student_grades"
  resource_count: integer,    // 1 (how many records accessed)
  purpose: string,            // "grade_export" (from API key metadata)
  pii_accessed: boolean,      // true (flag for audit)
  retention_days: integer,    // 90 (auto-delete after retention period)
}
```

**Audit Requirements:**
```sql
-- Must answer: "Who accessed Johnny's grades in the last year?"
SELECT aki.name, aku.request_at, aku.purpose
FROM api_key_usage aku
JOIN api_keys aki ON aku.api_key_id = aki.id
WHERE aku.resource_type = 'student_grades'
  AND aku.resource_id_hash = SHA256('student:12345')  -- Hash in app layer
  AND aku.request_at > NOW() - INTERVAL '1 year';
```

---

### COPPA Compliance - Age Gating

**K-12 Context:** Students under 13 require **verifiable parental consent** (15 USC § 6501)

**Missing from Design:**
- No age verification in user model
- No parental consent tracking
- No "student data" flag on API scopes

**Recommendation:**
```typescript
// api_keys table additions
{
  access_level: "staff_only" | "aggregate_only" | "identified_students",
  min_student_age: integer,  // 13 (COPPA threshold)
  parental_consent_required: boolean,
}

// Scope enforcement
"api:v1:students:aggregate:read"   // OK: No individual records
"api:v1:students:identified:read"  // Requires parental_consent_required=true
```

---

### Key Rotation - Missing Strategy

**Your Design:** `expires_at` (optional), `revoked_at`

**Problem:** What happens when:
1. Developer leaves district (key in their scripts)
2. Key accidentally committed to public GitHub
3. Suspected key compromise (can't prove it)

**Industry Pattern (AWS IAM):**
- Max 2 keys per user
- 90-day rotation recommended
- Programmatic rotation via API

**Recommendation:**
```typescript
// api_keys table
{
  rotation_required_at: timestamp,  // Force rotation every 90 days
  rotation_reminder_sent: timestamp,
  previous_key_hash: string,        // Allow grace period for rotation
  grace_period_ends: timestamp,     // 7 days to update scripts
}

// Server action
async function rotateApiKey(apiKeyId: number): Promise<{old: string, new: string}> {
  // Generate new key, keep old key valid for 7 days
  // Send email with rotation instructions
}
```

---

### Observability - Metrics Missing

**Your Usage Table:**
```sql
response_time_ms, status_code, request_at
```

**What You Can't Answer:**
- Which API endpoints are slowest? (no P95/P99)
- Which keys are hitting rate limits most? (no rate_limit_hit boolean)
- Are API errors user mistakes or system bugs? (no error categorization)
- Cost per API consumer? (no data transfer tracking)

**Recommendation:**
```typescript
// api_key_usage enhancements
{
  request_size_bytes: integer,
  response_size_bytes: integer,
  cache_hit: boolean,           // If you add caching
  rate_limited: boolean,        // Track 429 responses
  error_category: string,       // "auth", "validation", "system", "upstream"
  ai_tokens_used: integer,      // Phase 2: Track AI API costs per key
}

// CloudWatch metrics (via ADOT)
await metrics.putMetric('APILatency', response_time_ms, 'Milliseconds', {
  Endpoint: endpoint_template,
  ApiKeyId: String(api_key_id),
});
```

---

## 3. Phase Sequencing Issues

**Your Proposed Order:**
1. Phase 1: API keys + graph REST
2. Phase 2: Expose assistants via API
3. Phase 3: MCP server + OAuth2 provider

**Problem with Phase 3:** You're building an OAuth2 provider **after** you have API consumers.

**Migration Nightmare:**
```
Day 1: API keys (sk-xxx)
Day 365: OAuth2 tokens (jwt-xxx)
Day 366: How do you migrate 50 scripts using old keys?
```

**Better Sequencing:**

### Phase 1 (Immediate):
- API keys with **OAuth2-compatible scopes** from day 1
- Graph REST endpoints
- PostgreSQL audit logging (not rate limiting)
- **Skip user settings page** — admin-only via direct DB or API

### Phase 2 (6 months):
- Expose assistants via REST API
- Add **JWT support alongside API keys** (dual auth)
- SSE streaming for assistant responses

### Phase 3 (12 months):
- OAuth2 **token introspection** endpoint (RFC 7662)
- MCP server using **existing JWT auth**
- External MCP servers validate via `/oauth/introspect`

**Why This Works:**
- No breaking changes (API keys keep working)
- OAuth2 scopes match your day-1 scope format
- MCP clients use JWT, internal tools use API keys

---

## 4. Specific Answers to Your Questions

### 4.1 "SHA-256 for API key hashing — is this the right choice?"

**No.** Use **SHA-256 with HMAC** (secret in AWS KMS). Plain SHA-256 enables offline attacks.

### 4.2 "PostgreSQL rate limiting vs Redis — will PG work at this scale?"

**For Phase 1: Yes** (in-memory Map is fine)  
**For Phase 2+: No** (move to Redis when >10 API consumers)

**Evidence:** 60 req/min × 10 keys × 1440 min/day = **864,000 writes/day**. Your Aurora dev environment (2 ACU min) handles this, but:
- Sliding window queries = table scans
- Index bloat on `request_at` timestamp column
- Connection pool exhaustion during bursts

**Use Redis for rate limiting, PostgreSQL for audit logs.**

### 4.3 "Is the scope system extensible enough for all three phases?"

**No.** Add version prefix (`api:v1:*`) and resource identifiers (`school_id`).

### 4.4 "Industry patterns we should adopt?"

**Stripe:**
- Dual keys: publishable (`pk_`) vs secret (`sk_`)
- Idempotency keys (prevent duplicate charges)
- Webhook signatures (verify event authenticity)

**GitHub:**
- Fine-grained PATs with repository-level scopes
- IP allow lists (restrict key usage to specific IPs)
- Last-used tracking (security dashboard)

**OpenAI:**
- Organization-scoped keys (multi-tenant)
- Usage quotas (not just rate limits)
- Cost allocation tags

**Adopt for Phase 1:**
```typescript
// Stripe-style dual keys
"sk_dev_..." // Secret key (server-to-server)
"pk_dev_..." // Publishable key (client-side, if needed)

// GitHub-style IP allow list
api_keys.allowed_ips = ["10.0.0.0/8", "192.168.1.1"]

// OpenAI-style usage quotas
api_keys.monthly_request_quota = 100000
api_keys.monthly_requests_used = 42150
```

### 4.5 "For OAuth2 in Phase 3, build from scratch or use a library?"

**Use a library.** OAuth2 is security-critical.

**Recommended:**
- **node-oauth2-server** (battle-tested, RFC 6749 compliant)
- OR **Auth.js (NextAuth v5) OAuth provider plugin**

**Do NOT build from scratch:**
- Token expiry edge cases
- Refresh token rotation (RFC 6819)
- PKCE for public clients (RFC 7636)
- Token introspection (RFC 7662)

**Your specific case:** Since you're already using NextAuth v5, extend it:
```typescript
// auth.ts
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    CognitoProvider(...),
    {
      id: "aistudio-oauth",
      name: "AI Studio OAuth",
      type: "oauth",
      // Issue JWTs for external MCP servers
      authorization: { params: { scope: "mcp:*" } },
      token: async (tokens) => {
        // Sign with AWS KMS
        return signJWT(tokens, await getKMSKey());
      },
    },
  ],
});
```

### 4.6 "For MCP server compatibility, any protocol concerns?"

**Yes. Critical misunderstanding detected.**

**MCP Protocol:** JSON-RPC 2.0 over:
- stdio (local process communication)
- **SSE (server-sent events)** ← You mentioned this

**Your Plan:** "MCP server (JSON-RPC over SSE, same auth layer)"

**Problem:** MCP spec uses **HTTP POST for JSON-RPC**, SSE only for **server→client notifications**.

**Correct Implementation:**
```typescript
// Client → Server: HTTP POST
POST /mcp/jsonrpc
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": { "name": "search_decisions", "arguments": {...} },
  "id": 1
}

// Server → Client: SSE for streaming responses
GET /mcp/notifications
Authorization: Bearer <jwt-token>

event: tool-progress
data: {"tool": "search_decisions", "progress": 0.5}
```

**Reference:** MCP spec (Anthropic) uses **stdio** primarily. SSE is for web-based MCP servers. Ensure you:
- Support **CORS** for browser-based MCP clients (Claude Desktop is Electron, needs this)
- Implement **WebSocket fallback** if SSE doesn't work (corporate proxies block SSE)

### 4.7 "K-12 compliance considerations (FERPA, COPPA)?"

**Already covered above, but summary:**

**FERPA (34 CFR § 99.31):**
- ✅ Audit who accessed what
- ✅ Legitimate educational interest (track purpose)
- ❌ Don't log PII (parameterize URLs)
- ❌ Retention limits (90 days recommended)

**COPPA (15 USC § 6501):**
- ✅ Age verification (no API access to <13 without consent)
- ✅ Parental consent tracking
- ✅ Data minimization (scopes restrict access)

**Additional:**
- **CIPA (Children's Internet Protection Act):** If using AI for content filtering
- **Section 504/ADA:** Ensure API responses support screen readers (if building UI)

---

## 5. Blind Spots Identified

### 5.1 No IP Allow Lists

**Problem:** API key stolen from developer's laptop. Attacker uses it from Russia.

**Solution:**
```typescript
api_keys.allowed_ips = ["10.0.0.0/8"]  // District network only
api_keys.allowed_cidrs = string[]
```

### 5.2 No Webhook Signatures (Phase 2+)

**Future Problem:** When assistants run async jobs, how do you notify the API consumer?

**Solution (Stripe pattern):**
```typescript
// Webhook event
POST https://api-consumer.com/webhook
X-AI-Studio-Signature: sha256=<hmac>

// Verify signature
const hmac = createHmac('sha256', api_key.webhook_secret)
  .update(JSON.stringify(payload))
  .digest('hex');
```

### 5.3 No API Versioning Strategy

**Problem:** You deploy v2 with breaking changes. How do you:
- Support v1 clients for 6 months?
- Migrate clients to v2?
- Sunset v1 gracefully?

**Solution:**
```typescript
// URL versioning (you chose this - good)
/api/v1/graph  → Supported until 2026-12-31
/api/v2/graph  → New default

// Response headers
X-API-Version: v1
X-API-Deprecated: true
X-API-Sunset: 2026-12-31

// Scope versioning (proposed above)
api:v1:graph:read → Only works on /api/v1/*
api:v2:graph:read → Only works on /api/v2/*
```

### 5.4 No Cost Attribution

**Future Problem:** Which team/department is using the most AI API credits?

**Solution:**
```typescript
api_keys.cost_center = "IT Department"
api_keys.budget_code = "FY26-AI-001"

// Track AI usage
api_key_usage.ai_input_tokens = 1500
api_key_usage.ai_output_tokens = 300
api_key_usage.estimated_cost_usd = 0.045
```

---

## 6. Architecture Recommendations Summary

### Keep:
- ✅ Opaque API keys (`sk-` prefix)
- ✅ Dual-mode auth (Bearer token + session fallback)
- ✅ No CORS (server-to-server initially)
- ✅ Admin-only access (Phase 1)
- ✅ URL versioning (`/api/v1/`)
- ✅ PostgreSQL for audit logs

### Change:
- ❌ SHA-256 → **SHA-256 with HMAC** (AWS KMS secret)
- ❌ Simple scopes → **Version-aware hierarchical scopes** (`api:v1:resource:action`)
- ❌ PostgreSQL rate limiting → **In-memory (Phase 1), Redis (Phase 2+)**
- ❌ Missing FERPA → **Add purpose tracking, PII protection**
- ❌ Missing rotation → **Add 90-day rotation requirement**

### Add:
- **IP allow lists** (api_keys.allowed_ips)
- **Usage quotas** (not just rate limits)
- **Cost attribution** (department/budget tracking)
- **Webhook signatures** (Phase 2, async notifications)
- **Observability** (P95 latency, error categorization)
- **Grace periods** (key rotation, API version sunset)

---

## 7. Updated Data Model

```typescript
// api_keys (no longer needs api_key_usage for rate limiting)
{
  id: serial,
  user_id: integer,
  name: varchar(255),
  key_prefix: varchar(12),          // "sk_dev_a1b2"
  key_hash: varchar(64),            // SHA-256(HMAC(key, kms_key))
  hmac_key_version: integer,        // Track KMS key rotation
  scopes: jsonb,                    // ["api:v1:graph:read", ...]
  is_active: boolean,
  
  // Rate limiting (in-memory, backed up here)
  rate_limit_rpm: integer default 60,
  
  // Security
  allowed_ips: jsonb,               // ["10.0.0.0/8"]
  last_used_at: timestamp,
  last_used_ip: varchar(45),
  
  // Rotation
  rotation_required_at: timestamp,
  previous_key_hash: varchar(64),
  grace_period_ends: timestamp,
  
  // Compliance
  access_level: enum,               // "staff_only", "aggregate_only", "identified_students"
  purpose: varchar(255),            // "Grade export for SIS sync"
  
  // Lifecycle
  expires_at: timestamp,
  revoked_at: timestamp,
  revoked_reason: text,
  created_at: timestamp,
  updated_at: timestamp,
}

// api_key_audit (audit-only, NOT used for rate limiting)
{
  id: bigserial,
  api_key_id: integer,
  
  // What was accessed (FERPA-safe)
  endpoint_template: varchar(255),  // "/api/v1/students/:id/grades"
  method: varchar(10),
  resource_type: varchar(100),      // "student_grades"
  resource_count: integer,          // 1
  pii_accessed: boolean,
  
  // Performance
  response_time_ms: integer,
  status_code: integer,
  request_size_bytes: integer,
  response_size_bytes: integer,
  
  // Cost tracking (Phase 2)
  ai_input_tokens: integer,
  ai_output_tokens: integer,
  estimated_cost_usd: decimal(10,4),
  
  // Security
  ip_address: varchar(45),
  user_agent: text,
  rate_limited: boolean,
  
  // Metadata
  request_id: uuid,                 // Correlate with app logs
  request_at: timestamp,
  retention_expires_at: timestamp,  // FERPA compliance (90 days)
}

// users additions (COPPA compliance)
{
  job_title: varchar(255),
  department: varchar(255),
  building: varchar(255),
  profile: jsonb,
  
  // New for API/COPPA
  date_of_birth: date,              // Age verification
  parental_consent: boolean,        // Under-13 students
  parental_consent_date: timestamp,
}
```

---

## 8. Final Verdict

**Your architecture is 70% sound**, but has critical gaps:

### 🔴 **Must Fix Before Launch:**
1. SHA-256 → HMAC-SHA-256 (security)
2. Scope versioning (avoid migration hell)
3. FERPA audit fields (compliance)
4. Key rotation strategy (operational security)

### 🟡 **Should Fix in Phase 1:**
5. IP allow lists (prevent stolen key abuse)
6. PostgreSQL rate limiting → in-memory (performance)
7. Observability metrics (you'll need this day 1)

### 🟢 **Can Defer to Phase 2:**
8. Usage quotas
9. Cost attribution
10. Webhook signatures

---

**Bottom Line:** Your team is small, your use case is specific (K-12 internal tools), but you're building something that could become **the district's AI identity provider**. Invest in getting auth/scopes right now, or you'll rebuild it in 12 months.

**Confidence Level:** High. This assessment is based on:
- Verified codebase (Aurora config, existing auth, rate limiting)
- Industry standards (Stripe, GitHub, AWS IAM patterns)
- K-12 compliance requirements (FERPA 34 CFR § 99, COPPA 15 USC § 6501)
- Your explicit Phase 3 goal (OAuth2 provider for district)

Ship Phase 1 with HMAC-SHA-256 + versioned scopes. Everything else can iterate.