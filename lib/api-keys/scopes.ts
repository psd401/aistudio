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
  "documents:read": "Read documents and attachments",
  "documents:write": "Upload and manage documents",
  "graph:read": "Read context graph nodes and edges",
  "graph:write": "Create, update, and delete graph nodes and edges",
  "mcp:search_decisions": "Search decision graph nodes via MCP",
  "mcp:capture_decision": "Create decision graph nodes and edges via MCP",
  "mcp:execute_assistant": "Execute an assistant via MCP",
  "mcp:list_assistants": "List available assistants via MCP",
  "mcp:get_decision_graph": "Get decision node details and connections via MCP",
  // Atrium content scopes (Phase 5 — REST/MCP write surfaces, Issue #1059)
  "content:create": "Create Atrium content objects and initial versions",
  "content:update": "Update Atrium content object metadata and create new versions",
  "content:publish_internal": "Publish Atrium content to internal destinations",
  "content:publish_public": "Publish Atrium content publicly",
} as const;

export type ApiScope = keyof typeof API_SCOPES;

// ============================================
// Role-Scope Mapping
// ============================================

const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[];

export const ROLE_SCOPES: Record<string, ApiScope[]> = {
  student: ["chat:read", "chat:write"],
  staff: [
    "chat:read",
    "chat:write",
    "assistants:read",
    "assistants:list",
    "assistants:execute",
    "models:read",
    "tools:read",
    "documents:read",
    "graph:read",
    "mcp:search_decisions",
    "mcp:list_assistants",
    "mcp:get_decision_graph",
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
