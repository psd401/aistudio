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
export * from "./tables/tools";
export * from "./tables/role-tools";

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

// ============================================
// Nexus MCP (Model Context Protocol)
// ============================================
export * from "./tables/nexus-mcp-servers";
export * from "./tables/nexus-mcp-connections";
export * from "./tables/nexus-mcp-capabilities";
export * from "./tables/nexus-mcp-audit-logs";

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
// Relations
// ============================================
export * from "./relations";
