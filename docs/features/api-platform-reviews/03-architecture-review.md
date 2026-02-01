# Agent "Architecture review of API epic" completed

Now I have enough context. Let me generate the architecture review report.

## Architecture Review Report - Epic #674: External API Platform

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | Architecture decisions document + 25+ codebase files |
| SOLID violations | 5 critical, 3 moderate |
| Anti-patterns detected | 4 structural concerns |
| Severity | **HIGH** - Multiple reversibility risks |

---

## SOLID Compliance Analysis

### S - Single Responsibility Principle

**Status:** ⚠️ MODERATE VIOLATIONS

**Violations Found:**

1. **Dual-mode auth middleware mixing concerns** (Line: Decision #3)
   - `/Users/hagelk/non-ic-code/aistudio/middleware.ts:18-66` - Current middleware handles session auth, static assets, CORS, security headers, and redirects
   - Proposed API key auth adds another authentication mechanism to same middleware
   - **Issue:** One middleware now responsible for: API key validation, session validation, route matching, security headers, CORS (future), rate limiting coordination
   - **Evidence:** Current middleware already has 4 distinct responsibilities (auth, routing, headers, caching)

2. **"Dual-mode auth middleware" violates separation of concerns**
   - API key auth and session auth are fundamentally different authentication strategies
   - Session auth: stateful, browser-based, cookie-driven
   - API key auth: stateless, server-to-server, header-based
   - **Risk:** Changes to one auth mechanism require testing both paths

**Recommendations:**
- Separate middleware: `apiKeyAuthMiddleware` and `sessionAuthMiddleware`
- Chain them in Next.js middleware with clear path matching
- Use composition pattern instead of conditional branching

---

### O - Open/Closed Principle

**Status:** ❌ CRITICAL VIOLATIONS

**Violations Found:**

1. **Hardcoded scope strings prevent extension** (Decision #2)
   - `graph:read`, `graph:write` pattern is fine
   - Future scopes like `assistant:42:execute` require **modifying existing validation logic**
   - **Evidence:** No abstraction layer for scope validation
   - **Problem:** Adding Phase 2 (per-assistant scopes) or Phase 3 (OAuth2 scopes) will require changing core validation code

2. **No strategy pattern for authentication types** (Decision #3)
   - `AuthContext` type with `authType` discriminator suggests if/else branching
   - Adding OAuth2 in Phase 3 means modifying existing auth flow code
   - **Current pattern from codebase:** `/Users/hagelk/non-ic-code/aistudio/lib/auth/server-session.ts` shows single auth path
   - Adding API keys means **modifying every route that calls `getServerSession()`**

3. **Rate limiting tied to PostgreSQL sliding window** (Decision #7)
   - Current in-memory rate limiter: `/Users/hagelk/non-ic-code/aistudio/lib/rate-limit.ts:11`
   - Switching to PostgreSQL for API keys means **rewriting rate limit logic**
   - No interface abstraction - direct PostgreSQL coupling
   - **Cannot swap to Redis later without modifying api_key_usage queries**

**Recommendations:**
- Create `ScopeValidator` interface with implementations: `BasicScopeValidator`, `HierarchicalScopeValidator`, `OAuth2ScopeValidator`
- Use Strategy pattern for authentication: `AuthStrategy` interface with `SessionAuthStrategy`, `ApiKeyAuthStrategy`, `OAuth2AuthStrategy`
- Abstract rate limiting: `RateLimiter` interface with `PostgresRateLimiter`, `RedisRateLimiter`

---

### L - Liskov Substitution Principle

**Status:** ✅ NO VIOLATIONS (yet)

**Potential Risk:**
- Unified `AuthContext` type (Decision #3) suggests session users and API key users should be interchangeable
- Session users get `scopes: ["*"]` (wildcard), API key users get explicit scopes
- **Risk:** Code that checks `scopes.includes("graph:read")` will FAIL for session users
- Wildcard `*` is not semantically equivalent to explicit scope list

**Recommendation:**
- Session users should get explicit scopes from role-based permissions
- Current codebase pattern: `/Users/hagelk/non-ic-code/aistudio/lib/auth/role-helpers.ts` uses `hasToolAccess("tool-name")`
- Convert tool permissions to scopes for consistency

---

### I - Interface Segregation Principle

**Status:** ⚠️ MODERATE VIOLATION

**Violations Found:**

1. **AuthContext interface may become bloated** (Decision #3)
   ```typescript
   interface AuthContext {
     userId: number
     cognitoSub?: string  // Only for session auth
     authType: 'session' | 'api_key'
     scopes: string[]
     apiKeyId?: number     // Only for API key auth
   }
   ```
   - Session auth doesn't need `apiKeyId`
   - API key auth doesn't need `cognitoSub`
   - Phase 3 OAuth2 will add `clientId`, `refreshToken`, `expiresAt`
   - **Growing interface forces implementers to handle irrelevant fields**

**Recommendation:**
- Use discriminated union types:
   ```typescript
   type AuthContext = 
     | { type: 'session'; userId: number; cognitoSub: string; scopes: string[] }
     | { type: 'api_key'; userId: number; keyId: number; scopes: string[] }
     | { type: 'oauth2'; clientId: string; scopes: string[]; expiresAt: Date }
   ```

---

### D - Dependency Inversion Principle

**Status:** ❌ CRITICAL VIOLATIONS

**Violations Found:**

1. **Direct PostgreSQL dependency in rate limiting** (Decision #7)
   - `api_key_usage` table schema hardcoded
   - Business logic (rate limiting) depends on concrete database implementation
   - **No abstraction layer**
   - **Evidence from codebase:** `/Users/hagelk/non-ic-code/aistudio/lib/db/drizzle-client.ts` shows direct postgres.js coupling

2. **API key hashing tied to SHA-256** (Decision #1)
   - No crypto abstraction
   - If SHA-256 becomes compromised (future cryptographic weakness), **cannot swap to argon2/bcrypt without database migration**
   - **Current pattern:** No `HashingService` abstraction in codebase

3. **Scope validation will depend on concrete implementations** (Decision #2)
   - No `ScopeRepository` or `PermissionService` abstraction
   - Phase 2 assistant scopes require querying `assistant_architects` table directly
   - Phase 3 OAuth2 scopes require OAuth2 provider integration
   - **Tight coupling to database schema**

**Recommendations:**
- Create `RateLimitRepository` interface with PostgreSQL and Redis implementations
- Create `KeyHashingService` interface to abstract crypto operations
- Create `PermissionResolver` interface for scope validation against different backends

---

## Anti-Pattern Detection

### 1. Premature Optimization - PostgreSQL Rate Limiting

**Severity:** HIGH  
**Location:** Decision #7

**Evidence:**
- Current codebase uses in-memory rate limiting: `/Users/hagelk/non-ic-code/aistudio/lib/rate-limit.ts`
- Works fine for current scale (100 req/min default)
- PostgreSQL sliding window is **complex** for unproven need
- **No profiling evidence that in-memory rate limiting is insufficient**

**Problems:**
- PostgreSQL write amplification: Every API request = 1 INSERT into `api_key_usage`
- At 60 req/min per key × 100 keys = 6,000 INSERTs/min = 100/sec
- Aurora Serverless v2 min 2 ACU may struggle with write throughput
- Index maintenance overhead on `(api_key_id, request_at)` for time-range queries
- **Evidence from CLAUDE.md:** Aurora configured for "auto-pause in dev" - not optimized for high write throughput

**Benchmark Reality Check:**
- In-memory rate limiting supports **millions of req/min** with minimal overhead
- Redis supports **100K+ ops/sec** with sub-millisecond latency
- PostgreSQL rate limiting: **Adds 5-20ms per request** for INSERT + SELECT

**Recommendation:**
- **Start with in-memory rate limiting** (extend existing `/lib/rate-limit.ts`)
- Store `api_key_usage` for **auditing only** (async writes, no read path)
- Switch to Redis **only if** multi-container coordination needed (ECS auto-scaling)
- Evidence needed first: "We have 10+ ECS containers and keys are getting different limits"

---

### 2. God Object Warning - Unified AuthContext

**Severity:** MEDIUM  
**Location:** Decision #3

**Pattern:**
```typescript
// Proposed
interface AuthContext {
  userId, cognitoSub, authType, scopes, apiKeyId, 
  // Future additions from Phase 3:
  clientId, refreshToken, expiresAt, tokenType, audience, issuer...
}
```

**Evidence from Codebase:**
- Current session interface: `/Users/hagelk/non-ic-code/aistudio/lib/auth/server-session.ts:7-13` (7 fields)
- Proposed API key adds 2 more fields
- OAuth2 will add 6+ more fields
- **Total: 15+ fields in one interface**

**Problem:**
- Every consumer must handle all auth types
- Cannot use type narrowing effectively
- Changes to one auth type ripple to all consumers

**Recommendation:**
- Use discriminated unions (see ISP section above)
- Each auth type is independent, type-safe

---

### 3. Leaky Abstraction - Database Tables in API Design

**Severity:** MEDIUM  
**Location:** Data Model section

**Evidence:**
- API design directly exposes database table structure
- `api_keys` table columns become API response fields
- `api_key_usage` table structure dictates rate limiting implementation
- **Tight coupling between REST API and PostgreSQL schema**

**Current Pattern from Codebase:**
- Drizzle ORM schema: `/Users/hagelk/non-ic-code/aistudio/lib/db/schema/index.ts`
- 138 exported tables directly used in API routes
- Example: `/Users/hagelk/non-ic-code/aistudio/app/api/admin/users/route.ts:22` - Direct database model in response

**Problem:**
- Cannot change database schema without breaking API
- No DTO (Data Transfer Object) layer
- Database refactoring = API versioning headache

**Recommendation:**
- Create API DTOs separate from database models
- Example:
   ```typescript
   // Database model (internal)
   interface ApiKeyEntity { id, userId, keyHash, scopes, ... }
   
   // API response (external)
   interface ApiKeyResponse { id, name, scopes, createdAt }
   ```

---

### 4. Shotgun Surgery Risk - Scope System Across 3 Phases

**Severity:** HIGH  
**Location:** Scope hierarchy (Decision #2) + Three-Phase Roadmap

**Evidence:**
- Phase 1: `graph:read`, `graph:write` (2 scopes)
- Phase 2: `assistant:42:execute` (dynamic per-assistant scopes)
- Phase 3: `mcp:search_decisions`, OAuth2 standard scopes
- **No scope registry or centralized validation**

**Files That Will Need Changes:**
1. Middleware (auth check)
2. API routes (scope validation)
3. Database schema (scope storage format)
4. Admin UI (scope management)
5. Documentation (scope list)
6. Tests (scope validation tests)

**Current Pattern:**
- Tool-based permissions: `/Users/hagelk/non-ic-code/aistudio/lib/auth/role-helpers.ts`
- Navigation permissions: `/Users/hagelk/non-ic-code/aistudio/infra/database/schema/023-navigation-multi-roles.sql`
- **No unified permission/scope system** - scattered across codebase

**Recommendation:**
- Create **ScopeRegistry** with centralized definitions
- Use TypeScript discriminated unions for compile-time scope validation
- Example:
   ```typescript
   type Scope = 
     | `graph:${'read'|'write'}`
     | `assistant:${number}:${'read'|'execute'}`
     | 'mcp:*'
   ```

---

## Critical Questions - Answered

### Q1: Are there SOLID violations or anti-patterns?

**YES - 8 violations total:**
- 2 SRP violations (dual-mode middleware, mixed concerns)
- 3 OCP violations (hardcoded scopes, no auth strategy, coupled rate limiting)
- 1 ISP violation (bloated AuthContext)
- 2 DIP violations (direct PostgreSQL dependency, no crypto abstraction)

### Q2: Is the scope system flexible enough for Phase 2 & 3?

**NO - Major reversibility risk:**

**Phase 1 → Phase 2 migration pain:**
- Static scopes (`graph:read`) → Dynamic scopes (`assistant:42:execute`)
- Requires changing from string array to parsed structure
- Database migration: JSONB string array → structured format
- **Evidence:** No scope parsing logic planned

**Phase 2 → Phase 3 migration pain:**
- Custom scopes → OAuth2 standard scopes (`openid`, `profile`, `email`)
- Wildcard matching (`assistants:*`) incompatible with OAuth2 scope negotiation
- OAuth2 requires scope **downgrade** (requested vs granted) - not designed for

**Recommendation:**
- Use **OAuth2-compatible scope syntax from day 1**
- Example: `https://aistudio.psd401.net/scopes/graph.read`
- Avoids future migration

### Q3: Is SHA-256 the right choice?

**YES - with caveats:**

**Why SHA-256 is correct:**
- API keys are 40-char random hex = 160 bits entropy
- SHA-256 provides sufficient collision resistance
- argon2/bcrypt are for **low-entropy** user passwords (brute-force resistance)
- **High-entropy random keys don't need slow hashing**

**Evidence Supporting SHA-256:**
- GitHub uses SHA-256 for personal access tokens
- AWS uses SHA-256 for access key IDs
- Industry standard for high-entropy secrets

**But - Missing pepper/HMAC:**
- SHA-256 alone is vulnerable if database is compromised
- **Recommendation:** Use HMAC-SHA256 with application-level secret
- `hash = HMAC-SHA256(apiKey, SECRET_PEPPER)`
- Pepper stored in AWS Secrets Manager, not database
- **Even if database leaks, keys cannot be verified without pepper**

### Q4: Will PostgreSQL rate limiting create bottlenecks?

**YES - at scale:**

**Bottleneck Analysis:**
- Write throughput: 100 API keys × 60 req/min = 6,000 INSERTs/min
- Read throughput: 60 req/min × 100 keys = 6,000 SELECTs/min (time-range queries)
- **Total:** 12,000 DB operations/min = 200/sec
- Aurora Serverless v2 @ 2 ACU: ~200-400 TPS max
- **50% of database capacity consumed by rate limiting**

**Evidence from CLAUDE.md:**
- Current Aurora config: "Min 2 ACU, Max 8 ACU" (production)
- Connection pool: "max: 20 per container"
- "Auto-pause in dev" - optimized for cost, not throughput

**Scaling Issues:**
- PostgreSQL `DELETE` for old records creates lock contention
- Time-based indexes require periodic `VACUUM`
- Cannot horizontally scale (single PostgreSQL instance)

**Redis Comparison:**
- 100K+ ops/sec on single node
- Sub-millisecond latency
- Built-in TTL (automatic expiration)
- **No lock contention**

**Recommendation:**
- Use in-memory for MVP (single ECS container)
- Add Redis when scaling to multiple containers
- Keep PostgreSQL logging for auditing only (async writes)

### Q5: Any decisions that are hard to reverse?

**YES - 3 irreversible decisions:**

1. **Opaque API key format (`sk-` prefix)**
   - Once keys are issued, format is locked
   - Cannot change to JWT format later (breaks existing keys)
   - **Reversibility:** HARD - requires key rotation for all users

2. **Database schema for `api_keys` and `api_key_usage`**
   - PostgreSQL-specific features (JSONB, timestamp)
   - Cannot migrate to DynamoDB or MongoDB without data migration
   - **Reversibility:** MEDIUM - requires downtime and migration scripts
   - **Evidence:** CLAUDE.md shows immutable migrations 001-005, only 010+ allowed

3. **Scope string format** (Decision #2)
   - `resource:action` vs OAuth2 URIs vs JWTs
   - Changing format breaks all existing API keys
   - **Reversibility:** HARD - requires scope migration for every key

**Recommendation - Make These Decisions Reversible:**

1. **API Key Format - Use Versioned Prefixes:**
   ```
   sk_v1_<40-hex>  // Current SHA-256 opaque keys
   sk_v2_<jwt>     // Future: JWT-based keys with embedded scopes
   ```
   - Allows gradual migration to JWT tokens
   - Both formats supported simultaneously

2. **Database Schema - Add Abstraction Layer:**
   ```typescript
   interface ApiKeyRepository {
     create(key: ApiKey): Promise<void>
     verify(hash: string): Promise<ApiKey | null>
     revoke(id: string): Promise<void>
   }
   ```
   - Implement `PostgresApiKeyRepository`
   - Future: `DynamoDBApiKeyRepository` without changing business logic

3. **Scope Format - Use Extensible Schema:**
   ```typescript
   type ScopeV1 = `graph:${'read'|'write'}`
   type ScopeV2 = `https://aistudio.psd401.net/scopes/${string}`
   type Scope = ScopeV1 | ScopeV2
   ```
   - Accept both formats during migration
   - Gradually deprecate old format

### Q6: What's missing?

**CRITICAL - 6 Missing Components:**

1. **Authentication Security:**
   - ❌ No API key rotation mechanism
   - ❌ No key compromise detection (unusual usage patterns)
   - ❌ No IP allowlisting for keys
   - ❌ No webhook validation (HMAC signatures for callbacks)

2. **Observability:**
   - ❌ No CloudWatch metrics for API key usage
   - ❌ No alerting for rate limit violations
   - ❌ No audit log retention policy
   - **Evidence:** CLAUDE.md shows consolidated monitoring, but no API key metrics

3. **Developer Experience:**
   - ❌ No API key testing/sandbox mode
   - ❌ No API documentation (OpenAPI/Swagger spec)
   - ❌ No SDK or client libraries
   - ❌ No example code for integration

4. **Error Handling:**
   - ❌ No standardized error codes for API responses
   - ❌ No retry-after headers for rate limits
   - **Current pattern:** `/Users/hagelk/non-ic-code/aistudio/lib/error-utils.ts` has 60+ error codes, but no API-specific codes

5. **Security Headers:**
   - ❌ No `X-API-Version` header
   - ❌ No `X-RateLimit-*` headers in spec
   - ❌ No `X-Request-ID` for tracing
   - **Current pattern:** Middleware adds security headers, but no API-specific headers

6. **Data Retention:**
   - ❌ No GDPR/data deletion policy for API keys
   - ❌ No `api_key_usage` table cleanup (will grow forever)
   - ❌ No S3 archival for old audit logs

**Recommendations - Add Before Phase 1:**

1. **Key Rotation:**
   ```sql
   ALTER TABLE api_keys ADD COLUMN rotation_scheduled_at TIMESTAMP;
   ALTER TABLE api_keys ADD COLUMN previous_key_hash VARCHAR(64);
   ```

2. **Monitoring:**
   ```typescript
   // Add to CloudWatch metrics
   - aistudio.api.requests (by key_id, endpoint)
   - aistudio.api.errors (by error_code)
   - aistudio.api.latency (p50, p95, p99)
   ```

3. **Error Codes:**
   ```typescript
   enum ApiErrorCode {
     INVALID_API_KEY = 'invalid_api_key',
     RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
     INSUFFICIENT_SCOPE = 'insufficient_scope',
     KEY_EXPIRED = 'key_expired',
     KEY_REVOKED = 'key_revoked'
   }
   ```

4. **Cleanup Job:**
   ```sql
   -- Scheduled Lambda to delete old usage records
   DELETE FROM api_key_usage 
   WHERE request_at < NOW() - INTERVAL '90 days';
   ```

---

## Structural Recommendations

### 1. Layered Architecture for API Platform

**Proposed Structure:**
```
/lib/api-platform/
├── auth/
│   ├── strategies/
│   │   ├── api-key-strategy.ts
│   │   ├── session-strategy.ts
│   │   └── oauth2-strategy.ts (Phase 3)
│   ├── auth-context.ts (discriminated unions)
│   └── middleware.ts
├── scopes/
│   ├── scope-registry.ts
│   ├── validators/
│   │   ├── basic-validator.ts (Phase 1)
│   │   ├── hierarchical-validator.ts (Phase 2)
│   │   └── oauth2-validator.ts (Phase 3)
│   └── types.ts
├── rate-limiting/
│   ├── rate-limiter.interface.ts
│   ├── in-memory-limiter.ts (Phase 1)
│   ├── postgres-limiter.ts (Phase 2)
│   └── redis-limiter.ts (future)
├── repositories/
│   ├── api-key-repository.interface.ts
│   ├── postgres-api-key-repository.ts
│   └── usage-repository.interface.ts
└── services/
    ├── key-hashing-service.ts
    └── permission-resolver.ts
```

### 2. Database Schema Improvements

**Add versioning and soft deletes:**
```sql
ALTER TABLE api_keys ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE api_keys ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE api_keys ADD COLUMN rotation_scheduled_at TIMESTAMP;

-- Partition api_key_usage by month for performance
CREATE TABLE api_key_usage_2026_01 PARTITION OF api_key_usage
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
```

### 3. Type-Safe Scope System

```typescript
// Phase 1
type GraphScope = `graph:${'read' | 'write'}`

// Phase 2
type AssistantScope = `assistant:${number}:${'read' | 'execute'}`

// Phase 3
type OAuthScope = 'openid' | 'profile' | 'email'

// Combined
type ApiScope = GraphScope | AssistantScope | OAuthScope

// Validation at compile time
function checkScope(scope: ApiScope) { }
checkScope('graph:read')        // ✅
checkScope('graph:delete')      // ❌ TypeScript error
checkScope('assistant:42:read') // ✅
```

---

## Overall Assessment

**Architecture Health:** **NEEDS ATTENTION**

**Top Priority Fixes (Before Phase 1 Implementation):**

1. **Add abstraction layers for authentication strategies**
   - **Impact:** Prevents rewrite when adding OAuth2 in Phase 3
   - **Effort:** Medium (2-3 days)
   - **File:** Create `/lib/api-platform/auth/strategies/`

2. **Start with in-memory rate limiting, defer PostgreSQL**
   - **Impact:** Avoids premature database bottleneck
   - **Effort:** Low (extend existing `/lib/rate-limit.ts`)
   - **Risk:** PostgreSQL write amplification at scale

3. **Use discriminated unions for AuthContext**
   - **Impact:** Type safety, prevents God Object
   - **Effort:** Low (1 day)
   - **File:** `/lib/api-platform/auth/auth-context.ts`

4. **Add HMAC pepper to key hashing**
   - **Impact:** Security - database breach doesn't expose keys
   - **Effort:** Low (store pepper in Secrets Manager)
   - **File:** `/lib/api-platform/services/key-hashing-service.ts`

5. **Design OAuth2-compatible scope syntax from day 1**
   - **Impact:** Prevents scope migration in Phase 3
   - **Effort:** Medium (scope registry + validators)
   - **Risk:** Changing scope format breaks all existing keys

6. **Add API key repository abstraction**
   - **Impact:** Enables database migration without code changes
   - **Effort:** Medium (interface + PostgreSQL implementation)
   - **File:** `/lib/api-platform/repositories/`

**Migration Risks by Phase:**

| Phase | Risk | Mitigation |
|-------|------|------------|
| 1→2 | Static → dynamic scopes | Use scope registry + parsing from start |
| 2→3 | Custom → OAuth2 scopes | OAuth2-compatible syntax in Phase 1 |
| Any | PostgreSQL → Redis rate limiting | Abstract rate limiter interface now |
| Any | Database schema changes | Use repository pattern, not direct Drizzle |

**Evidence-Based Confidence:**
- Current codebase shows **strong factory pattern usage** (`nexus-provider-factory.ts`) - apply same pattern to auth
- Existing **Drizzle ORM abstractions** work well - extend to API keys
- Current **in-memory rate limiting** (`/lib/rate-limit.ts`) is proven - don't replace prematurely
- **Monitoring infrastructure exists** (CloudWatch, ADOT) - integrate API key metrics

**Final Verdict:**
The proposed architecture has **good intentions** (server-to-server auth, hierarchical scopes, phased approach) but **poor separation of concerns**. The decisions are salvageable if abstraction layers are added BEFORE implementation. The biggest risk is **premature PostgreSQL rate limiting** and **lack of auth strategy pattern** - both will cause pain in Phases 2 and 3.