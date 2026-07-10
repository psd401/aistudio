/**
 * API Scope Definitions & Role-Scope Mapping
 * Part of Epic #674 (External API Platform) - Issue #678
 *
 * Single source of truth for available API scopes and which roles
 * can use which scopes. Used by both the settings UI (to filter
 * scope checkboxes) and server actions (to validate scope requests).
 */

// ============================================
// Scope Definitions
// ============================================

export const API_SCOPES = {
  "chat:read": "Read chat conversations",
  "chat:write": "Create and send chat messages",
  "assistants:read": "List and view assistant architects",
  "assistants:write": "Create and modify assistant architects",
  "assistants:list": "List assistants available for API execution",
  "assistants:execute": "Execute any assistant via API",
  "models:read": "List available AI models",
  "tools:read": "List and view tool catalog entries and their versions",
  // Platform capability catalog (Issue #1100). A low-sensitivity read scope over
  // non-sensitive PRODUCT METADATA — the live projection of AI Studio's own
  // registries (invocable actions, role-gated UI features, and the scope
  // reference). Granted broadly (student/staff/administrator) so any authenticated
  // caller — including the OpenClaw agent holding a scoped key — can discover what
  // the platform can do via the `describe_capabilities` MCP meta-tool. It exposes
  // no user data, only the shape of the app.
  "platform:read": "Read the AI Studio capability catalog (actions, features, scopes)",
  "documents:read": "Read documents and attachments",
  "documents:write": "Upload and manage documents",
  "graph:read": "Read context graph nodes and edges",
  "graph:write": "Create, update, and delete graph nodes and edges",
  "mcp:search_decisions": "Search decision graph nodes via MCP",
  "mcp:capture_decision": "Create decision graph nodes and edges via MCP",
  "mcp:execute_assistant": "Execute an assistant via MCP",
  "mcp:list_assistants": "List available assistants via MCP",
  "mcp:get_decision_graph": "Get decision node details and connections via MCP",
  // Atrium content scopes (Phase 5 — REST/MCP surfaces, Issue #1059).
  // `content:read` is reserved now so the Phase 5 read endpoints
  // (`GET /api/v1/content/:id`, MCP fetch) have a scope to gate agent
  // read-access on without a scope-definition change landing alongside them.
  // Users hold no content scopes — their reads are capability-gated.
  "content:read": "Read Atrium content objects and versions",
  "content:create": "Create Atrium content objects and initial versions",
  "content:update": "Update Atrium content object metadata and create new versions",
  "content:publish_internal": "Publish Atrium content to internal destinations",
  "content:publish_public": "Publish Atrium content publicly",
  // Agent-held AUTHORITY scope (Atrium §26.1, #1059): permits an autonomous agent
  // to mint a short-lived delegated token acting on behalf of a user
  // (`POST /api/v1/agents/delegated-token`). It is NOT a content DATA operation and
  // is deliberately excluded from every minted delegated token (see
  // `lib/oauth/delegated-token.ts`), so a delegated credential can never re-mint.
  // Granted to agent identities via their `agent_identities.scopes`; a human who
  // inherits it (administrator gets ALL_SCOPES) still cannot mint — the route also
  // requires a registered agent identity — and it can never appear in a delegated
  // token, so it cannot leak onto the content surface.
  "content:delegate": "Mint delegated Atrium content tokens on behalf of a user",
} as const;

export type ApiScope = keyof typeof API_SCOPES;

// ============================================
// Role-Scope Mapping
// ============================================

const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[];

export const ROLE_SCOPES: Record<string, ApiScope[]> = {
  student: ["chat:read", "chat:write", "platform:read"],
  staff: [
    "chat:read",
    "chat:write",
    "assistants:read",
    "assistants:list",
    "assistants:execute",
    "models:read",
    "tools:read",
    "platform:read",
    "documents:read",
    "graph:read",
    "mcp:search_decisions",
    "mcp:list_assistants",
    "mcp:get_decision_graph",
    // Atrium content (Phase 5, Issue #1055). Staff may mint API keys that
    // author and publish content INTERNALLY — "agents do what people can".
    // `content:publish_public` is human-/admin-held and deliberately withheld.
    "content:read",
    "content:create",
    "content:update",
    "content:publish_internal",
  ],
  administrator: ALL_SCOPES,
};

/**
 * Get the union of scopes available for a set of role names.
 * Deduplicates automatically.
 */
export function getScopesForRoles(roleNames: string[]): ApiScope[] {
  const scopeSet = new Set<ApiScope>();
  for (const role of roleNames) {
    const scopes = ROLE_SCOPES[role];
    if (scopes) {
      for (const scope of scopes) {
        scopeSet.add(scope);
      }
    }
  }
  return [...scopeSet];
}
