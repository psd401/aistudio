# Capabilities vs. Scopes

AI Studio has **two separate authorization systems**. They look similar (both
gate access by string identifier) but serve different audiences, have different
lifecycles, and must never be collapsed into one. This document explains the
split, when to use each, and the anti-patterns that re-collapse them.

> **TL;DR**
> - **Capability** — gates a UI feature for a logged-in human. Checked with
>   `hasCapabilityAccess(identifier)`. Backed by `capabilities` /
>   `role_capabilities`.
> - **Scope** — gates a programmatic API/MCP call made with an API key. Checked
>   with `requireScope(auth, scope)`. Backed by `api_keys.scopes`.

---

## Capabilities — role-gated UI features

A **capability** is a role-gated product surface inside the web app: Nexus
access, Assistant Architect access, Knowledge Repositories, admin pages, etc.
The name "capability" replaced the older, misleading `tools` table (Epic #922) —
these are feature flags tied to a user's roles, not invocable tools.

- **Function:** `hasCapabilityAccess(identifier)` (server-action layer,
  `utils/roles.ts`) and `hasCapabilityAccess(cognitoSub, identifier)` (DB layer,
  `lib/db/drizzle/capabilities.ts`).
- **Storage:** `capabilities` (the registry) + `role_capabilities` (role grants).
- **Audience:** a human authenticated via Cognito/NextAuth, clicking around the
  UI.
- **Enforcement points:** route-group layouts (`app/(protected)/**/layout.tsx`),
  server actions, and the internal navigation API (which hides nav items the
  user has no capability for).
- **Registry of identifiers:** code-managed capabilities live in
  `lib/capabilities/manifest.ts` (the boot-time sync reconciles the DB to match);
  admins can also create `source: 'manual'` capabilities in the Role Management
  admin UI.

Current capability identifiers (from the manifest):

| Identifier | Gates |
|---|---|
| `assistant-architect` | Assistant Architect build/schedule/execute UI |
| `model-compare` | Model Compare feature |
| `knowledge-repositories` | Knowledge Repositories + Prompt Library |
| `decision-capture` | Nexus Decision Capture |
| `voice-mode` | Nexus voice conversations |
| `internal-performance-monitoring` | Internal performance dashboards |
| `internal-system-administration` | Internal system admin tooling |

> **Naming caution:** there is an unrelated `hasCapability()` in
> `lib/ai/capability-utils.ts`. That checks **AI-model feature flags** (image
> generation, web search, reasoning) on a model record — it has nothing to do
> with user authorization. Do not confuse the two; use `hasCapabilityAccess`
> for role-gated access.

---

## Scopes — permissions on a programmatic invocation surface

A **scope** is a permission attached to an **API key**, governing what an
external/programmatic caller can do through the REST API (`/api/v1/`) and MCP.

- **Function:** `requireScope(auth, scope)` (`lib/api/auth-middleware.ts`).
  Returns a 403 `NextResponse` when the scope is missing, or `null` when allowed.
  Session (cookie) callers carry `scopes: ["*"]` and always pass — scopes only
  constrain API-key callers.
- **Storage:** `api_keys.scopes` (a JSON array on each key). The set of valid
  scope strings and the role → scope mapping live in `lib/api-keys/scopes.ts`.
- **Audience:** a script, integration, or MCP client authenticating with an API
  key.
- **Enforcement points:** `/api/v1/*` route handlers and MCP tool handlers,
  via the `withApiAuth` middleware + `requireScope`.

Example scope identifiers (from `API_SCOPES`):
`chat:read`, `chat:write`, `assistants:execute`, `assistants:list`,
`graph:read`, `graph:write`, `mcp:capture_decision`, `mcp:list_assistants`.

---

## Why they are deliberately separate

| Dimension | Capabilities | Scopes |
|---|---|---|
| **Audience** | Human in the UI | API key / programmatic client |
| **Granted via** | Role assignment (`role_capabilities`) | Per-key selection, bounded by the key owner's roles |
| **Checked by** | `hasCapabilityAccess(identifier)` | `requireScope(auth, scope)` |
| **Backing store** | `capabilities` / `role_capabilities` | `api_keys.scopes` (JSON) |
| **Identifier style** | feature slug (`assistant-architect`) | `resource:action` (`assistants:execute`) |
| **Lifecycle** | follows a user's roles; changes when roles change | follows an API key; revoked when the key is rotated/deleted |
| **Audit need** | "which humans can see feature X" | "what can this key/integration do" |

Collapsing them would force a single identifier namespace to serve two
audiences with different revocation models and different blast radii. A leaked
API key must be containable by revoking *the key* without touching any human's
UI access; conversely, removing a user's UI capability must not silently widen
or narrow what any API key can call.

---

## Decision tree — which one do I add?

```
Adding a new gated thing?
│
├─ Is it a screen / feature a logged-in human uses in the web UI?
│  (a page, a nav item, an admin tool, a server action behind the UI)
│        └─► CAPABILITY
│            1. Add an entry to lib/capabilities/manifest.ts
│            2. Gate it with hasCapabilityAccess("<identifier>")
│               in the layout / server action.
│            3. (Optional) point a navigation_items.capability_id at it.
│
└─ Is it an endpoint a script / integration / MCP client calls with an API key?
   (a /api/v1/* route, an MCP tool)
         └─► SCOPE
             1. Add the scope string to API_SCOPES in lib/api-keys/scopes.ts
                and to the appropriate ROLE_SCOPES entries.
             2. Gate the handler with requireScope(auth, "<resource:action>").
```

If a feature has **both** a UI surface and an API surface, it gets **both** a
capability (for the UI) and a scope (for the API) — two identifiers, one per
audience. They are not shared.

---

## Anti-patterns (do not do these)

1. **Do not gate an API/MCP endpoint with `hasCapabilityAccess()`.**
   API-key callers have no UI session and no role-capability grants in the sense
   the UI expects; capability checks are for humans. Use `requireScope`.

2. **Do not gate a UI feature with `requireScope()`.**
   Layout guards and server actions run in a cookie session
   (`scopes: ["*"]`), so a scope check would pass unconditionally and enforce
   nothing. Use `hasCapabilityAccess`.

3. **Do not share an identifier across the two systems.**
   A capability `assistant-architect` and a scope `assistants:execute` are
   intentionally different strings. Never reuse one identifier for both — it
   couples two independent lifecycles and makes audits ambiguous.

4. **Do not reintroduce a `tools` / `role_tools` table or `hasToolAccess()`.**
   That was the legacy name for capabilities; it was renamed (Epic #922) and the
   tables were dropped (Issue #928, migration 084) specifically to make the
   capability-vs-scope boundary explicit.

5. **Do not confuse `hasCapabilityAccess` with `hasCapability`.**
   `hasCapabilityAccess` (this doc) is user authorization.
   `hasCapability(model.capabilities, ...)` in `lib/ai/capability-utils.ts` is an
   AI-model feature check. Different concern entirely.

---

## References

- Capabilities (UI access):
  - `utils/roles.ts` — `hasCapabilityAccess(identifier)`, `getUserCapabilities()`
  - `lib/db/drizzle/capabilities.ts` — DB-layer accessors
  - `lib/capabilities/manifest.ts` — code-managed capability registry
  - `lib/db/schema/tables/{capabilities,role-capabilities}.ts`
- Scopes (API access):
  - `lib/api-keys/scopes.ts` — `API_SCOPES`, `ROLE_SCOPES`, `getScopesForRoles`
  - `lib/api/auth-middleware.ts` — `requireScope`, `requireAssistantScope`
- History: Epic #922 (Unify Agent Platform), migration 079 (rename), Issue #928
  / migration 084 (drop legacy tables).
