# Architecture Design Synthesis (from Architect Agent)

Excellent output. Here's the synthesis of the architecture design:

## API Platform Architecture — Key Decisions

### 1. Opaque API keys now, JWT later
- Phase 1: Simple hashed API keys stored in PostgreSQL. `Authorization: Bearer sk-xxxxx`
- When you need AI Studio to be an auth provider for external MCP servers (Phase 3), you add a `/oauth/token` endpoint that reads the **same key/scope data** and mints JWTs
- Nothing in the Phase 1 design blocks this path

### 2. Hierarchical scope strings
- Simple now: `graph:read`, `graph:write`
- Extends naturally: `assistant:42:execute` (specific assistant), `mcp:search_decisions` (specific MCP tool)
- Wildcards: `assistants:*` grants access to all assistants
- Stored as a JSONB string array — no join tables, no schema changes to add new scopes

### 3. SHA-256 key hashing (not argon2)
The architect recommends SHA-256 for API keys (fast, single indexed lookup per request) vs. argon2 (which I had in the original issues for password-style hashing). This is the right call — API keys are high-entropy random strings, not human-chosen passwords. Bcrypt/argon2 would add unnecessary latency on every API request.

### 4. Usage tracking table for rate limiting + analytics
A new `api_key_usage` table tracks every API call per key. This does double duty:
- Rate limiting via sliding window queries
- Cost attribution and analytics (which key is making how many calls to which endpoints)
- No Redis dependency — PostgreSQL handles this fine at expected scale

### 5. Three-phase roadmap
- **Phase 1 (now):** Keys, middleware, graph REST API, user settings
- **Phase 2 (when needed):** Assistant execution via API, streaming
- **Phase 3 (when needed):** MCP server, OAuth2 provider, JWT issuance

### Unresolved questions the architect raised:

1. All users get keys, or admin-only initially? *(We already decided: all users)*
2. Max keys per user? *(Suggest 10)*
3. Default expiration — force rotation or allow no-expiration?
4. Should graph API access require admin role, or introduce a new concept?
5. CORS policy — allow cross-origin, or server-to-server only?
6. Audit trail beyond usage table for key creation/revocation events?