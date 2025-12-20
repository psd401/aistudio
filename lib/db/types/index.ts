/**
 * Unified Drizzle ORM Type Exports
 *
 * Auto-generated types from Drizzle schema definitions using InferSelectModel
 * and InferInsertModel. These types replace the manual definitions in
 * /types/db-types.ts.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #530 - Type unification strategy
 *
 * @example
 * ```typescript
 * // Import types from unified location
 * import type { SelectUser, InsertUser } from '@/lib/db/types';
 *
 * // Use in server actions
 * async function getUser(id: number): Promise<SelectUser | null> {
 *   return db.query.users.findFirst({ where: eq(users.id, id) });
 * }
 * ```
 */

import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

// Import all table definitions
import {
  // Core Tables
  users,
  roles,
  userRoles,
  tools,
  roleTools,
  // AI Models
  aiModels,
  aiStreamingJobs,
  modelComparisons,
  modelReplacementAudit,
  // Assistant Architects
  assistantArchitects,
  assistantArchitectEvents,
  chainPrompts,
  toolInputFields,
  toolExecutions,
  toolEdits,
  promptResults,
  // Nexus Conversations
  nexusConversations,
  nexusFolders,
  nexusMessages,
  nexusConversationFolders,
  nexusConversationEvents,
  nexusCacheEntries,
  nexusShares,
  nexusTemplates,
  nexusUserPreferences,
  nexusProviderMetrics,
  // Nexus MCP
  nexusMcpServers,
  nexusMcpConnections,
  nexusMcpCapabilities,
  nexusMcpAuditLogs,
  // Documents
  documents,
  documentChunks,
  // Knowledge Repositories
  knowledgeRepositories,
  repositoryItems,
  repositoryItemChunks,
  repositoryAccess,
  // Prompt Library
  promptLibrary,
  promptTags,
  promptLibraryTags,
  promptUsageEvents,
  // Ideas & Voting
  ideas,
  ideaVotes,
  ideaNotes,
  // Jobs & Scheduling
  jobs,
  scheduledExecutions,
  executionResults,
  userNotifications,
  // Navigation
  navigationItems,
  navigationItemRoles,
  // Settings
  settings,
  // Textract
  textractJobs,
  textractUsage,
  // Migration
  migrationLog,
  migrationMappings,
} from "@/lib/db/schema";

// ============================================
// JSONB Interface Exports
// ============================================
export type {
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
} from "./jsonb";

// ============================================
// Core Tables - Select Types
// ============================================
export type SelectUser = InferSelectModel<typeof users>;
export type SelectRole = InferSelectModel<typeof roles>;
export type SelectUserRole = InferSelectModel<typeof userRoles>;
export type SelectTool = InferSelectModel<typeof tools>;
export type SelectRoleTool = InferSelectModel<typeof roleTools>;

// ============================================
// Core Tables - Insert Types
// ============================================
export type InsertUser = InferInsertModel<typeof users>;
export type InsertRole = InferInsertModel<typeof roles>;
export type InsertUserRole = InferInsertModel<typeof userRoles>;
export type InsertTool = InferInsertModel<typeof tools>;
export type InsertRoleTool = InferInsertModel<typeof roleTools>;

// ============================================
// AI Models - Select Types
// ============================================
export type SelectAiModel = InferSelectModel<typeof aiModels>;
export type SelectAiStreamingJob = InferSelectModel<typeof aiStreamingJobs>;
export type SelectModelComparison = InferSelectModel<typeof modelComparisons>;
export type SelectModelReplacementAudit = InferSelectModel<
  typeof modelReplacementAudit
>;

// ============================================
// AI Models - Insert Types
// ============================================
export type InsertAiModel = InferInsertModel<typeof aiModels>;
export type InsertAiStreamingJob = InferInsertModel<typeof aiStreamingJobs>;
export type InsertModelComparison = InferInsertModel<typeof modelComparisons>;
export type InsertModelReplacementAudit = InferInsertModel<
  typeof modelReplacementAudit
>;

// ============================================
// Assistant Architects - Select Types
// ============================================
export type SelectAssistantArchitect = InferSelectModel<
  typeof assistantArchitects
>;
export type SelectAssistantArchitectEvent = InferSelectModel<
  typeof assistantArchitectEvents
>;
export type SelectChainPrompt = InferSelectModel<typeof chainPrompts>;
export type SelectToolInputField = InferSelectModel<typeof toolInputFields>;
export type SelectToolExecution = InferSelectModel<typeof toolExecutions>;
export type SelectToolEdit = InferSelectModel<typeof toolEdits>;
export type SelectPromptResult = InferSelectModel<typeof promptResults>;

// ============================================
// Assistant Architects - Insert Types
// ============================================
export type InsertAssistantArchitect = InferInsertModel<
  typeof assistantArchitects
>;
export type InsertAssistantArchitectEvent = InferInsertModel<
  typeof assistantArchitectEvents
>;
export type InsertChainPrompt = InferInsertModel<typeof chainPrompts>;
export type InsertToolInputField = InferInsertModel<typeof toolInputFields>;
export type InsertToolExecution = InferInsertModel<typeof toolExecutions>;
export type InsertToolEdit = InferInsertModel<typeof toolEdits>;
export type InsertPromptResult = InferInsertModel<typeof promptResults>;

// ============================================
// Nexus Conversations - Select Types
// ============================================
export type SelectNexusConversation = InferSelectModel<
  typeof nexusConversations
>;
export type SelectNexusFolder = InferSelectModel<typeof nexusFolders>;
export type SelectNexusMessage = InferSelectModel<typeof nexusMessages>;
export type SelectNexusConversationFolder = InferSelectModel<
  typeof nexusConversationFolders
>;
export type SelectNexusConversationEvent = InferSelectModel<
  typeof nexusConversationEvents
>;
export type SelectNexusCacheEntry = InferSelectModel<typeof nexusCacheEntries>;
export type SelectNexusShare = InferSelectModel<typeof nexusShares>;
export type SelectNexusTemplate = InferSelectModel<typeof nexusTemplates>;
export type SelectNexusUserPreferences = InferSelectModel<
  typeof nexusUserPreferences
>;
export type SelectNexusProviderMetrics = InferSelectModel<
  typeof nexusProviderMetrics
>;

// ============================================
// Nexus Conversations - Insert Types
// ============================================
export type InsertNexusConversation = InferInsertModel<
  typeof nexusConversations
>;
export type InsertNexusFolder = InferInsertModel<typeof nexusFolders>;
export type InsertNexusMessage = InferInsertModel<typeof nexusMessages>;
export type InsertNexusConversationFolder = InferInsertModel<
  typeof nexusConversationFolders
>;
export type InsertNexusConversationEvent = InferInsertModel<
  typeof nexusConversationEvents
>;
export type InsertNexusCacheEntry = InferInsertModel<typeof nexusCacheEntries>;
export type InsertNexusShare = InferInsertModel<typeof nexusShares>;
export type InsertNexusTemplate = InferInsertModel<typeof nexusTemplates>;
export type InsertNexusUserPreferences = InferInsertModel<
  typeof nexusUserPreferences
>;
export type InsertNexusProviderMetrics = InferInsertModel<
  typeof nexusProviderMetrics
>;

// ============================================
// Nexus MCP - Select Types
// ============================================
export type SelectNexusMcpServer = InferSelectModel<typeof nexusMcpServers>;
export type SelectNexusMcpConnection = InferSelectModel<
  typeof nexusMcpConnections
>;
export type SelectNexusMcpCapability = InferSelectModel<
  typeof nexusMcpCapabilities
>;
export type SelectNexusMcpAuditLog = InferSelectModel<typeof nexusMcpAuditLogs>;

// ============================================
// Nexus MCP - Insert Types
// ============================================
export type InsertNexusMcpServer = InferInsertModel<typeof nexusMcpServers>;
export type InsertNexusMcpConnection = InferInsertModel<
  typeof nexusMcpConnections
>;
export type InsertNexusMcpCapability = InferInsertModel<
  typeof nexusMcpCapabilities
>;
export type InsertNexusMcpAuditLog = InferInsertModel<typeof nexusMcpAuditLogs>;

// ============================================
// Documents - Select Types
// ============================================
export type SelectDocument = InferSelectModel<typeof documents>;
export type SelectDocumentChunk = InferSelectModel<typeof documentChunks>;

// ============================================
// Documents - Insert Types
// ============================================
export type InsertDocument = InferInsertModel<typeof documents>;
export type InsertDocumentChunk = InferInsertModel<typeof documentChunks>;

// ============================================
// Knowledge Repositories - Select Types
// ============================================
export type SelectKnowledgeRepository = InferSelectModel<
  typeof knowledgeRepositories
>;
export type SelectRepositoryItem = InferSelectModel<typeof repositoryItems>;
export type SelectRepositoryItemChunk = InferSelectModel<
  typeof repositoryItemChunks
>;
export type SelectRepositoryAccess = InferSelectModel<typeof repositoryAccess>;

// ============================================
// Knowledge Repositories - Insert Types
// ============================================
export type InsertKnowledgeRepository = InferInsertModel<
  typeof knowledgeRepositories
>;
export type InsertRepositoryItem = InferInsertModel<typeof repositoryItems>;
export type InsertRepositoryItemChunk = InferInsertModel<
  typeof repositoryItemChunks
>;
export type InsertRepositoryAccess = InferInsertModel<typeof repositoryAccess>;

// ============================================
// Prompt Library - Select Types
// ============================================
export type SelectPromptLibrary = InferSelectModel<typeof promptLibrary>;
export type SelectPromptTag = InferSelectModel<typeof promptTags>;
export type SelectPromptLibraryTag = InferSelectModel<typeof promptLibraryTags>;
export type SelectPromptUsageEvent = InferSelectModel<typeof promptUsageEvents>;

// ============================================
// Prompt Library - Insert Types
// ============================================
export type InsertPromptLibrary = InferInsertModel<typeof promptLibrary>;
export type InsertPromptTag = InferInsertModel<typeof promptTags>;
export type InsertPromptLibraryTag = InferInsertModel<typeof promptLibraryTags>;
export type InsertPromptUsageEvent = InferInsertModel<typeof promptUsageEvents>;

// ============================================
// Ideas & Voting - Select Types
// ============================================
export type SelectIdea = InferSelectModel<typeof ideas>;
export type SelectIdeaVote = InferSelectModel<typeof ideaVotes>;
export type SelectIdeaNote = InferSelectModel<typeof ideaNotes>;

// ============================================
// Ideas & Voting - Insert Types
// ============================================
export type InsertIdea = InferInsertModel<typeof ideas>;
export type InsertIdeaVote = InferInsertModel<typeof ideaVotes>;
export type InsertIdeaNote = InferInsertModel<typeof ideaNotes>;

// ============================================
// Jobs & Scheduling - Select Types
// ============================================
export type SelectJob = InferSelectModel<typeof jobs>;
export type SelectScheduledExecution = InferSelectModel<
  typeof scheduledExecutions
>;
export type SelectExecutionResult = InferSelectModel<typeof executionResults>;
export type SelectUserNotification = InferSelectModel<typeof userNotifications>;

// ============================================
// Jobs & Scheduling - Insert Types
// ============================================
export type InsertJob = InferInsertModel<typeof jobs>;
export type InsertScheduledExecution = InferInsertModel<
  typeof scheduledExecutions
>;
export type InsertExecutionResult = InferInsertModel<typeof executionResults>;
export type InsertUserNotification = InferInsertModel<typeof userNotifications>;

// ============================================
// Navigation - Select Types
// ============================================
export type SelectNavigationItem = InferSelectModel<typeof navigationItems>;
export type SelectNavigationItemRole = InferSelectModel<
  typeof navigationItemRoles
>;

// ============================================
// Navigation - Insert Types
// ============================================
export type InsertNavigationItem = InferInsertModel<typeof navigationItems>;
export type InsertNavigationItemRole = InferInsertModel<
  typeof navigationItemRoles
>;

// ============================================
// Settings - Select Types
// ============================================
export type SelectSetting = InferSelectModel<typeof settings>;

// ============================================
// Settings - Insert Types
// ============================================
export type InsertSetting = InferInsertModel<typeof settings>;

// ============================================
// Textract - Select Types
// ============================================
export type SelectTextractJob = InferSelectModel<typeof textractJobs>;
export type SelectTextractUsage = InferSelectModel<typeof textractUsage>;

// ============================================
// Textract - Insert Types
// ============================================
export type InsertTextractJob = InferInsertModel<typeof textractJobs>;
export type InsertTextractUsage = InferInsertModel<typeof textractUsage>;

// ============================================
// Migration - Select Types
// ============================================
export type SelectMigrationLog = InferSelectModel<typeof migrationLog>;
export type SelectMigrationMapping = InferSelectModel<typeof migrationMappings>;

// ============================================
// Migration - Insert Types
// ============================================
export type InsertMigrationLog = InferInsertModel<typeof migrationLog>;
export type InsertMigrationMapping = InferInsertModel<typeof migrationMappings>;
