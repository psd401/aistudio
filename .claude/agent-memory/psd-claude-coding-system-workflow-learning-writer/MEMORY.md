# Learning Writer Agent Memory

## Confirmed Project Conventions

- `docs/learnings/{category}/{date}-{slug}.md` is the learning file structure
- Categories written so far: security, aws, devops, database, tooling, streaming, architecture, ai-sdk, implementation-patterns, ux-patterns, react-patterns
- Category directories are created implicitly by the Write tool (no mkdir needed)

## Key Project Facts (relevant for dedup / tagging)

- **ECS NODE_ENV**: ECS task definitions set `NODE_ENV=production` for ALL environments. Use `ENVIRONMENT` env var for deployment-tier branching. (Filed: aws/2026-02-18-ecs-node-env-vs-environment.md)
- **DEK cache promise ref**: `.finally` cleanup on shared in-flight promise must gate on reference identity to avoid clobbering newer fetches. (Filed: security/2026-02-18-dek-cache-promise-reference-clobber.md)
- **Bedrock guardrail limits**: CLASSIC tier topic definitions max 200 chars; at least one content filter must be non-NONE. (from project MEMORY.md)
- **SELECT FOR UPDATE read-only phases**: Row locks released when transaction commits. Read-only phases don't need locks; use optimistic concurrency (WHERE updated_at = previous_value) in write phase. (Filed: database/2026-02-19-select-for-update-read-only-phases.md)
- **OAuth callback HTML XSS/upsert**: Three XSS vectors in HTML-rendering endpoints (query params, embedded JSON in script tags, security headers). Token upsert must be atomic (INSERT ... ON CONFLICT DO UPDATE). assertUserAccess required on connector routes. postMessage: JSON.stringify exactly once. (Filed: security/2026-02-19-oauth-callback-xss-upsert-headers.md)
- **OAuth popup flow checklist**: Per-resource cookie names (`oauth_state_${serverId}`) prevent concurrent popup collisions. CSP `default-src 'none'; script-src 'unsafe-inline'` required on inline-script HTML pages. State parameter can carry routing metadata (serverId prefix). Zod for all external token response parsing. CodeQL `js/user-controlled-bypass` on null/presence guards is always a false positive — dismiss. (Filed: security/2026-02-19-oauth-popup-flow-checklist.md)
- **MCP client cleanup**: `onFinish` only fires on success — MCP clients (and any async resources) must be released in `try/finally` around stream execution, not in success-only callbacks. (Filed: streaming/2026-02-19-mcp-client-cleanup-try-finally.md)
- **Streaming partial failure feedback**: `Promise.allSettled` graceful degradation must surface rejected items to the client (e.g., via response header `X-Connector-Reconnect`) — silent degradation leaves users with missing features and no diagnosis path. (Filed: ux-patterns/2026-02-19-streaming-partial-failure-feedback.md)
- **Lazy useState for error-driven initial UI**: Use `useState(() => compute(prop))` when correct initial state depends on a prop/parse result. `useEffect` correction causes a visible flash. (Filed: react-patterns/2026-02-19-usestate-lazy-init-for-error-state.md)
- **Derived-state toggle must invert displayed value**: With `null|boolean` override state, toggle must compute `!(prev !== null ? prev : derivedValue)` — not `prev === null ? true : !prev`. The latter skips inverting the auto-expanded state on first click. (Filed: react-patterns/2026-02-19-derived-state-toggle-must-invert-displayed-value.md)

## Dedup Search Strategy

- Run Grep with key technical terms from KEY_INSIGHT before writing
- Check both file content and filenames
- If partial overlap exists, note it in the confirmation but still write if the specific mechanism is new
