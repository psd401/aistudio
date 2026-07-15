# Capabilities vs. Scopes vs. Resource Grants

AI Studio has **three separate authorization axes**. They look similar (all gate
access by string identifier) but serve different audiences, have different
lifecycles, and must never be collapsed into one. This document explains the
split, when to use each, and the anti-patterns that re-collapse them.

> **TL;DR**
> - **Capability** — gates a UI feature for a logged-in human. Checked with
>   `hasCapabilityAccess(identifier)`. Backed by `capabilities` /
>   `role_capabilities`.
> - **Scope** — gates a programmatic API/MCP call made with an API key. Checked
>   with `requireScope(auth, scope)`. Backed by `api_keys.scopes`.
> - **Resource grant** — gates access to a specific **resource instance** (an AI
>   model, an Assistant Architect assistant, an agent skill) by role **or** by a
>   synced Google group. Checked with `userCanAccessResource(...)` /
>   `filterAccessibleResourceIds(...)`. Backed by `resource_access_grants`.

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
| `atrium-content` | Atrium content workspace (documents, artifacts, collections) |
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

## Resource grants — per-instance access by role or group

A **resource grant** gates access to one specific **resource instance** — an AI
model, an Assistant Architect assistant, or an agent skill — for a human. It is the
third axis, added in Epic #1202 (Phase 3, #1206): where a Capability answers "may
this user reach the Assistant Architect *feature*", a resource grant answers "may
this user run *this particular assistant*".

- **Function:** `userCanAccessResource(userId, resourceType, resourceId)` and the
  batch `filterAccessibleResourceIds(userId, resourceType, ids)`
  (`lib/db/drizzle/resource-access.ts`). Both are pure-SQL gates.
- **Storage:** `resource_access_grants` — one row per
  `(resource_type, resource_id, grant_kind, grant_value)` (migration 111).
- **Audience:** a human authenticated via Cognito, resolving/executing a specific
  model / assistant / skill.
- **Enforcement points:** the execution/resolution paths (model resolution,
  `GET /api/models` list filtering, assistant execute, skill invocation) — the
  server is authoritative; UI filtering is advisory only.
- **Grant kinds** (`grant_kind`):
  - `role` → `grant_value` is a role **name** (matched case-insensitively against
    the user's roles).
  - `group` → `grant_value` is a synced Google group **email**, lowercased (matched
    against the user's transitive membership of an **active** synced group — see
    [google-group-sync.md](../features/google-group-sync.md)). This is how Google
    group membership feeds per-resource access.

**Semantics (memorize these — they mirror the retired `ai_models.allowed_roles`
contract exactly):**

- **Zero** grant rows for a resource = **unrestricted** (everyone may access).
- **Any** matching grant row = allowed.
- **Administrators always pass**, regardless of grants.

> **History:** models used to carry a legacy `ai_models.allowed_roles` JSON column.
> Phase 3 (#1206) backfilled it into `resource_access_grants` and moved all read
> paths onto the grant table; Phase 4 (#1207) dropped the column and the client-side
> role filter. There is no `allowed_roles` anymore — edit model/assistant/skill
> access through the resource-grants editor, which writes `resource_access_grants`.

---

## Why they are deliberately separate

| Dimension | Capabilities | Scopes | Resource grants |
|---|---|---|---|
| **Audience** | Human in the UI | API key / programmatic client | Human, per resource instance |
| **Gates** | a UI **feature** | a programmatic **endpoint** | a specific **model/assistant/skill** |
| **Granted via** | Role assignment (`role_capabilities`) | Per-key selection, bounded by the key owner's roles | Per-resource `role`/`group` grant rows |
| **Checked by** | `hasCapabilityAccess(identifier)` | `requireScope(auth, scope)` | `userCanAccessResource(...)` / `filterAccessibleResourceIds(...)` |
| **Backing store** | `capabilities` / `role_capabilities` | `api_keys.scopes` (JSON) | `resource_access_grants` |
| **Identifier style** | feature slug (`assistant-architect`) | `resource:action` (`assistants:execute`) | `(resource_type, resource_id)` + role name / group email |
| **Default when unset** | no access without a role grant | no access without the scope | **unrestricted** (zero rows = everyone) |
| **Lifecycle** | follows a user's roles | follows an API key | follows the resource + its grant rows (and, for `group` grants, live sync membership) |
| **Audit need** | "which humans can see feature X" | "what can this key/integration do" | "who can use this specific model/assistant/skill" |

Collapsing them would force a single identifier namespace to serve different
audiences with different revocation models and different blast radii. A leaked
API key must be containable by revoking *the key* without touching any human's UI
access; removing a user's UI capability must not silently widen or narrow what any
API key can call; and restricting one model must not change feature-level access or
any API scope. Note the **inverted default**: an ungranted Capability/Scope denies,
but a resource with **no** grants is unrestricted (matching the model-access contract
that predated the table).

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
├─ Is it an endpoint a script / integration / MCP client calls with an API key?
│  (a /api/v1/* route, an MCP tool)
│        └─► SCOPE
│            1. Add the scope string to API_SCOPES in lib/api-keys/scopes.ts
│               and to the appropriate ROLE_SCOPES entries.
│            2. Gate the handler with requireScope(auth, "<resource:action>").
│
└─ Is it access to ONE specific model / assistant / skill instance, by role or
   by Google group?
         └─► RESOURCE GRANT
             1. Nothing to register — grants are data. In the resource's admin
                editor add role/group grants (writes resource_access_grants).
             2. Gate the execution/resolution path with
                userCanAccessResource(...) / filterAccessibleResourceIds(...).
             3. Remember: zero grant rows = unrestricted; admins always pass.
```

If a feature has **both** a UI surface and an API surface, it gets **both** a
capability (for the UI) and a scope (for the API) — two identifiers, one per
audience. They are not shared. A per-instance restriction on top (e.g. "only staff
may run *this* model") is a resource grant, independent of both.

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
- Resource grants (per-instance access):
  - `lib/db/drizzle/resource-access.ts` — `userCanAccessResource`,
    `filterAccessibleResourceIds`, `replaceResourceGrants`, `listResourceGrants`
  - `lib/db/schema/tables/resource-access-grants.ts` — the grant table
  - `components/features/resource-grants/` — the admin grants editor
  - Google group membership: [features/google-group-sync.md](../features/google-group-sync.md)
- History: Epic #922 (Unify Agent Platform), migration 079 (rename), Issue #928
  / migration 084 (drop legacy tables). Resource grants: Epic #1202 Phase 3 (#1206,
  migration 111); `ai_models.allowed_roles` dropped in Phase 4 (#1207, migration 113).
