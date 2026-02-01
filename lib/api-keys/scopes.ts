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
  "models:read": "List available AI models",
  "documents:read": "Read documents and attachments",
  "documents:write": "Upload and manage documents",
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
    "models:read",
    "documents:read",
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
