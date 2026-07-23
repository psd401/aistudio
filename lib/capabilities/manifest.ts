/**
 * Capability Manifest
 *
 * Issue #923 (Epic #922) — single source of truth for code-managed capabilities.
 *
 * A "capability" is a role-gated UI feature (Nexus access, Assistant Architect
 * access, admin pages, etc.) checked via `hasCapabilityAccess()`.
 * Historically each capability was registered by a
 * hand-written SQL migration. This manifest replaces that: add an entry here,
 * restart the server, and the boot-time sync (lib/capabilities/sync.ts) registers
 * it in the `capabilities` table with `source = 'code'`. No SQL migration needed.
 *
 * ## Format decision (open question resolved for the epic)
 *
 * A single typed TypeScript array (this file) was chosen over convention-based
 * discovery or route-file decorators because:
 *   - It is the simplest to reason about and review (one place, fully typed).
 *   - The dataset is tiny (a handful of feature gates), so discovery machinery
 *     would be over-engineering.
 *   - It is trivially testable and deterministic — the sync just reads this array.
 *
 * ## Rules
 *
 * - `identifier` is the stable string ID used by `hasCapabilityAccess(identifier)`.
 *   Never change an identifier once shipped (it would orphan existing grants).
 * - `name` / `description` are managed here; for `source = 'code'` rows they are
 *   read-only in the admin UI (only role assignment is editable).
 * - `defaultRoles` are applied ONLY when a capability is first inserted. On
 *   subsequent syncs the manifest never re-grants or revokes roles — admins own
 *   role assignment after the initial seed.
 * - Removing an entry here does NOT hard-delete the row; the sync marks it
 *   `is_active = false`, preserving role-grant history (re-adding re-activates it).
 *
 * Capabilities created through the admin UI use `source = 'manual'` and are NOT
 * listed here; the sync leaves manual capabilities untouched.
 */

import type { CapabilitySource } from "@/lib/db/schema";

/** A single code-managed capability entry. */
export interface CapabilityManifestEntry {
  /** Stable string ID checked by hasCapabilityAccess(). Immutable once shipped. */
  identifier: string;
  /** Human-readable name (managed here; read-only in admin UI). */
  name: string;
  /** Description shown in the admin UI (managed here; read-only). */
  description: string;
  /**
   * Role names granted access when this capability is FIRST inserted.
   * Ignored on subsequent syncs. Unknown role names are skipped (logged).
   */
  defaultRoles?: string[];
}

/** Source value applied to every manifest-managed capability row. */
export const MANIFEST_SOURCE: CapabilitySource = "code";

/**
 * The code-managed capability catalog.
 *
 * These identifiers are referenced by static `hasCapabilityAccess(...)` call sites
 * across the app (route layouts, API routes, server actions). Keep this list in
 * sync with those call sites; the boot-time sync reconciles the DB to match.
 */
export const CAPABILITY_MANIFEST: readonly CapabilityManifestEntry[] = [
  {
    identifier: "assistant-architect",
    name: "Assistant Architect",
    description: "Build and schedule custom multi-step AI assistants.",
    defaultRoles: ["administrator", "staff"],
  },
  {
    identifier: "model-compare",
    name: "Model Compare",
    description: "Compare AI model responses side-by-side.",
    defaultRoles: ["administrator", "staff"],
  },
  {
    identifier: "knowledge-repositories",
    name: "Knowledge Repositories",
    description: "Manage knowledge bases and document repositories for AI assistants.",
    defaultRoles: ["administrator", "staff"],
  },
  {
    identifier: "decision-capture",
    name: "Decision Capture",
    description: "Extract and capture decisions from meeting transcripts into the context graph.",
    defaultRoles: ["administrator"],
  },
  {
    identifier: "voice-mode",
    name: "Voice Mode",
    description: "Real-time voice conversations in Nexus using AI speech providers.",
    defaultRoles: ["administrator"],
  },
  {
    identifier: "internal-performance-monitoring",
    name: "Internal Performance Monitoring",
    description: "Access internal performance monitoring dashboards and metrics.",
    defaultRoles: ["administrator"],
  },
  {
    identifier: "internal-system-administration",
    name: "Internal System Administration",
    description: "Access internal system administration tooling and diagnostics.",
    defaultRoles: ["administrator"],
  },
  {
    identifier: "atrium-content",
    name: "Atrium Content",
    description:
      "Create and version Atrium content objects (documents and artifacts).",
    defaultRoles: ["administrator", "staff"],
  },
] as const;
