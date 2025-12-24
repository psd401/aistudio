/**
 * Drizzle ORM Operations - Barrel Export
 *
 * Centralized export for all Drizzle ORM database operations.
 * Import from this module for cleaner imports throughout the codebase.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #531 - Migrate User & Authorization queries to Drizzle ORM
 *
 * @example
 * ```typescript
 * // Instead of:
 * import { getUsers } from '@/lib/db/drizzle/users';
 * import { getRoles } from '@/lib/db/drizzle/roles';
 *
 * // Use:
 * import { getUsers, getRoles } from '@/lib/db/drizzle';
 * ```
 */

// ============================================
// User Operations
// ============================================

export {
  // Types
  type UserData,
  // Query operations
  getUsers,
  getUserById,
  getUserByEmail,
  getUserByCognitoSub,
  getUserIdByCognitoSub,
  // CRUD operations
  createUser,
  updateUser,
  deleteUser,
  // Role check operations
  checkUserRole,
  checkUserRoleByCognitoSub,
  getUserRolesByCognitoSub,
  getAllUserRoles,
  // Tool access operations
  hasToolAccess,
  getUserTools,
} from "./users";

// ============================================
// User Role Operations
// ============================================

export {
  // Query operations
  getUserRoles,
  // Transaction operations
  updateUserRoles,
  addUserRole,
  removeUserRole,
  updateUserRole,
  assignRoleToUser,
} from "./user-roles";

// ============================================
// Navigation Operations
// ============================================

export {
  // Types
  type NavigationItemData,
  // Query operations
  getNavigationItems,
  getNavigationItemById,
  getNavigationItemsByRole,
  getNavigationItemsByUser,
  // CRUD operations
  createNavigationItem,
  updateNavigationItem,
  deleteNavigationItem,
  // Role assignment operations
  setNavigationItemRoles,
  getNavigationItemRoles,
} from "./navigation";

// ============================================
// Role Operations
// ============================================

export {
  // Types
  type RoleData,
  // Query operations
  getRoles,
  getRoleByName,
  getRoleById,
  // CRUD operations
  createRole,
  updateRole,
  deleteRole,
  // Tool operations
  getTools,
  getRoleTools,
  assignToolToRole,
  removeToolFromRole,
  setRoleTools,
} from "./roles";

// ============================================
// AI Model Operations
// ============================================

export {
  // Types
  type AIModelData,
  type AIModelUpdateData,
  // Query operations
  getAIModels,
  getAIModelById,
  getAIModelByModelId,
  getActiveAIModels,
  getChatEnabledModels,
  getAIModelsByProvider,
  getModelsWithCapabilities,
  // CRUD operations
  createAIModel,
  updateAIModel,
  deleteAIModel,
  setAIModelActive,
  // Reference operations
  getModelReferenceCounts,
  validateModelReplacement,
  replaceModelReferences,
} from "./ai-models";

// ============================================
// Assistant Architect Operations
// ============================================

export {
  // Types
  type AssistantArchitectData,
  type AssistantArchitectUpdateData,
  type AssistantArchitectWithCreator,
  type ToolStatus,
  // Query operations
  getAssistantArchitects,
  getAssistantArchitectById,
  getAssistantArchitectWithCreator,
  getAssistantArchitectsByUserId,
  getAssistantArchitectsByStatus,
  getPendingAssistantArchitects,
  // CRUD operations
  createAssistantArchitect,
  createAssistantArchitectByCognitoSub,
  updateAssistantArchitect,
  deleteAssistantArchitect,
  // Status operations
  approveAssistantArchitect,
  rejectAssistantArchitect,
  submitForApproval,
} from "./assistant-architects";

// ============================================
// Chain Prompt Operations
// ============================================

export {
  // Types
  type ChainPromptData,
  type ChainPromptUpdateData,
  type ChainPromptWithModel,
  type FieldType,
  // Query operations
  getChainPrompts,
  getChainPromptById,
  getChainPromptWithModel,
  getChainPromptsWithModels,
  getChainPromptsByModelId,
  // CRUD operations
  createChainPrompt,
  updateChainPrompt,
  deleteChainPrompt,
  reorderChainPrompts,
  // Tool input field operations
  getToolInputFields,
  createToolInputField,
  updateToolInputField,
  deleteToolInputField,
} from "./chain-prompts";

// ============================================
// Nexus Conversations Operations
// ============================================

export {
  // Constants
  DEFAULT_CONVERSATION_LIMIT,
  DEFAULT_FOLDER_COLOR,
  DEFAULT_FOLDER_ICON,
  // Types
  type ConversationListItem,
  type CreateConversationData,
  type UpdateConversationData,
  type ConversationListOptions,
  type CreateFolderData,
  type UpdateFolderData,
  // Conversation query operations
  getConversations,
  getConversationCount,
  getConversationById,
  // Conversation CRUD operations
  createConversation,
  recordConversationEvent,
  updateConversation,
  archiveConversation,
  unarchiveConversation,
  deleteConversation,
  // Folder query operations
  getFolders,
  getFolderById,
  // Folder CRUD operations
  createFolder,
  updateFolder,
  deleteFolder,
  moveConversationsToFolder,
} from "./nexus-conversations";

// ============================================
// Nexus Messages Operations
// ============================================

export {
  // Constants
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  // Types
  type TokenUsage,
  type MessagePart,
  type CreateMessageData,
  type UpdateMessageData,
  type MessageWithModel,
  type MessageQueryOptions,
  // Query operations
  getMessagesByConversation,
  getMessageById,
  getMessageCount,
  getLastMessage,
  // CRUD operations
  createMessage,
  upsertMessage,
  batchCreateMessages,
  updateMessage,
  deleteMessage,
  deleteConversationMessages,
  // Stats operations
  updateConversationStats,
  createMessageWithStats,
  upsertMessageWithStats,
} from "./nexus-messages";

// ============================================
// AI Streaming Jobs Operations
// ============================================

export {
  // Constants
  MAX_PENDING_JOBS_LIMIT,
  COMPLETED_JOBS_RETENTION_DAYS,
  FAILED_JOBS_RETENTION_DAYS,
  STALE_JOB_THRESHOLD_MINUTES,
  MAX_PARTIAL_CONTENT_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  UUID_REGEX,
  // Types
  type JobStatus,
  type UniversalPollingStatus,
  type JobRequestData,
  type JobResponseData,
  type JobProgressInfo,
  type StreamingJob,
  type CreateJobData,
  type UpdateJobStatusData,
  type CompleteJobData,
  // Validation utilities
  isValidUUID,
  // Status mapping utilities
  mapToDatabaseStatus,
  mapFromDatabaseStatus,
  // Query operations
  getJob,
  getUserJobs,
  getConversationJobs,
  getPendingJobs,
  getActiveJobsForUser,
  // CRUD operations
  createJob,
  updateJobStatus,
  completeJob,
  failJob,
  cancelJob,
  markMessagePersisted,
  deleteJob,
  // Cleanup operations
  cleanupCompletedJobs,
  cleanupFailedJobs,
  cleanupStaleRunningJobs,
  // Model operations
  getOptimalPollingInterval,
} from "./ai-streaming-jobs";

// ============================================
// Document Operations
// ============================================

export {
  // Types
  type DocumentMetadata,
  type ChunkMetadata,
  type CreateDocumentData,
  type UpdateDocumentData,
  type CreateChunkData,
  // Query operations
  getDocumentById,
  getDocumentsByUserId,
  getDocumentsByConversationId,
  // Document CRUD operations
  createDocument,
  updateDocument,
  linkDocumentToConversation,
  deleteDocument,
  // Chunk operations
  getChunksByDocumentId,
  createChunk,
  batchInsertChunks,
  deleteChunksByDocumentId,
  // Combined operations
  getDocumentWithChunks,
} from "./documents";

// ============================================
// Knowledge Repository Operations
// ============================================

export {
  // Types
  type RepositoryMetadata,
  type ProcessingStatus,
  type CreateRepositoryData,
  type UpdateRepositoryData,
  type CreateRepositoryItemData,
  type CreateChunkData as CreateRepositoryItemChunkData,
  type RepositoryWithAccess,
  // Repository query operations
  getRepositoryById,
  getRepositoriesByOwnerId,
  getPublicRepositories,
  getAccessibleRepositoryIds,
  getAccessibleRepositoriesByCognitoSub,
  // Repository CRUD operations
  createRepository,
  updateRepository,
  deleteRepository,
  // Repository access operations
  grantUserAccess,
  grantRoleAccess,
  revokeUserAccess,
  revokeRoleAccess,
  getRepositoryAccessList,
  // Repository item operations
  getRepositoryItems,
  getRepositoryItemById,
  createRepositoryItem,
  updateRepositoryItemStatus,
  deleteRepositoryItem,
  // Repository item chunk operations
  getRepositoryItemChunks,
  createRepositoryItemChunk,
  batchInsertRepositoryItemChunks,
  deleteRepositoryItemChunks,
} from "./knowledge-repositories";

// ============================================
// Textract Operations
// ============================================

export {
  // Types
  type CreateTextractJobData,
  type TextractJobMetadata,
  type UpdateTextractUsageData,
  // Job operations
  getTextractJob,
  getTextractJobMetadata,
  getTextractJobsByItemId,
  createTextractJob,
  deleteTextractJob,
  // Usage operations
  getTextractUsage,
  getAllTextractUsage,
  trackTextractUsage,
  getTotalTextractUsage,
  // Cost utilities
  estimateTextractCost,
  getTextractUsageWithCost,
} from "./textract";
