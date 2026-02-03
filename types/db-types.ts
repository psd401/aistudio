/**
 * Database Type Definitions
 *
 * @deprecated This file is maintained for backwards compatibility only.
 * All new code should import from `@/lib/db/types` instead.
 *
 * Migration guide:
 * ```typescript
 * // Before (deprecated)
 * import type { SelectUser, InsertUser } from '@/types/db-types';
 *
 * // After (preferred)
 * import type { SelectUser, InsertUser } from '@/lib/db/types';
 * ```
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #530 - Type unification strategy
 *
 * @see /lib/db/types/index.ts for unified Drizzle-generated types
 */

// ============================================
// Re-export all types from the new unified location
// ============================================
export type {
  // JSONB interfaces
  NexusCapabilities,
  ProviderMetadata,
  ToolInputFieldOptions,
  NexusConversationMetadata,
  NexusFolderSettings,
  NexusUserSettings,
  NexusConversationEventData,
  NexusMcpSchema,
  NexusMcpAuditData,
  NexusTemplateVariable,
  ScheduleConfig,
  // Core Tables
  SelectUser,
  InsertUser,
  SelectRole,
  InsertRole,
  SelectUserRole,
  InsertUserRole,
  SelectTool,
  InsertTool,
  SelectRoleTool,
  InsertRoleTool,
  // AI Models
  SelectAiModel,
  InsertAiModel,
  SelectAiStreamingJob,
  InsertAiStreamingJob,
  SelectModelComparison,
  InsertModelComparison,
  SelectModelReplacementAudit,
  InsertModelReplacementAudit,
  // Assistant Architects
  SelectAssistantArchitect,
  InsertAssistantArchitect,
  SelectAssistantArchitectEvent,
  InsertAssistantArchitectEvent,
  SelectChainPrompt,
  InsertChainPrompt,
  SelectToolInputField,
  InsertToolInputField,
  SelectToolExecution,
  InsertToolExecution,
  SelectToolEdit,
  InsertToolEdit,
  SelectPromptResult,
  InsertPromptResult,
  // Nexus Conversations
  SelectNexusConversation,
  InsertNexusConversation,
  SelectNexusFolder,
  InsertNexusFolder,
  SelectNexusMessage,
  InsertNexusMessage,
  SelectNexusConversationFolder,
  InsertNexusConversationFolder,
  SelectNexusConversationEvent,
  InsertNexusConversationEvent,
  SelectNexusCacheEntry,
  InsertNexusCacheEntry,
  SelectNexusShare,
  InsertNexusShare,
  SelectNexusTemplate,
  InsertNexusTemplate,
  SelectNexusUserPreferences,
  InsertNexusUserPreferences,
  SelectNexusProviderMetrics,
  InsertNexusProviderMetrics,
  // Nexus MCP
  SelectNexusMcpServer,
  InsertNexusMcpServer,
  SelectNexusMcpConnection,
  InsertNexusMcpConnection,
  SelectNexusMcpCapability,
  InsertNexusMcpCapability,
  SelectNexusMcpAuditLog,
  InsertNexusMcpAuditLog,
  // Documents
  SelectDocument,
  InsertDocument,
  SelectDocumentChunk,
  InsertDocumentChunk,
  // Knowledge Repositories
  SelectKnowledgeRepository,
  InsertKnowledgeRepository,
  SelectRepositoryItem,
  InsertRepositoryItem,
  SelectRepositoryItemChunk,
  InsertRepositoryItemChunk,
  SelectRepositoryAccess,
  InsertRepositoryAccess,
  // Prompt Library
  SelectPromptLibrary,
  InsertPromptLibrary,
  SelectPromptTag,
  InsertPromptTag,
  SelectPromptLibraryTag,
  InsertPromptLibraryTag,
  SelectPromptUsageEvent,
  InsertPromptUsageEvent,
  // Ideas & Voting
  SelectIdea,
  InsertIdea,
  SelectIdeaVote,
  InsertIdeaVote,
  SelectIdeaNote,
  InsertIdeaNote,
  // Jobs & Scheduling
  SelectJob,
  InsertJob,
  SelectScheduledExecution,
  InsertScheduledExecution,
  SelectExecutionResult,
  InsertExecutionResult,
  SelectUserNotification,
  InsertUserNotification,
  // Navigation
  SelectNavigationItem,
  InsertNavigationItem,
  SelectNavigationItemRole,
  InsertNavigationItemRole,
  // Settings
  SelectSetting,
  InsertSetting,
  // Textract
  SelectTextractJob,
  InsertTextractJob,
  SelectTextractUsage,
  InsertTextractUsage,
  // Migration
  SelectMigrationLog,
  InsertMigrationLog,
  SelectMigrationMapping,
  InsertMigrationMapping,
} from "@/lib/db/types";
