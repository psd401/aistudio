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
