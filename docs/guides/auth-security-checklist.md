# OAuth & Auth Security Checklist

Review checklist for any PR that modifies OAuth flows, auth callbacks, or token handling.
Consolidated from 6 security learnings (2026-02-18 through 2026-02-20).

> **Scope:** Primarily covers MCP OAuth flows (items marked with MCP-specific helpers like `rejectUnsafeMcpUrl()`, `getOAuthStateCookieName()`, `requireUserAccess()`). For non-MCP auth changes, apply the general sections (XSS vectors, SSRF patterns, token storage, CodeQL triage) and skip MCP-specific items.

## Callback Handler Order

- [ ] State cookie CSRF validation runs before any non-static behavior (using user-controlled `errorParam`, `code`, or similar params)
- [ ] CodeQL `js/user-controlled-bypass` on OAuth callback: **inspect handler order before dismissing** — may be a real vulnerability

## Cookie & State Management

- [ ] Cookie name includes resource ID: `mcp_oauth_state_${serverId}` (via `getOAuthStateCookieName()`) — prevents concurrent popup collisions
- [ ] State parameter carries routing metadata: `${serverId}:${cryptoRandomToken}` — validate UUID before DB use
- [ ] State comparison is timing-safe (encrypted cookie enables this without DB round-trip)

## HTML Callback Pages (XSS Surface)

Three vectors to check on any HTML-rendering endpoint:

- [ ] Provider query params escaped before HTML interpolation (`encodeURIComponent`, never raw)
- [ ] JSON in `<script>` tags: escape `<` as `\u003c` to prevent `</script>` injection
- [ ] `JSON.stringify(payload)` called exactly **once** — double-stringify silently breaks receiver
- [ ] CSP header uses SHA-256 hash of inline script content — never `'unsafe-inline'`
- [ ] Security headers present: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`
- [ ] Tainted data separated from script content (use `<script type="application/json">` data block + static script)

## URL Validation

- [ ] All OAuth redirect URLs and token endpoints validated against SSRF patterns via `rejectUnsafeMcpUrl()` (`@/lib/mcp/connector-service`)
- [ ] **Even admin-configured URLs from Secrets Manager need validation** — trusted source does not mean safe content

## Token Storage

- [ ] Token upsert uses `INSERT ... ON CONFLICT DO UPDATE` — never check-then-insert (race condition)
- [ ] Authorization gate: `requireUserAccess(server, userId, userRoleNames)` called before any data operation (`@/lib/mcp/connector-service`)

## External API Responses

- [ ] Provider token response parsed with Zod schema — never `as TokenResponse` type assertion
- [ ] Error responses from provider handled gracefully (not reflected raw into HTML)

## Promise & Cache Patterns (DEK/Encryption)

- [ ] Shared in-flight promise cleanup uses reference identity check: `if (inFlight === fetch) inFlight = null`
- [ ] Cache invalidation uses generation counter to prevent stale-result repopulation

## CodeQL Triage

- [ ] `js/user-controlled-bypass` on null/presence guards: likely false positive — requires investigation + second reviewer approval before dismissing
- [ ] `js/user-controlled-bypass` on OAuth callback branches: **likely real** — fix handler order
- [ ] `js/insufficiently-hashed-password`: restructure to remove tainted data from sink path (renames/wrappers don't work)
- [ ] Unlike ESLint, CodeQL does not support inline suppression — dismiss via `gh api repos/:owner/:repo/code-scanning/alerts/{N} -X PATCH -f state=dismissed -f dismissed_reason="false positive" -f dismissed_comment="Investigated: <explanation under 280 chars>"` (requires second reviewer approval)

---

> **Staleness warning:** This checklist references specific internal function names and signatures (`rejectUnsafeMcpUrl`, `requireUserAccess`, `getOAuthStateCookieName`). These may be renamed over time — verify against actual source in `lib/mcp/connector-service.ts` before flagging a PR for non-compliance.

*Source learnings: `docs/learnings/security/2026-02-18-dek-cache-promise-reference-clobber.md` through `2026-02-20-codeql-taint-break-static-data-block.md`*
