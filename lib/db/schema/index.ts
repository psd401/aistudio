/**
 * Drizzle ORM Schema Definitions
 *
 * Barrel export for all Drizzle schema definitions.
 * Generated from live database introspection via MCP tools.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #528 - Generate Drizzle schema from live database
 *
 * @see https://orm.drizzle.team/docs/sql-schema-declaration
 */

// ============================================
// Enums
// ============================================
export * from "./enums";

// ============================================
// Core Tables
// ============================================
export * from "./tables/users";
export * from "./tables/roles";
export * from "./tables/user-roles";
export * from "./tables/capabilities";
export * from "./tables/role-capabilities";
export * from "./tables/tool-catalog";

// ============================================
// AI Models
// ============================================
export * from "./tables/ai-models";
export * from "./tables/ai-streaming-jobs";
export * from "./tables/model-comparisons";
export * from "./tables/model-replacement-audit";

// ============================================
// Assistant Architects
// ============================================
export * from "./tables/assistant-architects";
export * from "./tables/assistant-architect-events";
export * from "./tables/chain-prompts";
export * from "./tables/tool-input-fields";
export * from "./tables/tool-executions";
export * from "./tables/tool-edits";
export * from "./tables/prompt-results";

// ============================================
// Nexus Conversations
// ============================================
export * from "./tables/nexus-conversations";
export * from "./tables/nexus-folders";
export * from "./tables/nexus-messages";
export * from "./tables/nexus-conversation-folders";
export * from "./tables/nexus-conversation-events";
export * from "./tables/nexus-cache-entries";
export * from "./tables/nexus-shares";
export * from "./tables/nexus-templates";
export * from "./tables/nexus-user-preferences";
export * from "./tables/nexus-provider-metrics";
export * from "./tables/nexus-repository-bindings";

// ============================================
// Nexus MCP (Model Context Protocol)
// ============================================
export * from "./tables/nexus-mcp-servers";
export * from "./tables/nexus-mcp-connections";
export * from "./tables/nexus-mcp-capabilities";
export * from "./tables/nexus-mcp-audit-logs";
export * from "./tables/nexus-mcp-user-tokens";

// ============================================
// Documents
// ============================================
export * from "./tables/documents";
export * from "./tables/document-chunks";

// ============================================
// Knowledge Repositories
// ============================================
export * from "./tables/knowledge-repositories";
export * from "./tables/repository-items";
export * from "./tables/repository-item-chunks";
export * from "./tables/repository-access";
export * from "./tables/repository-item-versions";
export * from "./tables/repository-upload-sessions";
export * from "./tables/repository-processing-jobs";
export * from "./tables/repository-artifacts";
export * from "./tables/repository-index-generations";

// ============================================
// Prompt Library
// ============================================
export * from "./tables/prompt-library";
export * from "./tables/prompt-tags";
export * from "./tables/prompt-library-tags";
export * from "./tables/prompt-usage-events";

// ============================================
// Ideas & Voting
// ============================================
export * from "./tables/ideas";
export * from "./tables/idea-votes";
export * from "./tables/idea-notes";

// ============================================
// Jobs & Scheduling
// ============================================
export * from "./tables/jobs";
export * from "./tables/scheduled-executions";
export * from "./tables/execution-results";
export * from "./tables/user-notifications";

// ============================================
// Navigation
// ============================================
export * from "./tables/navigation-items";
export * from "./tables/navigation-item-roles";

// ============================================
// Settings & Configuration
// ============================================
export * from "./tables/settings";

// ============================================
// Textract (OCR Processing)
// ============================================
export * from "./tables/textract-jobs";
export * from "./tables/textract-usage";

// ============================================
// Migration Tracking
// ============================================
export * from "./tables/migration-log";
export * from "./tables/migration-mappings";

// ============================================
// Context Graph
// ============================================
export * from "./tables/graph-nodes";
export * from "./tables/graph-edges";

// ============================================
// Agent Platform Telemetry
// TODO: Add Zod insert/select validators (createInsertSchema/createSelectSchema)
//       when admin dashboards are built for telemetry queries.
// ============================================
export * from "./tables/agent-messages";
export * from "./tables/agent-sessions";
export * from "./tables/agent-feedback";
export * from "./tables/agent-health-snapshots";
export * from "./tables/agent-patterns";
export * from "./tables/agent-failures";
export * from "./tables/agent-pattern-scan-runs";
export * from "./tables/agent-health-scan-runs";
export * from "./tables/agent-message-content";
export * from "./tables/agent-tool-invocations";

// ============================================
// Agent Skills Platform (#910)
// ============================================
export * from "./tables/agent-skills";
export * from "./tables/agent-skill-audit";
export * from "./tables/agent-credentials-audit";
export * from "./tables/agent-credential-reads";
export * from "./tables/agent-credential-requests";

// ============================================
// Agent Workspace Integration (#912)
// ============================================
export * from "./tables/agent-workspace-tokens";
export * from "./tables/agent-workspace-consent-nonces";

// ============================================
// API Keys (External API Platform)
// ============================================
export * from "./tables/api-keys";
export * from "./tables/api-key-usage";

// ============================================
// OAuth2/OIDC Provider (#686)
// ============================================
export * from "./tables/oauth-clients";
export * from "./tables/oauth-authorization-codes";
export * from "./tables/oauth-access-tokens";
export * from "./tables/oauth-refresh-tokens";
export * from "./tables/jwks-keys";
export * from "./tables/oauth-consent-decisions";

// ============================================
// Atrium Content Workspace (#1058, Epic #1059)
// ============================================
export * from "./tables/content-collections";
export * from "./tables/content-objects";
export * from "./tables/content-versions";
export * from "./tables/content-visibility-grants";
export * from "./tables/content-publications";
export * from "./tables/agent-identities";
export * from "./tables/content-index-links";
export * from "./tables/content-audit-logs";
export * from "./tables/content-idempotency-records";
export * from "./tables/content-assets";
// Epic #1059 completion: §26.4 public-publish approval queue
export * from "./tables/content-publish-requests";
// Phase 1 (#1051): live collaborative document state (Yjs CRDT)
export * from "./tables/atrium-doc-state";
// Comments / track-changes thread store (§18.1)
export * from "./tables/atrium-doc-comments";
// Meridian slice D (#1059): embedded-artifact backlinks ("EMBEDDED IN")
export * from "./tables/content-embed-links";

// ============================================
// Google Directory Group Sync (Epic #1202, Phase 0 / #1203)
// ============================================
export * from "./tables/groups";
export * from "./tables/group-members";
export * from "./tables/group-selection-rules";
// Phase 1 (#1204): group→role mappings that drive managed roles.
export * from "./tables/group-role-mappings";
// Phase 3 (#1206): per-resource role/group access grants on models,
// assistants, and agent skills.
export * from "./tables/resource-access-grants";

// ============================================
// Relations
// ============================================
export * from "./relations";
