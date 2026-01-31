# Agent "Security review of API platform" completed

Now let me provide the comprehensive security analysis based on the architecture you've described.

## SECURITY_ANALYSIS_RESULTS

### SUMMARY
Critical: 4
High Priority: 8
Suggestions: 6
Positive Practices: 5

---

### CRITICAL_ISSUES

**Issue 1: Weak Key Hashing Algorithm**
**File:** API Key System Design (Pre-Implementation)
**Problem:** SHA-256 alone is insufficient for hashing API keys. It's a fast hashing algorithm designed for data integrity, not password/secret hashing.
**Risk:** 
- Attackers with database access could use GPU-accelerated rainbow tables to crack keys at ~50 billion hashes/second
- If any key is compromised, attackers could reverse-engineer the full key from the hash
- No computational cost for brute force attacks

**Fix:**
```typescript
// Current (VULNERABLE)
const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

// Secure (FIXED) - Use Argon2id with proper parameters
import argon2 from 'argon2';

const keyHash = await argon2.hash(apiKey, {
  type: argon2.argon2id,
  memoryCost: 65536,      // 64 MB
  timeCost: 3,            // 3 iterations
  parallelism: 4,         // 4 threads
  hashLength: 32          // 256 bits
});

// For verification
const isValid = await argon2.verify(keyHash, providedKey);
```

**Alternative (if Argon2 unavailable):**
```typescript
import bcrypt from 'bcrypt';
const SALT_ROUNDS = 12; // Minimum 10, recommend 12+

const keyHash = await bcrypt.hash(apiKey, SALT_ROUNDS);
const isValid = await bcrypt.compare(providedKey, keyHash);
```

**Reference:** 
- OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Use Argon2id (winner of Password Hashing Competition)

---

**Issue 2: Insufficient Key Entropy**
**File:** API Key System Design (Pre-Implementation)
**Problem:** 40 hex characters (160 bits) from `crypto.randomBytes(20)` is below current best practices for API keys, especially for a system that may handle sensitive educational data.
**Risk:**
- While 160 bits is generally secure, industry standards (GitHub, Stripe, AWS) use 256+ bits
- Future quantum computing threats require higher entropy
- K-12 environment requires defense-in-depth

**Fix:**
```typescript
// Current (WEAK)
const apiKey = 'sk-' + crypto.randomBytes(20).toString('hex'); // 160 bits

// Secure (FIXED)
const apiKey = 'sk-' + crypto.randomBytes(32).toString('hex'); // 256 bits
// Results in: sk-[64 hex characters]

// Or use base64url for shorter keys with same entropy
const apiKey = 'sk-' + crypto.randomBytes(32).toString('base64url'); // 256 bits, 43 chars
// Results in: sk-[43 alphanumeric characters]
```

**Rationale:**
- 256 bits is the current industry standard (Stripe, GitHub, AWS)
- Provides quantum-resistance headroom
- Marginal storage cost for significant security improvement

**Reference:** NIST SP 800-57: Recommend 256-bit keys for long-term protection

---

**Issue 3: Rate Limiting Timing Attack & Race Conditions**
**File:** Rate Limiting System (Pre-Implementation)
**Problem:** PostgreSQL-based sliding window via INSERT + COUNT has multiple attack vectors:
1. **Race condition**: Multiple concurrent requests could bypass limit before COUNT updates
2. **Timing attack**: Response time differences reveal proximity to rate limit
3. **Database load**: Each request hits database twice (INSERT + COUNT)

**Risk:**
- Attackers can exceed rate limits via concurrent request flooding
- Timing side-channel leaks information about API usage patterns
- Database becomes DoS vector under high load

**Fix:**
```typescript
// VULNERABLE PATTERN (don't implement this)
async function checkRateLimit(keyHash: string): Promise<boolean> {
  await db.insert(apiKeyUsage).values({ keyHash, timestamp: new Date() });
  const count = await db
    .select({ count: sql`COUNT(*)` })
    .from(apiKeyUsage)
    .where(
      and(
        eq(apiKeyUsage.keyHash, keyHash),
        gte(apiKeyUsage.timestamp, new Date(Date.now() - 60000))
      )
    );
  return count[0].count < 60;
}

// SECURE ALTERNATIVE 1: Use PostgreSQL advisory locks + atomic operation
async function checkRateLimit(keyHash: string): Promise<boolean> {
  return await executeTransaction(async (tx) => {
    // Acquire advisory lock (prevents race conditions)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${keyHash}))`);
    
    // Atomic INSERT and cleanup old records
    const result = await tx.execute(sql`
      WITH cleanup AS (
        DELETE FROM api_key_usage 
        WHERE key_hash = ${keyHash} 
        AND timestamp < NOW() - INTERVAL '1 minute'
      ),
      current_count AS (
        SELECT COUNT(*) as count 
        FROM api_key_usage 
        WHERE key_hash = ${keyHash}
      )
      INSERT INTO api_key_usage (key_hash, timestamp)
      SELECT ${keyHash}, NOW()
      WHERE (SELECT count FROM current_count) < 60
      RETURNING (SELECT count FROM current_count) as count;
    `);
    
    return result.rows.length > 0; // true if inserted (under limit)
  }, "checkRateLimit");
}

// SECURE ALTERNATIVE 2: Use Redis (recommended for production)
import { Redis } from 'ioredis';

async function checkRateLimitRedis(keyHash: string): Promise<boolean> {
  const redis = new Redis(process.env.REDIS_URL);
  const key = `ratelimit:${keyHash}`;
  
  const current = await redis.incr(key);
  
  if (current === 1) {
    await redis.expire(key, 60); // 60 seconds
  }
  
  return current <= 60;
}

// SECURE ALTERNATIVE 3: Token bucket with constant-time response
async function checkRateLimitTokenBucket(keyHash: string) {
  const now = Date.now();
  const limit = 60; // tokens
  const windowMs = 60000; // 1 minute
  
  const bucket = await executeQuery(
    (db) => db
      .select()
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.keyHash, keyHash))
      .limit(1),
    "getRateLimitBucket"
  );
  
  let tokens = limit;
  let lastRefill = now;
  
  if (bucket.length > 0) {
    const elapsed = now - bucket[0].lastRefill;
    const refillAmount = (elapsed / windowMs) * limit;
    tokens = Math.min(limit, bucket[0].tokens + refillAmount);
    lastRefill = bucket[0].lastRefill;
  }
  
  if (tokens >= 1) {
    await executeQuery(
      (db) => db
        .insert(rateLimitBuckets)
        .values({ keyHash, tokens: tokens - 1, lastRefill: now })
        .onConflictDoUpdate({
          target: rateLimitBuckets.keyHash,
          set: { tokens: tokens - 1, lastRefill: now }
        }),
      "updateRateLimitBucket"
    );
    return true;
  }
  
  // Always add same processing delay (constant-time)
  await new Promise(resolve => setTimeout(resolve, 10));
  return false;
}
```

**Reference:** 
- OWASP Rate Limiting: https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
- Redis Rate Limiting Patterns: https://redis.io/docs/manual/patterns/rate-limiter/

---

**Issue 4: Session Users with Wildcard Scopes**
**File:** Auth Flow Design (Pre-Implementation)
**Problem:** Giving session users `scopes: ["*"]` violates principle of least privilege and creates privilege escalation risk.
**Risk:**
- If session token is compromised, attacker has unlimited API access
- No audit trail distinguishing UI actions from API actions
- Cannot restrict session users from dangerous API operations
- Future OAuth2 clients could inherit these overly broad permissions

**Fix:**
```typescript
// Current (INSECURE)
const authContext = {
  userId,
  scopes: ["*"], // Full access - TOO PERMISSIVE
  authType: "session"
};

// Secure (FIXED) - Grant explicit scopes based on user roles
async function getSessionScopes(userId: number): Promise<string[]> {
  const userRoles = await executeQuery(
    (db) => db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId)),
    "getUserRoles"
  );
  
  const scopes: Set<string> = new Set();
  
  // Map roles to scopes
  for (const role of userRoles) {
    if (role.roleId === ADMINISTRATOR_ROLE_ID) {
      scopes.add("admin:*");
      scopes.add("graph:read");
      scopes.add("graph:write");
      scopes.add("assistants:*");
      scopes.add("conversations:read");
      scopes.add("conversations:write");
    } else if (role.roleId === STAFF_ROLE_ID) {
      scopes.add("graph:read");
      scopes.add("assistants:read");
      scopes.add("assistants:execute");
      scopes.add("conversations:read");
      scopes.add("conversations:write");
    } else if (role.roleId === STUDENT_ROLE_ID) {
      scopes.add("assistants:read");
      scopes.add("assistants:execute");
      scopes.add("conversations:read");
      scopes.add("conversations:write");
    }
  }
  
  return Array.from(scopes);
}

// In auth flow
const session = await getServerSession();
const scopes = await getSessionScopes(session.user.id);

return {
  userId: session.user.id,
  scopes, // Explicit, role-based scopes
  authType: "session"
};
```

**Alternative Pattern:**
```typescript
// Special marker for session-based auth that requires additional checks
const authContext = {
  userId,
  scopes: [], // Empty array for sessions
  authType: "session",
  isSessionAuth: true // Flag to use role-based permission checks
};

// In endpoint authorization
if (authContext.isSessionAuth) {
  // Use existing hasToolAccess() logic
  const hasAccess = await hasToolAccess(userId, requiredPermission);
  if (!hasAccess) throw ErrorFactories.authInsufficientPermissions();
} else {
  // API key - use scope checking
  if (!hasScope(authContext.scopes, requiredScope)) {
    throw ErrorFactories.authInsufficientPermissions();
  }
}
```

**Reference:** OAuth 2.0 Security Best Current Practice: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics

---

### HIGH_PRIORITY

**Issue 5: Missing Key Rotation Mechanism**
**File:** API Key System Design (Pre-Implementation)
**Problem:** No forced key rotation policy. "Optional expiration (no forced rotation)" allows keys to remain valid indefinitely.
**Risk:**
- Stale keys increase attack surface
- No mechanism to respond to suspected compromise
- Compliance issues (FERPA may require periodic credential rotation)
- K-12 staff turnover means orphaned keys accumulate

**Fix:**
```typescript
// Add to api_keys table schema
interface ApiKey {
  id: number;
  keyHash: string;
  prefix: string;
  userId: number;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null; // Track usage
  createdAt: Date;
  
  // NEW FIELDS
  rotationWarningAt: Date | null; // Warning issued to user
  maxLifetimeDays: number; // Default 90 days
}

// Implement rotation warning system
async function checkKeyRotation(keyId: number): Promise<void> {
  const key = await getApiKey(keyId);
  const ageInDays = (Date.now() - key.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  
  if (ageInDays > key.maxLifetimeDays - 7 && !key.rotationWarningAt) {
    // Send warning email
    await sendRotationWarning(key.userId, key.id);
    await updateKey(key.id, { rotationWarningAt: new Date() });
  }
  
  if (ageInDays > key.maxLifetimeDays) {
    // Auto-revoke and notify
    await revokeKey(key.id, "automatic_rotation");
    await sendKeyExpiredNotification(key.userId, key.id);
  }
}

// Admin dashboard: List keys by age
async function getAgedKeys(thresholdDays: number = 60) {
  return await executeQuery(
    (db) => db
      .select()
      .from(apiKeys)
      .where(
        and(
          isNull(apiKeys.revokedAt),
          sql`EXTRACT(DAY FROM NOW() - created_at) > ${thresholdDays}`
        )
      ),
    "getAgedKeys"
  );
}
```

**Policy Recommendation:**
- Default max lifetime: 90 days
- Warning at 83 days (7 days before expiration)
- Allow admin override for specific integrations
- Require admin approval for keys > 365 days

---

**Issue 6: No Audit Logging for Key Operations**
**File:** API Key System Design (Pre-Implementation)
**Problem:** No mention of audit logging for key creation, usage, or revocation.
**Risk:**
- Cannot detect unauthorized key creation
- No forensic evidence after security incident
- Compliance violation (FERPA requires access logs for educational records)
- Cannot identify compromised keys

**Fix:**
```typescript
// Create audit log table
interface ApiKeyAuditLog {
  id: number;
  apiKeyId: number;
  eventType: 'created' | 'used' | 'revoked' | 'failed_auth' | 'scope_violation';
  userId: number; // Who performed the action
  ipAddress: string;
  userAgent: string;
  endpoint: string | null; // Which API endpoint was called
  scopeChecked: string | null; // Which scope was validated
  success: boolean;
  errorMessage: string | null;
  metadata: Record<string, unknown>; // Additional context
  timestamp: Date;
}

// Log all key operations
async function auditKeyEvent(params: {
  keyId: number;
  eventType: ApiKeyAuditLog['eventType'];
  userId: number;
  request: Request;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}) {
  const ipAddress = request.headers.get('x-forwarded-for') || 
                    request.headers.get('x-real-ip') || 
                    'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  
  await executeQuery(
    (db) => db.insert(apiKeyAuditLogs).values({
      apiKeyId: params.keyId,
      eventType: params.eventType,
      userId: params.userId,
      ipAddress,
      userAgent,
      endpoint: new URL(request.url).pathname,
      success: params.success,
      errorMessage: params.error,
      metadata: params.metadata,
      timestamp: new Date()
    }),
    "auditKeyEvent"
  );
  
  // Also log to CloudWatch for alerting
  log.info("API key event", {
    keyId: params.keyId,
    eventType: params.eventType,
    success: params.success,
    ipAddress
  });
}

// Alert on suspicious patterns
async function detectAnomalies(keyId: number): Promise<void> {
  // Multiple failed attempts
  const recentFailures = await executeQuery(
    (db) => db
      .select({ count: sql`COUNT(*)` })
      .from(apiKeyAuditLogs)
      .where(
        and(
          eq(apiKeyAuditLogs.apiKeyId, keyId),
          eq(apiKeyAuditLogs.success, false),
          gte(apiKeyAuditLogs.timestamp, new Date(Date.now() - 300000)) // 5 min
        )
      ),
    "countRecentFailures"
  );
  
  if (recentFailures[0].count > 5) {
    await revokeKey(keyId, "anomaly_detection");
    await alertAdmin(`API key ${keyId} auto-revoked: multiple failed auth attempts`);
  }
  
  // Geographic anomaly (IP from different country within 1 hour)
  const recentIps = await executeQuery(
    (db) => db
      .selectDistinct({ ipAddress: apiKeyAuditLogs.ipAddress })
      .from(apiKeyAuditLogs)
      .where(
        and(
          eq(apiKeyAuditLogs.apiKeyId, keyId),
          gte(apiKeyAuditLogs.timestamp, new Date(Date.now() - 3600000)) // 1 hour
        )
      ),
    "getRecentIps"
  );
  
  if (recentIps.length > 3) {
    await alertAdmin(`API key ${keyId}: used from ${recentIps.length} different IPs in 1 hour`);
  }
}
```

**Retention Policy:**
- Keep audit logs for 1 year minimum (FERPA compliance)
- Archive to S3 Glacier after 90 days
- Implement CloudWatch alerts for anomalies

**Reference:** FERPA 34 CFR § 99.32 - Record of Requests and Disclosures

---

**Issue 7: Scope Wildcard Matching - Potential Over-Permissioning**
**File:** Scope System Design (Pre-Implementation)
**Problem:** Wildcard pattern `"assistants:*"` matches `"assistants:list"` and `"assistant:42:execute"` - the implementation could grant unintended access.
**Risk:**
- `admin:*` could match `admin_delete_all_data` if not carefully validated
- Future endpoints could accidentally inherit broad permissions
- Difficult to audit exact permissions granted

**Fix:**
```typescript
// INSECURE wildcard matching (naive implementation)
function hasScope(userScopes: string[], requiredScope: string): boolean {
  return userScopes.some(scope => {
    if (scope === '*') return true;
    if (scope.endsWith(':*')) {
      const prefix = scope.slice(0, -1); // Remove '*'
      return requiredScope.startsWith(prefix);
    }
    return scope === requiredScope;
  });
}
// Problem: "a:*" matches "abc:read" (unintended)

// SECURE wildcard matching
function hasScope(userScopes: string[], requiredScope: string): boolean {
  return userScopes.some(scope => {
    if (scope === '*') return true; // Global wildcard (should never be granted to API keys)
    
    if (scope.endsWith(':*')) {
      const prefix = scope.slice(0, -2); // Remove ':*'
      const parts = requiredScope.split(':');
      
      // Must match prefix exactly at segment boundary
      return parts[0] === prefix;
    }
    
    return scope === requiredScope;
  });
}

// Better: Use structured scope format with validation
interface ParsedScope {
  resource: string; // "assistants", "graph", "admin"
  action: string;   // "read", "write", "execute", "delete"
  identifier?: string; // Optional resource ID
}

function parseScope(scope: string): ParsedScope {
  const match = scope.match(/^([a-z_]+):([a-z_*]+)(?::(.+))?$/);
  if (!match) throw new Error(`Invalid scope format: ${scope}`);
  
  return {
    resource: match[1],
    action: match[2],
    identifier: match[3]
  };
}

function hasScope(userScopes: string[], requiredScope: string): boolean {
  const required = parseScope(requiredScope);
  
  return userScopes.some(scope => {
    const granted = parseScope(scope);
    
    // Resource must match exactly
    if (granted.resource !== required.resource) return false;
    
    // Action: exact match or wildcard
    if (granted.action !== '*' && granted.action !== required.action) return false;
    
    // Identifier: if granted has specific ID, must match; if wildcard, allow all
    if (granted.identifier && granted.identifier !== '*') {
      return granted.identifier === required.identifier;
    }
    
    return true;
  });
}

// Scope validation at key creation
const VALID_SCOPES = new Set([
  'graph:read',
  'graph:write',
  'graph:delete',
  'assistants:read',
  'assistants:execute',
  'assistants:*',
  'conversations:read',
  'conversations:write',
  'conversations:delete',
  'admin:users:read',
  'admin:users:write',
  'admin:settings:read',
  'admin:settings:write'
]);

function validateScopes(scopes: string[]): void {
  for (const scope of scopes) {
    if (!VALID_SCOPES.has(scope) && !scope.match(/^[a-z_]+:\*$/)) {
      throw new Error(`Invalid scope: ${scope}`);
    }
  }
  
  // Prevent dangerous combinations
  if (scopes.includes('*')) {
    throw new Error('Wildcard scope "*" is not allowed for API keys');
  }
  
  if (scopes.includes('admin:*') && scopes.length > 1) {
    throw new Error('admin:* cannot be combined with other scopes');
  }
}
```

**Reference:** OAuth 2.0 Scope Best Practices: https://www.oauth.com/oauth2-servers/scope/defining-scopes/

---

**Issue 8: No IP Allowlist/Restrictions**
**File:** API Key System Design (Pre-Implementation)
**Problem:** API keys can be used from any IP address, increasing risk of stolen key abuse.
**Risk:**
- Stolen keys can be used from anywhere in the world
- No protection against credential stuffing
- Cannot restrict keys to known integration servers

**Fix:**
```typescript
// Add to api_keys table
interface ApiKey {
  // ... existing fields
  allowedIps: string[] | null; // CIDR notation, null = allow all
  allowedOrigins: string[] | null; // For webhook callbacks
}

// IP validation middleware
async function validateIpRestriction(
  key: ApiKey,
  requestIp: string
): Promise<void> {
  if (!key.allowedIps || key.allowedIps.length === 0) {
    return; // No restriction
  }
  
  const isAllowed = key.allowedIps.some(allowed => {
    if (allowed.includes('/')) {
      // CIDR range
      return ipInCidr(requestIp, allowed);
    }
    return requestIp === allowed;
  });
  
  if (!isAllowed) {
    throw ErrorFactories.authInsufficientPermissions(
      `IP ${requestIp} not in allowlist for this API key`
    );
  }
}

// Helper function for CIDR matching
import { isIPv4, isIPv6 } from 'net';
import ipaddr from 'ipaddr.js';

function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const addr = ipaddr.parse(ip);
    const range = ipaddr.parseCIDR(cidr);
    return addr.match(range);
  } catch {
    return false;
  }
}

// Admin UI for IP management
interface ApiKeyCreateRequest {
  name: string;
  scopes: string[];
  expiresAt?: Date;
  allowedIps?: string[]; // ["192.168.1.100", "10.0.0.0/8"]
}
```

**Recommendation:**
- Make IP restriction optional but recommended
- Provide CIDR calculator in admin UI
- Support both IPv4 and IPv6
- Log all requests from non-allowlisted IPs (even if restriction disabled)

---

**Issue 9: No Request Signature Verification**
**File:** API Key System Design (Pre-Implementation)
**Problem:** API key authentication alone doesn't protect against man-in-the-middle attacks or replay attacks.
**Risk:**
- Captured requests can be replayed
- Request body tampering not detected
- No protection if TLS is compromised

**Fix:**
```typescript
// Implement HMAC request signing (like AWS Signature v4)
interface SignedRequest {
  timestamp: number; // Unix timestamp in seconds
  signature: string; // HMAC-SHA256 of canonical request
}

// Server-side signature verification
async function verifyRequestSignature(
  request: Request,
  apiKey: ApiKey
): Promise<void> {
  const timestamp = request.headers.get('X-Timestamp');
  const providedSignature = request.headers.get('X-Signature');
  
  if (!timestamp || !providedSignature) {
    throw ErrorFactories.authInvalidCredentials('Missing signature headers');
  }
  
  // Prevent replay attacks (allow 5 minute clock skew)
  const now = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);
  if (Math.abs(now - requestTime) > 300) {
    throw ErrorFactories.authInvalidCredentials('Request timestamp expired');
  }
  
  // Construct canonical request
  const method = request.method;
  const path = new URL(request.url).pathname;
  const body = await request.text();
  const canonicalRequest = `${method}\n${path}\n${timestamp}\n${body}`;
  
  // Derive signing key from API key (stored securely)
  const signingKey = await getSigningKey(apiKey.id);
  
  // Compute expected signature
  const expectedSignature = crypto
    .createHmac('sha256', signingKey)
    .update(canonicalRequest)
    .digest('hex');
  
  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature)
  )) {
    throw ErrorFactories.authInvalidCredentials('Invalid signature');
  }
}

// Client-side signing example
function signRequest(
  method: string,
  path: string,
  body: string,
  apiKey: string,
  signingSecret: string
): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonicalRequest = `${method}\n${path}\n${timestamp}\n${body}`;
  
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(canonicalRequest)
    .digest('hex');
  
  return { timestamp, signature };
}

// Usage
const { timestamp, signature } = signRequest('POST', '/api/v1/assistants/execute', requestBody, apiKey, signingSecret);

fetch('/api/v1/assistants/execute', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json'
  },
  body: requestBody
});
```

**Recommendation:**
- Make signature verification optional initially
- Require for sensitive endpoints (admin operations)
- Provide client libraries with built-in signing
- Document signing algorithm clearly

**Reference:** AWS Signature Version 4: https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html

---

**Issue 10: Missing Scope Escalation Prevention**
**File:** API Key System Design (Pre-Implementation)
**Problem:** No mechanism described to prevent users from creating API keys with scopes they don't possess via their session.
**Risk:**
- Staff user could create API key with `admin:*` scope
- Privilege escalation via API key creation
- Bypasses role-based access control

**Fix:**
```typescript
// Validate key scopes against user's session permissions
async function createApiKey(
  userId: number,
  params: { name: string; scopes: string[]; expiresAt?: Date }
): Promise<ActionState<{ key: string; keyId: number }>> {
  const log = createLogger({ action: "createApiKey", userId });
  
  try {
    // Get user's effective scopes from their roles
    const userScopes = await getUserEffectiveScopes(userId);
    
    // Validate requested scopes against user's permissions
    for (const requestedScope of params.scopes) {
      if (!canGrantScope(userScopes, requestedScope)) {
        throw ErrorFactories.validationFailed([{
          field: 'scopes',
          message: `You do not have permission to grant scope: ${requestedScope}`
        }]);
      }
    }
    
    // Proceed with key creation...
    
  } catch (error) {
    return handleError(error, "Failed to create API key", { userId });
  }
}

// Check if user can grant a specific scope
function canGrantScope(userScopes: string[], requestedScope: string): boolean {
  // Admin users can grant any non-wildcard scope
  if (userScopes.includes('admin:*')) {
    return requestedScope !== '*'; // Prevent granting global wildcard
  }
  
  // Users can only grant scopes they possess
  return hasScope(userScopes, requestedScope);
}

// Get user's effective scopes from roles
async function getUserEffectiveScopes(userId: number): Promise<string[]> {
  const roles = await executeQuery(
    (db) => db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId)),
    "getUserRoles"
  );
  
  const scopes: Set<string> = new Set();
  
  for (const role of roles) {
    const roleScopes = await getRoleScopesMapping(role.roleId);
    roleScopes.forEach(scope => scopes.add(scope));
  }
  
  return Array.from(scopes);
}

// Map roles to allowed scopes
async function getRoleScopesMapping(roleId: number): Promise<string[]> {
  // Could be database-driven or hardcoded based on role
  const scopeMap: Record<number, string[]> = {
    [ADMINISTRATOR_ROLE_ID]: [
      'admin:*',
      'graph:read',
      'graph:write',
      'graph:delete',
      'assistants:*',
      'conversations:*'
    ],
    [STAFF_ROLE_ID]: [
      'graph:read',
      'assistants:read',
      'assistants:execute',
      'conversations:read',
      'conversations:write'
    ],
    [STUDENT_ROLE_ID]: [
      'assistants:read',
      'assistants:execute',
      'conversations:read',
      'conversations:write'
    ]
  };
  
  return scopeMap[roleId] || [];
}
```

**Enforcement Points:**
1. API key creation action
2. API key scope update action
3. Admin UI form validation
4. Database constraint (future enhancement)

---

**Issue 11: No Key Usage Monitoring Dashboard**
**File:** API Key System Design (Pre-Implementation)
**Problem:** No mentioned tooling for administrators to monitor API key usage.
**Risk:**
- Cannot detect abuse or anomalies
- No visibility into integration health
- Difficult to identify unused keys for cleanup

**Fix:**
Create admin dashboard at `/app/(protected)/admin/api-keys/monitoring` with:

```typescript
// Monitoring queries
interface KeyUsageStats {
  keyId: number;
  keyName: string;
  owner: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  lastUsedAt: Date | null;
  topEndpoints: Array<{ endpoint: string; count: number }>;
  errorRate: number;
}

async function getKeyUsageStats(
  timeRange: '1h' | '24h' | '7d' | '30d'
): Promise<KeyUsageStats[]> {
  const rangeMs: Record<typeof timeRange, number> = {
    '1h': 3600000,
    '24h': 86400000,
    '7d': 604800000,
    '30d': 2592000000
  };
  
  const since = new Date(Date.now() - rangeMs[timeRange]);
  
  return await executeQuery(
    (db) => db
      .select({
        keyId: apiKeys.id,
        keyName: apiKeys.name,
        owner: sql`${users.firstName} || ' ' || ${users.lastName}`,
        totalRequests: sql<number>`COUNT(${apiKeyAuditLogs.id})`,
        successfulRequests: sql<number>`COUNT(*) FILTER (WHERE ${apiKeyAuditLogs.success})`,
        failedRequests: sql<number>`COUNT(*) FILTER (WHERE NOT ${apiKeyAuditLogs.success})`,
        lastUsedAt: sql<Date>`MAX(${apiKeyAuditLogs.timestamp})`
      })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .leftJoin(
        apiKeyAuditLogs,
        and(
          eq(apiKeyAuditLogs.apiKeyId, apiKeys.id),
          gte(apiKeyAuditLogs.timestamp, since)
        )
      )
      .groupBy(apiKeys.id, users.id),
    "getKeyUsageStats"
  );
}

// Alert on suspicious patterns
interface SecurityAlert {
  severity: 'low' | 'medium' | 'high' | 'critical';
  type: 'high_error_rate' | 'unusual_ip' | 'scope_violation' | 'rate_limit_exceeded';
  keyId: number;
  message: string;
  timestamp: Date;
}

async function detectSecurityAlerts(): Promise<SecurityAlert[]> {
  const alerts: SecurityAlert[] = [];
  
  // High error rate (>20% failures in last hour)
  const errorRates = await executeQuery(
    (db) => db
      .select({
        keyId: apiKeyAuditLogs.apiKeyId,
        errorRate: sql<number>`
          COUNT(*) FILTER (WHERE NOT success)::float / COUNT(*)::float
        `
      })
      .from(apiKeyAuditLogs)
      .where(gte(apiKeyAuditLogs.timestamp, new Date(Date.now() - 3600000)))
      .groupBy(apiKeyAuditLogs.apiKeyId)
      .having(sql`COUNT(*) > 10`),
    "getErrorRates"
  );
  
  for (const stat of errorRates) {
    if (stat.errorRate > 0.2) {
      alerts.push({
        severity: 'high',
        type: 'high_error_rate',
        keyId: stat.keyId,
        message: `API key has ${(stat.errorRate * 100).toFixed(1)}% error rate`,
        timestamp: new Date()
      });
    }
  }
  
  return alerts;
}
```

**Dashboard Features:**
- Real-time request rate graphs
- Success/failure ratio
- Geographic request distribution map
- Top endpoints by key
- Unused keys (no requests in 30 days)
- Security alerts feed
- Export audit logs to CSV

---

**Issue 12: Rate Limit Headers Not Mentioned**
**File:** Rate Limiting System (Pre-Implementation)
**Problem:** Response should include standard rate limit headers per RFC 6585.
**Risk:**
- API clients cannot self-regulate usage
- Leads to unnecessary failed requests
- Poor developer experience

**Fix:**
```typescript
// Add standard rate limit headers to all API responses
async function addRateLimitHeaders(
  response: Response,
  keyHash: string
): Promise<Response> {
  const limit = 60; // requests per minute
  const windowMs = 60000;
  
  const usage = await getRateLimitUsage(keyHash);
  const remaining = Math.max(0, limit - usage.count);
  const resetTime = Math.ceil((usage.windowStart + windowMs) / 1000);
  
  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Limit', limit.toString());
  headers.set('X-RateLimit-Remaining', remaining.toString());
  headers.set('X-RateLimit-Reset', resetTime.toString());
  
  if (remaining === 0) {
    headers.set('Retry-After', ((resetTime * 1000 - Date.now()) / 1000).toFixed(0));
  }
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// 429 response format
function rateLimitExceeded(resetTime: number): Response {
  return new Response(
    JSON.stringify({
      error: 'RateLimitExceeded',
      message: 'API rate limit exceeded. Please retry after the reset time.',
      retryAfter: resetTime
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': ((resetTime * 1000 - Date.now()) / 1000).toFixed(0),
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': resetTime.toString()
      }
    }
  );
}
```

**Standard Headers:**
- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Requests remaining in current window
- `X-RateLimit-Reset`: Unix timestamp when limit resets
- `Retry-After`: Seconds until client should retry (on 429 only)

**Reference:** RFC 6585: https://tools.ietf.org/html/rfc6585#section-4

---

### SUGGESTIONS

**Issue 13: Consider Multiple Rate Limit Tiers**
**File:** Rate Limiting System (Pre-Implementation)
**Problem:** Single rate limit (60 req/min) may not fit all use cases.
**Recommendation:**
```typescript
interface ApiKey {
  // ... existing fields
  rateLimitTier: 'basic' | 'standard' | 'premium' | 'unlimited';
}

const RATE_LIMIT_TIERS = {
  basic: { requestsPerMinute: 30, requestsPerDay: 1000 },
  standard: { requestsPerMinute: 60, requestsPerDay: 5000 },
  premium: { requestsPerMinute: 120, requestsPerDay: 20000 },
  unlimited: { requestsPerMinute: Infinity, requestsPerDay: Infinity }
};
```

Benefits:
- Support both internal integrations (high limits) and experimental usage (low limits)
- Can tier by user role (students: basic, staff: standard, admin: premium)
- Future monetization path if offering external API access

---

**Issue 14: Add Key Name/Description Field**
**File:** API Key System Design (Pre-Implementation)
**Recommendation:**
```typescript
interface ApiKey {
  // ... existing fields
  name: string; // "Production MCP Server", "Development Testing"
  description: string | null; // Optional detailed description
}
```

Benefits:
- Users can identify keys easily (especially with multiple keys)
- Audit logs more meaningful ("Production MCP Server accessed graph:write")
- Easier to rotate keys (know which integrations will break)

---

**Issue 15: Implement Key Prefix Collision Check**
**File:** API Key System Design (Pre-Implementation)
**Problem:** With only 8-character prefix, collision probability exists.
**Recommendation:**
```typescript
async function generateUniqueApiKey(): Promise<{ key: string; prefix: string }> {
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    const keyBytes = crypto.randomBytes(32); // 256 bits
    const key = 'sk-' + keyBytes.toString('hex');
    const prefix = key.slice(0, 11); // 'sk-' + 8 chars
    
    // Check for prefix collision
    const existing = await executeQuery(
      (db) => db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.prefix, prefix))
        .limit(1),
      "checkKeyPrefixCollision"
    );
    
    if (existing.length === 0) {
      return { key, prefix };
    }
    
    attempts++;
  }
  
  throw new Error('Failed to generate unique API key prefix after 10 attempts');
}
```

With 256 bits of entropy, collision is astronomically unlikely, but defensive check is good practice.

---

**Issue 16: Add Last-Used Timestamp**
**File:** API Key System Design (Pre-Implementation)
**Recommendation:**
```typescript
interface ApiKey {
  // ... existing fields
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
}

// Update on each successful authentication
async function updateKeyUsage(keyId: number, ipAddress: string): Promise<void> {
  await executeQuery(
    (db) => db
      .update(apiKeys)
      .set({ 
        lastUsedAt: new Date(),
        lastUsedIp: ipAddress
      })
      .where(eq(apiKeys.id, keyId)),
    "updateKeyUsage"
  );
}
```

Benefits:
- Identify stale/unused keys
- Security monitoring (IP change detection)
- Inform rotation decisions

---

**Issue 17: Scope Documentation & Examples**
**File:** API Key System Design (Pre-Implementation)
**Recommendation:** Create comprehensive scope documentation at `/docs/api/scopes.md`:

```markdown
# API Scopes Reference

## Scope Format
`<resource>:<action>[:<identifier>]`

## Available Scopes

### Graph Operations
- `graph:read` - Read context graph nodes and edges
- `graph:write` - Create/update graph nodes and edges
- `graph:delete` - Delete graph nodes and edges

### Assistant Operations
- `assistants:read` - List and view assistants
- `assistants:execute` - Execute assistant workflows
- `assistants:*` - All assistant operations

### Conversation Operations
- `conversations:read` - View conversation history
- `conversations:write` - Create and update conversations
- `conversations:delete` - Delete conversations
- `conversations:*` - All conversation operations

### Admin Operations (Administrators only)
- `admin:users:read` - View user list
- `admin:users:write` - Modify user roles
- `admin:settings:read` - View system settings
- `admin:settings:write` - Modify system settings

## Scope Combinations

### Read-Only Integration
```json
{
  "scopes": ["graph:read", "assistants:read", "conversations:read"]
}
```

### Full Assistant Executor
```json
{
  "scopes": ["assistants:*", "conversations:*"]
}
```

### Admin Management
```json
{
  "scopes": ["admin:users:read", "admin:users:write"]
}
```
```

---

**Issue 18: Consider CORS for Future Web Integrations**
**File:** API Key System Design (Pre-Implementation)
**Current:** "No CORS (server-to-server only)"
**Recommendation:** While server-to-server is correct for Phase 1, prepare for future web integrations:

```typescript
// Future: Allowlist Origins for specific keys
interface ApiKey {
  // ... existing fields
  allowedOrigins: string[] | null; // CORS allowlist
  corsEnabled: boolean; // Default false
}

// CORS middleware (disabled by default)
async function handleCorsIfEnabled(
  request: Request,
  key: ApiKey
): Promise<Response | null> {
  if (!key.corsEnabled) {
    return null; // Skip CORS
  }
  
  const origin = request.headers.get('Origin');
  if (!origin) {
    return null; // Not a CORS request
  }
  
  const isAllowed = key.allowedOrigins?.includes(origin) || false;
  
  if (request.method === 'OPTIONS') {
    // Preflight request
    return new Response(null, {
      status: isAllowed ? 204 : 403,
      headers: isAllowed ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400'
      } : {}
    });
  }
  
  // Add CORS headers to response (handled by middleware)
  return null;
}
```

**Warning:** Exposing API keys in browser JavaScript is dangerous. Recommend OAuth 2.0 PKCE flow for web clients.

---

### POSITIVE_PRACTICES

1. **Admin-Only Initial Access** - Restricting API key creation to administrators initially is a good security posture. Prevents privilege escalation by limiting attack surface.

2. **Prefix Storage for Display** - Storing first 8 characters for UI display (`sk-a1b2c3d4****`) is good UX without compromising security.

3. **Show-Once Pattern** - Only displaying full key at creation (never retrievable) follows industry best practice (GitHub, AWS, Stripe all do this).

4. **Revocation with Timestamp** - Using `revoked_at` timestamp allows audit trail of when keys were revoked. Good for compliance.

5. **Server-to-Server Only (Phase 1)** - Avoiding CORS and browser exposure initially reduces attack surface significantly. API keys should never be in client-side code.

---

### K-12 COMPLIANCE CONSIDERATIONS

**FERPA (Family Educational Rights and Privacy Act):**
1. **Audit Requirement**: All access to student records must be logged - implement audit logging (Issue #6)
2. **Record Retention**: Keep audit logs for minimum 1 year
3. **Access Control**: API keys that access student data must be traceable to individual users
4. **Breach Notification**: Must notify parents/students within reasonable timeframe if API key is compromised

**Recommendations:**
```typescript
// Tag API keys that can access student PII
interface ApiKey {
  // ... existing fields
  canAccessStudentPII: boolean; // Requires additional approval
  dataClassification: 'public' | 'internal' | 'confidential' | 'student_pii';
}

// Require additional approval workflow for student PII access
async function requestPiiAccessKey(
  userId: number,
  justification: string
): Promise<{ requestId: number }> {
  // Create approval request
  const request = await executeQuery(
    (db) => db.insert(apiKeyApprovalRequests).values({
      requesterId: userId,
      dataClassification: 'student_pii',
      justification,
      status: 'pending',
      createdAt: new Date()
    }).returning({ id: apiKeyApprovalRequests.id }),
    "createPiiAccessRequest"
  );
  
  // Notify administrators
  await notifyAdmins('API key with student PII access requested', {
    requestId: request[0].id,
    requester: userId
  });
  
  return { requestId: request[0].id };
}
```

**COPPA (Children's Online Privacy Protection Act):**
- If students under 13 use the system, API keys MUST NOT allow external services to collect personal information without parental consent
- Implement data sharing agreements for any external integrations
- Require parental consent workflow for keys that export student data

**Recommendation:**
- Create "Data Sharing Agreement" requirement for API keys
- Administrators must upload signed agreement before activating PII-access keys
- Audit log all data exports with PII classification

---

### REQUIRED_ACTIONS

**Before Implementation:**
1. ✅ Replace SHA-256 with Argon2id or bcrypt for key hashing (Critical Issue #1)
2. ✅ Increase key entropy to 256 bits (Critical Issue #2)
3. ✅ Implement race-condition-safe rate limiting (Critical Issue #3)
4. ✅ Replace wildcard session scopes with role-based explicit scopes (Critical Issue #4)

**Phase 1 (MVP):**
5. ✅ Implement key rotation policy (High Priority Issue #5)
6. ✅ Add comprehensive audit logging (High Priority Issue #6)
7. ✅ Fix scope wildcard matching logic (High Priority Issue #7)
8. ✅ Implement scope escalation prevention (High Priority Issue #10)
9. ✅ Add rate limit headers to responses (High Priority Issue #12)

**Phase 2 (Hardening):**
10. ⚠️ Add IP allowlist feature (High Priority Issue #8)
11. ⚠️ Implement request signature verification (High Priority Issue #9)
12. ⚠️ Build admin monitoring dashboard (High Priority Issue #11)
13. ⚠️ Add FERPA/COPPA compliance workflows for student PII access

**Phase 3 (OAuth2/OIDC):**
14. 📋 Design OAuth 2.0 authorization server
15. 📋 Implement PKCE flow for web clients
16. 📋 Add OpenID Connect discovery endpoint
17. 📋 Build external MCP server JWT validation

---

### ADDITIONAL SECURITY RECOMMENDATIONS

**Database Schema:**
```sql
-- Add these constraints
CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  key_hash VARCHAR(255) NOT NULL UNIQUE, -- Argon2 hash
  prefix VARCHAR(11) NOT NULL, -- 'sk-' + 8 chars
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  rate_limit_tier VARCHAR(50) NOT NULL DEFAULT 'standard',
  allowed_ips JSONB, -- ["192.168.1.1", "10.0.0.0/8"]
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES users(id),
  revoked_reason VARCHAR(255),
  last_used_at TIMESTAMPTZ,
  last_used_ip VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  max_lifetime_days INTEGER NOT NULL DEFAULT 90,
  
  CONSTRAINT valid_scopes CHECK (jsonb_typeof(scopes) = 'array'),
  CONSTRAINT no_wildcard_scope CHECK (NOT scopes ? '*'),
  CONSTRAINT expiration_required_for_pii CHECK (
    (scopes ? 'admin:*') OR expires_at IS NOT NULL
  )
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX idx_api_keys_active ON api_keys(user_id) 
  WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW());
```

**Monitoring & Alerting:**
- CloudWatch alarm: API key error rate > 20% for 5 minutes
- CloudWatch alarm: New IP address for existing key
- CloudWatch alarm: 5+ failed authentication attempts in 5 minutes
- Daily report: Keys expiring within 7 days
- Weekly report: Unused keys (no usage in 30 days)

---

### PHASE 3 OAUTH2/OIDC ARCHITECTURE NOTES

**Concerns:**
1. **JWT Validation**: External MCP servers must validate JWTs - provide public key via JWKS endpoint
2. **Token Lifetime**: Access tokens should be short-lived (15 minutes), refresh tokens long-lived (30 days)
3. **Scope Consent**: Users must explicitly consent to scopes requested by third-party apps
4. **Client Registration**: Implement dynamic client registration (RFC 7591) or manual approval process

**Secure OAuth2 Implementation Checklist:**
- ✅ Use PKCE for all authorization code flows (prevents authorization code interception)
- ✅ Implement state parameter validation (CSRF protection)
- ✅ Short-lived access tokens (15 minutes max)
- ✅ Rotate refresh tokens on use
- ✅ Bind tokens to client (client_id validation)
- ✅ Implement token revocation endpoint (RFC 7009)
- ✅ Rate limit token endpoint (prevent brute force)
- ✅ Log all token issuance and revocation events

**Reference:** OAuth 2.0 for Browser-Based Apps: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps

---

## SUMMARY OF FINDINGS

This API platform architecture has several **critical security vulnerabilities** that must be addressed before implementation:

**Most Critical:**
1. **Weak key hashing** - SHA-256 is not suitable for credentials
2. **Race conditions in rate limiting** - PostgreSQL sliding window can be bypassed
3. **Overly permissive session scopes** - Wildcard scopes violate least privilege
4. **Missing audit logging** - Required for FERPA compliance

**K-12 Specific Concerns:**
- No mechanisms for FERPA-compliant access logging
- No approval workflow for student PII access
- No data classification system
- Missing breach notification procedures

**Positive Aspects:**
- Admin-only initial access is good security posture
- Show-once key pattern follows industry best practices
- Server-to-server design avoids browser exposure risks

**Recommendation:** Implement all Critical and High Priority fixes before launching Phase 1. The architecture is fundamentally sound but requires security hardening, especially for a K-12 environment where student privacy is paramount.