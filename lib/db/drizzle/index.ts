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
// Shared Utilities
// ============================================

export {
  getUserIdByCognitoSubAsNumber,
} from "./utils";

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
  getAllNavigationItemRoles,
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
  getToolsByIds,
  getRoleTools,
  assignToolToRole,
  removeToolFromRole,
  setRoleTools,
} from "./roles";

// ============================================
// Notification Operations
// ============================================

export {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  getNotificationById,
} from "./notifications";

// ============================================
// Execution Results Operations
// ============================================

export {
  getRecentExecutionResults,
  getExecutionResultById,
  getExecutionResultForDownload,
  deleteExecutionResult,
} from "./execution-results";

// ============================================
// Ideas Operations
// ============================================

export {
  // Types
  type IdeaListItem,
  type CreateIdeaData,
  // Query operations
  getIdeas,
  getUserVotedIdeaIds,
  getIdeaById,
  // CRUD operations
  createIdea,
  updateIdea,
  updateIdeaStatus,
  // Vote operations
  addVote,
  removeVote,
  hasUserVoted,
  // Note operations
  getIdeaNotes,
  addNote,
  deleteNote,
} from "./ideas";

// ============================================
// Settings Operations
// ============================================

export {
  // Types
  type SettingData,
  type CreateSettingData,
  // Query operations
  getSettings,
  getSettingValue,
  getSettingActualValue,
  // CRUD operations
  upsertSetting,
  deleteSetting,
} from "./settings";

// ============================================
// Assistant Architect Events Operations
// ============================================

export {
  // Types
  type ExecutionEvent,
  // Event operations
  storeExecutionEvent,
  getExecutionEvents,
  getExecutionEventsByType,
} from "./assistant-architect-events";

// ============================================
// Generic Jobs Operations (PDF processing, etc.)
// ============================================

export {
  // Types
  type GenericJobStatus,
  type GenericJob,
  type CreateGenericJobData,
  type UpdateGenericJobData,
  // Query operations
  getGenericJobById,
  getGenericJobByIdForUser,
  getGenericJobsByUserId,
  // CRUD operations
  createGenericJob,
  updateGenericJobStatus,
  updateGenericJob,
  deleteGenericJob,
} from "./jobs";

// ============================================
// AI Model Operations
// ============================================

export {
  // Types
  type AIModelData,
  type AIModelUpdateData,
  type BulkModelImportData,
  type BulkImportResult,
  // Query operations
  getAIModels,
  getAIModelById,
  getAIModelByModelId,
  getActiveAIModels,
  getChatEnabledModels,
  getNexusEnabledModels,
  getArchitectEnabledModels,
  getAIModelsByProvider,
  getModelsWithCapabilities,
  // CRUD operations
  createAIModel,
  updateAIModel,
  deleteAIModel,
  setAIModelActive,
  // Bulk operations
  bulkImportAIModels,
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
  getAllRepositoriesWithOwner,
  getUserAccessibleRepositories,
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
  revokeAccessById,
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

// ============================================
// Schedule Operations
// ============================================

export {
  // Types
  type ScheduleConfig,
  type CreateScheduleData,
  type UpdateScheduleData,
  type ScheduleWithExecution,
  type CreateExecutionResultData,
  // Schedule query operations
  getScheduleById,
  getScheduleByIdForUser,
  getSchedulesByUserId,
  getUserIdByCognitoSub as getScheduleUserIdByCognitoSub,
  checkAssistantArchitectOwnership,
  // Schedule CRUD operations
  createSchedule,
  updateSchedule,
  deleteSchedule,
  // Execution result operations
  createExecutionResult,
  getExecutionHistory,
  getExecutionHistoryCount,
} from "./schedules";

// ============================================
// Prompt Library Operations
// ============================================

export {
  // Types
  type PromptVisibility,
  type ModerationStatus,
  type UsageEventType,
  type CreatePromptData,
  type UpdatePromptData,
  type PromptListItem,
  type PromptSearchOptions,
  // Prompt query operations
  getPromptById,
  listPrompts,
  getPendingPrompts,
  // Prompt CRUD operations
  createPrompt,
  updatePrompt,
  deletePrompt,
  moderatePrompt,
  getModerationQueue,
  bulkModeratePrompts,
  getModerationStats,
  incrementViewCount,
  incrementUseCount,
  // Tag operations
  ensureTagsExist,
  setPromptTags,
  getAllTags,
  getPopularTags,
  getTagsForPrompt,
  searchTagsByName,
  // Usage event operations
  trackUsageEvent,
  getPromptUsageStats,
  usePromptAndCreateConversation,
} from "./prompt-library";

// ============================================
// Model Comparison Operations
// ============================================

export {
  // Types
  type UpdateComparisonResultsData,
  type ModelComparison,
  // Query operations
  getComparisonById,
  getComparisonByIdForUser,
  getComparisonsByUserId,
  getUserIdByCognitoSub as getComparisonUserIdByCognitoSub,
  // CRUD operations
  updateComparisonResults,
  deleteComparison,
} from "./model-comparisons";

// ============================================
// Query Helpers
// ============================================

export {
  // Pagination Types & Helpers
  type OffsetPaginationParams,
  type CursorPaginationParams,
  type PaginationMeta,
  type PaginatedResult,
  type CursorPaginatedResult,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  calculateOffset,
  buildPaginationMeta,
  createPaginatedResult,
  buildCursorCondition,
  processCursorResults,
  countAsInt,
  // Filter Types & Helpers
  type FilterOperator,
  type FilterCondition,
  type RangeFilter,
  buildFilter,
  buildFilters,
  buildFiltersOr,
  buildRangeFilter,
  eqOrSkip,
  inArrayOrSkip,
  ilikeOrSkip,
  combineAnd,
  combineOr,
  // Sorting Types & Helpers
  type SortDirection,
  type SortConfig,
  type SortSpec,
  type SortableColumns,
  buildSort,
  buildSortFromConfig,
  buildMultiSort,
  buildSortFromField,
  buildSortFromSpec,
  buildPinnedFirstSort,
  buildRecentActivitySort,
  createSortableColumns,
  // Search Types & Helpers
  type SearchOptions,
  type MultiColumnSearchConfig,
  escapeSearchPattern,
  buildSearchPattern,
  buildSearchCondition,
  buildMultiColumnSearch,
  buildSearchFromConfig,
  searchContains,
  searchStartsWith,
  searchEndsWith,
  searchExact,
  createSearchableColumns,
  // Domain Query Types & Helpers
  type UserWithRoles,
  type UserWithRolesAndTools,
  type UserQueryFilters,
  type ConversationWithMessages,
  type ConversationQueryFilters,
  getUsersWithRoles,
  getUserWithRolesAndTools,
  getConversationsWithMessages,
  getConversationWithAllMessages,
} from "./helpers";
