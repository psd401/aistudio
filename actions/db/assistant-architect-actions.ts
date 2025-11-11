"use server"

import {
  type InsertAssistantArchitect,
  type SelectAssistantArchitect,
  type InsertToolInputField,
  type InsertChainPrompt,
  type InsertToolExecution,
  type InsertPromptResult,
  type SelectToolInputField,
  type SelectChainPrompt,
  type SelectToolExecution,
  type SelectPromptResult,
  type SelectTool,
  type SelectAiModel
} from "@/types/db-types"
// CoreMessage import removed - AI completion now handled by Lambda workers
import { transformSnakeToCamel } from '@/lib/db/field-mapper'
import { parseRepositoryIds, serializeRepositoryIds } from "@/lib/utils/repository-utils"
import { getAvailableToolsForModel, getAllTools, isToolAvailableForModel } from "@/lib/tools/tool-registry"
import { collectAndSanitizeEnabledTools } from '@/lib/assistant-architect/tool-utils'

import { createJobAction, updateJobAction, getJobAction } from "@/actions/db/jobs-actions";
import { createError, handleError, createSuccess, ErrorFactories } from "@/lib/error-utils";
import { generateToolIdentifier } from "@/lib/utils";
import { ActionState, ErrorLevel } from "@/types";
import { ExecutionResultDetails } from "@/types/assistant-architect-types";
import { hasRole, getUserTools } from "@/utils/roles";
import { createNavigationItemAction } from "@/actions/db/navigation-actions"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { getServerSession } from "@/lib/auth/server-session";
import { executeSQL, checkUserRoleByCognitoSub, hasToolAccess, type FormattedRow } from "@/lib/db/data-api-adapter";
import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import { SqlParameter } from "@aws-sdk/client-rds-data";

// Type for raw database result rows
type RawDbRow = Record<string, string | number | boolean | null | Uint8Array | { arrayValue?: { stringValues?: string[] } }>;

// Use inline type for architect with relations
type ArchitectWithRelations = SelectAssistantArchitect & {
  inputFields?: SelectToolInputField[];
  prompts?: SelectChainPrompt[];
}

// Helper function to safely parse integers with validation
function safeParseInt(value: string, fieldName: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw ErrorFactories.validationFailed([{
      field: fieldName,
      message: `Invalid ${fieldName} format`
    }]);
  }
  return parsed;
}

// Helper function to transform and parse prompt data consistently
function transformPrompt(prompt: any): SelectChainPrompt {
  const transformed = transformSnakeToCamel<SelectChainPrompt>(prompt);
  // Parse repository_ids using utility function
  transformed.repositoryIds = parseRepositoryIds(transformed.repositoryIds);
  // Parse enabled_tools from JSONB array to string array
  if (transformed.enabledTools && typeof transformed.enabledTools === 'string') {
    try {
      // Add length check to prevent DoS
      if ((transformed.enabledTools as string).length > 10000) {
        transformed.enabledTools = [];
        return transformed;
      }
      const parsed = JSON.parse(transformed.enabledTools);
      // Validate parsed data structure
      transformed.enabledTools = Array.isArray(parsed) ? parsed : [];
    } catch {
      transformed.enabledTools = [];
    }
  } else if (!transformed.enabledTools) {
    transformed.enabledTools = [];
  }
  return transformed;
}

// Helper function to validate enabled tools against model capabilities
async function validateEnabledTools(
  enabledTools: string[],
  modelId: number
): Promise<{ isValid: boolean; invalidTools: string[]; message?: string }> {
  if (!enabledTools || enabledTools.length === 0) {
    return { isValid: true, invalidTools: [] };
  }

  try {
    // Get model ID string from database
    const modelResult = await executeSQL<{ modelId: string }>(`
      SELECT model_id FROM ai_models WHERE id = :id AND active = true
    `, [{ name: 'id', value: { longValue: modelId } }]);

    if (!modelResult || modelResult.length === 0) {
      return {
        isValid: false,
        invalidTools: enabledTools,
        message: "Model not found or inactive"
      };
    }

    const modelIdString = modelResult[0].modelId;

    // Get all available tools for the model
    const availableTools = await getAvailableToolsForModel(modelIdString);
    const availableToolNames = availableTools.map(tool => tool.name);

    // Get all registered tools to validate tool names exist
    const allTools = getAllTools();
    const allToolNames = allTools.map(tool => tool.name);

    // Check for unknown tools
    const unknownTools = enabledTools.filter(toolName => !allToolNames.includes(toolName));
    if (unknownTools.length > 0) {
      return {
        isValid: false,
        invalidTools: unknownTools,
        message: `Unknown tools: ${unknownTools.join(', ')}`
      };
    }

    // Check for tools not available for this model
    const unavailableTools = enabledTools.filter(toolName => !availableToolNames.includes(toolName));
    if (unavailableTools.length > 0) {
      return {
        isValid: false,
        invalidTools: unavailableTools,
        message: `Tools not supported by this model: ${unavailableTools.join(', ')}`
      };
    }

    return { isValid: true, invalidTools: [] };
  } catch (error) {
    return {
      isValid: false,
      invalidTools: enabledTools,
      message: `Error validating tools: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}



// Helper function to get current user ID
async function getCurrentUserId(): Promise<number | null> {
  const currentUser = await getCurrentUserAction();
  if (currentUser.isSuccess && currentUser.data) {
    return currentUser.data.user.id;
  }
  return null;
}

// Input validation and sanitization function for Assistant Architect
function validateAssistantArchitectInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const validated: Record<string, unknown> = {};
  const MAX_INPUT_LENGTH = 10000; // Maximum length for string inputs
  const MAX_INPUTS = 50; // Maximum number of inputs
  
  // Check maximum number of inputs to prevent resource exhaustion
  const inputKeys = Object.keys(inputs);
  if (inputKeys.length > MAX_INPUTS) {
    throw ErrorFactories.validationFailed([{
      field: 'inputs',
      message: `Too many inputs provided (${inputKeys.length}). Maximum allowed: ${MAX_INPUTS}`
    }]);
  }
  
  for (const [key, value] of Object.entries(inputs)) {
    // Validate key format (alphanumeric, underscores, hyphens only)
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw ErrorFactories.validationFailed([{
        field: key,
        message: 'Invalid input field name format. Only alphanumeric characters, underscores, and hyphens are allowed.'
      }]);
    }
    
    // Validate key length
    if (key.length > 100) {
      throw ErrorFactories.validationFailed([{
        field: key,
        message: 'Input field name too long. Maximum length: 100 characters.'
      }]);
    }
    
    // Validate and sanitize values based on type
    if (typeof value === 'string') {
      // Limit string length to prevent resource exhaustion
      const sanitizedValue = value.slice(0, MAX_INPUT_LENGTH);
      validated[key] = sanitizedValue;
    } else if (typeof value === 'number') {
      // Ensure number is finite and within reasonable bounds
      if (!isFinite(value) || value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
        throw ErrorFactories.validationFailed([{
          field: key,
          message: 'Invalid number value.'
        }]);
      }
      validated[key] = value;
    } else if (typeof value === 'boolean') {
      validated[key] = value;
    } else if (value === null || value === undefined) {
      validated[key] = null;
    } else if (Array.isArray(value)) {
      // Handle arrays by converting to JSON string and limiting length
      const jsonString = JSON.stringify(value);
      if (jsonString.length > MAX_INPUT_LENGTH) {
        throw ErrorFactories.validationFailed([{
          field: key,
          message: `Array value too large. Maximum serialized length: ${MAX_INPUT_LENGTH} characters.`
        }]);
      }
      validated[key] = jsonString.slice(0, MAX_INPUT_LENGTH);
    } else if (typeof value === 'object') {
      // Handle objects by converting to JSON string and limiting length
      const jsonString = JSON.stringify(value);
      if (jsonString.length > MAX_INPUT_LENGTH) {
        throw ErrorFactories.validationFailed([{
          field: key,
          message: `Object value too large. Maximum serialized length: ${MAX_INPUT_LENGTH} characters.`
        }]);
      }
      validated[key] = jsonString.slice(0, MAX_INPUT_LENGTH);
    } else {
      // Convert unknown types to string safely
      validated[key] = String(value).slice(0, MAX_INPUT_LENGTH);
    }
  }
  
  return validated;
}

// The missing function needed by page.tsx
export async function getAssistantArchitectAction(
  id: string
): Promise<ActionState<ArchitectWithRelations | undefined>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAssistantArchitect")
  const log = createLogger({ requestId, action: "getAssistantArchitect" })
  
  log.info("Action started: Getting assistant architect", { architectId: id })
  
  // This is an alias for getAssistantArchitectByIdAction for backward compatibility
  const result = await getAssistantArchitectByIdAction(id);
  
  timer({ status: result.isSuccess ? "success" : "error", architectId: id })
  
  return result;
}

// Tool Management Actions

export async function createAssistantArchitectAction(
  assistant: InsertAssistantArchitect
): Promise<ActionState<SelectAssistantArchitect>> {
  const requestId = generateRequestId()
  const timer = startTimer("createAssistantArchitect")
  const log = createLogger({ requestId, action: "createAssistantArchitect" })
  
  try {
    log.info("Action started: Creating assistant architect", {
      name: assistant.name,
      status: assistant.status || 'draft'
    })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect creation attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("User authenticated", { userId: session.sub })
    
    // Get the current user's database ID
    log.debug("Getting current user")
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data) {
      log.error("User not found in database")
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    log.info("Creating assistant architect in database", {
      name: assistant.name,
      userId: currentUser.data.user.id
    })
    
    const [architectRaw] = await executeSQL<RawDbRow>(`
      INSERT INTO assistant_architects (name, description, status, image_path, user_id, created_at, updated_at)
      VALUES (:name, :description, :status::tool_status, :imagePath, :userId, NOW(), NOW())
      RETURNING id, name, description, status, image_path, user_id, created_at, updated_at
    `, [
      { name: 'name', value: { stringValue: assistant.name } },
      { name: 'description', value: { stringValue: assistant.description || '' } },
      { name: 'status', value: { stringValue: assistant.status || 'draft' } },
      { name: 'imagePath', value: assistant.imagePath ? { stringValue: assistant.imagePath } : { isNull: true } },
      { name: 'userId', value: { longValue: currentUser.data.user.id } }
    ]);

    const architect = transformSnakeToCamel<SelectAssistantArchitect>(architectRaw);

    log.info("Assistant architect created successfully", {
      architectId: architect.id,
      name: architect.name
    })
    
    timer({ status: "success", architectId: architect.id })
    
    return createSuccess(architect, "Assistant architect created successfully");
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to create assistant architect. Please try again or contact support.", {
      context: "createAssistantArchitect",
      requestId,
      operation: "createAssistantArchitect",
      metadata: { name: assistant.name }
    });
  }
}

export async function getAssistantArchitectsAction(): Promise<
  ActionState<(SelectAssistantArchitect & {
    inputFields: SelectToolInputField[];
    prompts: SelectChainPrompt[];
    creator: { firstName: string; lastName: string; email: string } | null;
    cognito_sub: string;
  })[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getAssistantArchitects")
  const log = createLogger({ requestId, action: "getAssistantArchitects" })
  
  try {
    log.info("Action started: Getting assistant architects")
    
    const architectsRaw = await executeSQL<RawDbRow>(`
      SELECT a.id, a.name, a.description, a.status, a.image_path, a.user_id, a.created_at, a.updated_at,
             u.first_name AS creator_first_name, u.last_name AS creator_last_name, u.email AS creator_email,
             u.cognito_sub
      FROM assistant_architects a
      LEFT JOIN users u ON a.user_id = u.id
    `);

    const architectsWithRelations = await Promise.all(
      architectsRaw.map(async (architect: RawDbRow) => {
        const [inputFieldsRaw, promptsRaw] = await Promise.all([
          executeSQL<RawDbRow>(`
            SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
            FROM tool_input_fields
            WHERE assistant_architect_id = :toolId
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(architect.id) } }]),
          executeSQL<RawDbRow>(`
            SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, repository_ids, enabled_tools, created_at, updated_at
            FROM chain_prompts
            WHERE assistant_architect_id = :toolId
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(architect.id) } }])
        ]);

        const inputFields = inputFieldsRaw.map((field) => transformSnakeToCamel<SelectToolInputField>(field));
        const prompts = promptsRaw.map(transformPrompt);
        const transformedArchitect = transformSnakeToCamel<SelectAssistantArchitect>(architect);

        return {
          ...transformedArchitect,
          inputFields,
          prompts,
          creator: architect.creator_first_name && architect.creator_last_name && architect.creator_email
            ? {
                firstName: String(architect.creator_first_name),
                lastName: String(architect.creator_last_name),
                email: String(architect.creator_email)
              }
            : null,
          cognito_sub: String(architect.cognito_sub)
        };
      })
    );

    log.info("Assistant architects retrieved successfully", {
      count: architectsWithRelations.length
    })
    
    timer({ status: "success", count: architectsWithRelations.length })
    
    return createSuccess(architectsWithRelations, "Assistant architects retrieved successfully");
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get assistant architects. Please try again or contact support.", {
      context: "getAssistantArchitects",
      requestId,
      operation: "getAssistantArchitects"
    });
  }
}

export async function getAssistantArchitectByIdAction(
  id: string
): Promise<ActionState<ArchitectWithRelations | undefined>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAssistantArchitectById")
  const log = createLogger({ requestId, action: "getAssistantArchitectById" })
  
  try {
    log.info("Action started: Getting assistant architect by ID", { architectId: id })
    
    // Parse string ID to integer
    const idInt = parseInt(id, 10);
    if (isNaN(idInt)) {
      log.warn("Invalid assistant architect ID provided", { architectId: id })
      throw createError("Invalid assistant architect ID", {
        code: "VALIDATION",
        level: ErrorLevel.WARN,
        details: { id }
      });
    }

    const architectResult = await executeSQL<RawDbRow>(`
      SELECT id, name, description, status, image_path, user_id, created_at, updated_at
      FROM assistant_architects
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: idInt } }]);

    if (!architectResult || architectResult.length === 0) {
      throw createError("Assistant architect not found", {
        code: "NOT_FOUND",
        level: ErrorLevel.WARN,
        details: { id }
      });
    }

    const architect = transformSnakeToCamel<SelectAssistantArchitect>(architectResult[0]);
    
    // Get input fields and prompts using data API
    const [inputFieldsRaw, promptsRaw] = await Promise.all([
      executeSQL<RawDbRow>(`
        SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
        FROM tool_input_fields
        WHERE assistant_architect_id = :toolId
        ORDER BY position ASC
      `, [{ name: 'toolId', value: { longValue: idInt } }]),
      executeSQL<RawDbRow>(`
        SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, repository_ids, enabled_tools, created_at, updated_at
        FROM chain_prompts
        WHERE assistant_architect_id = :toolId
        ORDER BY position ASC
      `, [{ name: 'toolId', value: { longValue: idInt } }])
    ]);

    // Transform snake_case to camelCase for frontend compatibility
    const transformedInputFields = (inputFieldsRaw || []).map((field) => transformSnakeToCamel<SelectToolInputField>(field));
    const transformedPrompts = (promptsRaw || []).map(transformPrompt);

    const architectWithRelations: ArchitectWithRelations = {
      ...architect,
      inputFields: transformedInputFields,
      prompts: transformedPrompts
    };

    return createSuccess(architectWithRelations, "Assistant architect retrieved successfully");
  } catch (error) {
    return handleError(error, "Failed to get assistant architect", {
      context: "getAssistantArchitectByIdAction"
    });
  }
}

export async function getPendingAssistantArchitectsAction(): Promise<
  ActionState<SelectAssistantArchitect[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getPendingAssistantArchitects")
  const log = createLogger({ requestId, action: "getPendingAssistantArchitects" })
  
  try {
    log.info("Action started: Getting pending assistant architects")
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized pending assistant architects access attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Check if user is an administrator using Cognito sub
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can view pending tools" }
    }

    // Get pending tools using data API
    const pendingTools = await executeSQL<RawDbRow>(`
      SELECT id, name, description, status, image_path, user_id, created_at, updated_at
      FROM assistant_architects
      WHERE status = 'pending_approval'
      ORDER BY created_at DESC
    `);

    // For each tool, get its input fields and prompts
    const toolsWithRelations = await Promise.all(
      pendingTools.map(async (tool: RawDbRow) => {
        const [inputFieldsRaw, promptsRaw] = await Promise.all([
          executeSQL<RawDbRow>(`
            SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
            FROM tool_input_fields
            WHERE assistant_architect_id = :toolId
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(tool.id) } }]),
          executeSQL<RawDbRow>(`
            SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, repository_ids, enabled_tools, created_at, updated_at
            FROM chain_prompts
            WHERE assistant_architect_id = :toolId
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(tool.id) } }])
        ]);

        const transformedTool = transformSnakeToCamel<SelectAssistantArchitect>(tool);
        const inputFields = inputFieldsRaw.map((field) => transformSnakeToCamel<SelectToolInputField>(field));
        const prompts = promptsRaw.map(transformPrompt);

        return {
          ...transformedTool,
          inputFields: inputFields || [],
          prompts: prompts || []
        };
      })
    );

    log.info("Pending assistant architects retrieved successfully", {
      count: toolsWithRelations.length
    })
    timer({ status: "success", count: toolsWithRelations.length })
    
    return {
      isSuccess: true,
      message: "Pending Assistant Architects retrieved successfully",
      data: toolsWithRelations
    };
  } catch (error) {
    timer({ status: "error" })
    log.error("Error getting pending Assistant Architects:", error);
    return { isSuccess: false, message: "Failed to get pending Assistant Architects" };
  }
}

export async function updateAssistantArchitectAction(
  id: string,
  data: Partial<InsertAssistantArchitect>
): Promise<ActionState<SelectAssistantArchitect>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateAssistantArchitect")
  const log = createLogger({ requestId, action: "updateAssistantArchitect" })
  
  try {
    log.info("Action started: Updating assistant architect", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect update attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    // Get the current tool using data API
    const currentToolResult = await executeSQL<RawDbRow>(`
      SELECT id, name, description, status, image_path, user_id, created_at, updated_at
      FROM assistant_architects
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);
    
    if (!currentToolResult || currentToolResult.length === 0) {
      return { isSuccess: false, message: "Assistant not found" }
    }
    
    const currentTool = currentToolResult[0];
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    
    // Get the current user's database ID
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data) {
      return { isSuccess: false, message: "User not found" }
    }
    
    const isCreator = currentTool.user_id === currentUser.data.user.id
    if (!isAdmin && !isCreator) {
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    // If the tool was approved and is being edited, set status to pending_approval and deactivate it in the tools table
    if (currentTool.status === "approved") {
      data.status = "pending_approval"
      await executeSQL<never>(`
        UPDATE tools 
        SET is_active = false 
        WHERE assistant_architect_id = :id
      `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);
    }
    
    // Build update query dynamically
    const updateFields = [];
    const parameters: SqlParameter[] = [{ name: 'id', value: { longValue: parseInt(id, 10) } }];
    let paramIndex = 0;
    
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        const snakeKey = key === 'imagePath' ? 'image_path' : key === 'userId' ? 'user_id' : key;
        // Add type cast for status field
        if (key === 'status') {
          updateFields.push(`${snakeKey} = :param${paramIndex}::tool_status`);
        } else {
          updateFields.push(`${snakeKey} = :param${paramIndex}`);
        }
        
        let paramValue: SqlParameter['value'];
        if (value === null) {
          paramValue = { isNull: true };
        } else if (key === 'userId' && typeof value === 'number') {
          paramValue = { longValue: value };
        } else {
          paramValue = { stringValue: String(value) };
        }
        
        parameters.push({ 
          name: `param${paramIndex}`, 
          value: paramValue
        });
        paramIndex++;
      }
    }
    
    if (updateFields.length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }
    
    const updatedToolResult = await executeSQL<SelectAssistantArchitect>(`
      UPDATE assistant_architects 
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE id = :id
      RETURNING id, name, description, status, image_path, user_id, created_at, updated_at
    `, parameters);
    
    const updatedToolRaw = updatedToolResult[0];
    
    log.info("Assistant architect updated successfully", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Assistant updated successfully",
      data: transformSnakeToCamel<SelectAssistantArchitect>(updatedToolRaw)
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error updating assistant:", error)
    return { isSuccess: false, message: "Failed to update assistant" }
  }
}

export async function deleteAssistantArchitectAction(
  id: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteAssistantArchitect")
  const log = createLogger({ requestId, action: "deleteAssistantArchitect" })
  
  try {
    log.info("Action started: Deleting assistant architect", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect deletion attempt")
      timer({ status: "error" })
      return { isSuccess: false, message: "Please sign in to delete assistants" }
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    // Parse and validate the ID
    const idInt = parseInt(id, 10);
    if (isNaN(idInt)) {
      log.warn("Invalid assistant architect ID provided", { id })
      timer({ status: "error" })
      return { isSuccess: false, message: "Invalid assistant ID" }
    }
    
    // Get assistant details to check ownership and status
    const architectResult = await executeSQL<{ user_id: number, status: string }>(`
      SELECT user_id, status
      FROM assistant_architects
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: idInt } }]);
    
    if (!architectResult || architectResult.length === 0) {
      log.warn("Assistant architect not found", { id })
      timer({ status: "error" })
      return { isSuccess: false, message: "Assistant not found" }
    }
    
    const architect = architectResult[0];
    log.debug("Assistant architect retrieved", { 
      id,
      status: architect.status,
      ownerId: architect.user_id 
    })
    
    // Check if the assistant can be deleted based on status
    if (architect.status !== 'draft' && architect.status !== 'rejected') {
      log.warn("Attempted to delete non-deletable assistant", { 
        id,
        status: architect.status 
      })
      timer({ status: "error" })
      return { 
        isSuccess: false, 
        message: "Only draft or rejected assistants can be deleted" 
      }
    }
    
    // Get current user to check ownership
    const { getCurrentUserAction } = await import("@/actions/db/get-current-user-action");
    const currentUserResult = await getCurrentUserAction();
    
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      log.error("Failed to get current user information")
      timer({ status: "error" })
      return { isSuccess: false, message: "Failed to verify user identity" }
    }
    
    const currentUser = currentUserResult.data.user;
    const isOwner = architect.user_id === currentUser.id;
    
    // Check if user has user-management or role-management access (admin privileges)
    const hasUserManagement = await hasToolAccess(session.sub, "user-management");
    const hasRoleManagement = await hasToolAccess(session.sub, "role-management");
    const isAdmin = hasUserManagement || hasRoleManagement;
    
    log.debug("Permission check", { 
      userId: currentUser.id,
      assistantOwnerId: architect.user_id,
      isOwner,
      isAdmin,
      hasUserManagement,
      hasRoleManagement
    })
    
    // Check permissions: owner OR admin can delete
    if (!isOwner && !isAdmin) {
      log.warn("Unauthorized deletion attempt", { 
        userId: currentUser.id,
        assistantId: id,
        ownerId: architect.user_id 
      })
      timer({ status: "error" })
      return { 
        isSuccess: false, 
        message: "You can only delete your own assistants" 
      }
    }
    
    // Proceed with deletion
    log.info("Deleting assistant architect", { 
      id,
      deletedBy: currentUser.id,
      isOwnerDeletion: isOwner,
      isAdminDeletion: !isOwner && isAdmin,
      hasUserManagement,
      hasRoleManagement
    })
    
    // Delete from tools table (using prompt_chain_tool_id which references assistant_architect)
    await executeSQL<never>(`
      DELETE FROM tools
      WHERE prompt_chain_tool_id = :id
    `, [{ name: 'id', value: { longValue: idInt } }]);
    
    // Delete from navigation_items
    await executeSQL<never>(`
      DELETE FROM navigation_items
      WHERE link = :link
    `, [{ name: 'link', value: { stringValue: `/tools/assistant-architect/${id}` } }]);
    
    // Use the deleteAssistantArchitect function which handles all the cascade deletes properly
    const { deleteAssistantArchitect } = await import("@/lib/db/data-api-adapter");
    await deleteAssistantArchitect(idInt);

    log.info("Assistant architect deleted successfully", { 
      id,
      deletedBy: currentUser.id,
      wasOwnerDeletion: isOwner 
    })
    timer({ status: "success", id })

    return {
      isSuccess: true,
      message: "Assistant architect deleted successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error deleting assistant architect:", error)
    return { isSuccess: false, message: "Failed to delete assistant architect" }
  }
}

// Input Field Management Actions

export async function addToolInputFieldAction(
  architectId: string,
  data: { 
    name: string; 
    label?: string;
    type: string;
    position?: number;
    options?: { label: string; value: string }[];
  }
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("addToolInputField")
  const log = createLogger({ requestId, action: "addToolInputField" })
  
  try {
    log.info("Action started: Adding tool input field", { architectId, fieldName: data.name })
    await executeSQL<never>(`
      INSERT INTO tool_input_fields (assistant_architect_id, name, label, field_type, position, options, created_at, updated_at)
      VALUES (:toolId, :name, :label, :fieldType::field_type, :position, :options, NOW(), NOW())
    `, [
      { name: 'toolId', value: { longValue: parseInt(architectId, 10) } },
      { name: 'name', value: { stringValue: data.name } },
      { name: 'label', value: { stringValue: data.label ?? data.name } },
      { name: 'fieldType', value: { stringValue: data.type } },
      { name: 'position', value: { longValue: data.position ?? 0 } },
      { name: 'options', value: data.options ? { stringValue: JSON.stringify(data.options) } : { isNull: true } }
    ]);

    log.info("Tool input field added successfully", { architectId, fieldName: data.name })
    timer({ status: "success", architectId })
    
    return {
      isSuccess: true,
      message: "Tool input field added successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error adding tool input field:", error)
    return { isSuccess: false, message: "Failed to add tool input field" }
  }
}

export async function deleteInputFieldAction(
  fieldId: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteInputField")
  const log = createLogger({ requestId, action: "deleteInputField" })
  
  try {
    log.info("Action started: Deleting input field", { fieldId })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized input field deletion attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Get the field to find its tool using data API
    const fieldResult = await executeSQL<RawDbRow>(`
      SELECT id, assistant_architect_id
      FROM tool_input_fields
      WHERE id = :fieldId
    `, [{ name: 'fieldId', value: { longValue: parseInt(fieldId, 10) } }]);

    if (!fieldResult || fieldResult.length === 0) {
      return { isSuccess: false, message: "Input field not found" }
    }

    const field = fieldResult[0];

    // Check if user is the creator of the tool
    const toolResult = await executeSQL<RawDbRow>(`
      SELECT user_id
      FROM assistant_architects
      WHERE id = :toolId
    `, [{ name: 'toolId', value: { longValue: Number((field as SelectToolInputField & { assistant_architect_id?: number }).assistant_architect_id || field.assistantArchitectId) } }]);

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0];

    // Check permissions
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) {
      return { isSuccess: false, message: "User not found" }
    }
    if (!isAdmin && tool.user_id !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Delete the field
    await executeSQL<never>(`
      DELETE FROM tool_input_fields
      WHERE id = :fieldId
    `, [{ name: 'fieldId', value: { longValue: parseInt(fieldId, 10) } }]);

    log.info("Input field deleted successfully", { fieldId })
    timer({ status: "success", fieldId })

    return {
      isSuccess: true,
      message: "Input field deleted successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error deleting input field:", error)
    return { isSuccess: false, message: "Failed to delete input field" }
  }
}

export async function updateInputFieldAction(
  id: string,
  data: Partial<InsertToolInputField>
): Promise<ActionState<SelectToolInputField>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateInputField")
  const log = createLogger({ requestId, action: "updateInputField" })
  
  try {
    log.info("Action started: Updating input field", { id, data })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized input field update attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Find the field using data API
    const fieldResult = await executeSQL<SelectToolInputField>(`
      SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
      FROM tool_input_fields
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    if (!fieldResult || fieldResult.length === 0) {
      return { isSuccess: false, message: "Input field not found" }
    }

    const field = fieldResult[0];

    // Get the tool to check permissions
    const toolResult = await executeSQL<RawDbRow>(`
      SELECT user_id
      FROM assistant_architects
      WHERE id = :toolId
    `, [{ name: 'toolId', value: { longValue: Number((field as SelectToolInputField & { assistant_architect_id?: number }).assistant_architect_id || field.assistantArchitectId) } }]);

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0];

    // Only tool creator or admin can update fields
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) {
      return { isSuccess: false, message: "User not found" }
    }
    if (!isAdmin && tool.user_id !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Build update query dynamically
    const updateFields = [];
    const parameters: SqlParameter[] = [{ name: 'id', value: { longValue: parseInt(id, 10) } }];
    let paramIndex = 0;
    
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        const snakeKey = key === 'fieldType' ? 'field_type' : key === 'toolId' ? 'assistant_architect_id' : key;
        if (key === 'fieldType') {
          updateFields.push(`${snakeKey} = :param${paramIndex}::field_type`);
        } else {
          updateFields.push(`${snakeKey} = :param${paramIndex}`);
        }
        
        let paramValue;
        if (value === null) {
          paramValue = { isNull: true };
        } else if (typeof value === 'number') {
          paramValue = { longValue: value };
        } else if (typeof value === 'object') {
          // Special handling for arrays and objects
          if (value === null) {
            paramValue = { isNull: true };
          } else if (Array.isArray(value)) {
            if (value.length === 0) {
              paramValue = { isNull: true };
            } else {
              // Make sure all array elements are defined
              const cleanArray = value.filter(v => v !== undefined);
              paramValue = { stringValue: JSON.stringify(cleanArray) };
            }
          } else {
            // For non-array objects, stringify them
            paramValue = { stringValue: JSON.stringify(value) };
          }
        } else {
          paramValue = { stringValue: String(value) };
        }
        
        parameters.push({ name: `param${paramIndex}`, value: paramValue });
        paramIndex++;
      }
    }
    
    // Always ensure label is set
    if (!data.label && data.name) {
      updateFields.push(`label = :labelParam`);
      parameters.push({ name: 'labelParam', value: { stringValue: String(data.name) } });
    }
    
    if (updateFields.length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    const updatedFieldResult = await executeSQL<RawDbRow>(`
      UPDATE tool_input_fields 
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE id = :id
      RETURNING id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
    `, parameters);

    log.info("Input field updated successfully", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Input field updated successfully",
      data: transformSnakeToCamel<SelectToolInputField>(updatedFieldResult[0])
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error updating input field:", error)
    return { isSuccess: false, message: "Failed to update input field" }
  }
}

export async function reorderInputFieldsAction(
  toolId: string,
  fieldOrders: { id: string; position: number }[]
): Promise<ActionState<SelectToolInputField[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("reorderInputFields")
  const log = createLogger({ requestId, action: "reorderInputFields" })
  
  try {
    log.info("Action started: Reordering input fields", { toolId, fieldCount: fieldOrders.length })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized input fields reorder attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Get the tool to check permissions
    const toolResult = await executeSQL<RawDbRow>(`
      SELECT user_id
      FROM assistant_architects
      WHERE id = :toolId
    `, [{ name: 'toolId', value: { longValue: parseInt(toolId, 10) } }]);

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0];

    // Only tool creator or admin can reorder fields
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) {
      return { isSuccess: false, message: "User not found" }
    }
    if (!isAdmin && tool.user_id !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Update each field's position
    const updatedFields = await Promise.all(
      fieldOrders.map(async ({ id, position }) => {
        const result = await executeSQL<RawDbRow>(`
          UPDATE tool_input_fields
          SET position = :position, updated_at = NOW()
          WHERE id = :id
          RETURNING id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
        `, [
          { name: 'position', value: { longValue: position } },
          { name: 'id', value: { longValue: parseInt(id, 10) } }
        ]);
        return transformSnakeToCamel<SelectToolInputField>(result[0]);
      })
    )

    log.info("Input fields reordered successfully", { toolId, count: updatedFields.length })
    timer({ status: "success", toolId })
    
    return {
      isSuccess: true,
      message: "Input fields reordered successfully",
      data: updatedFields
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error reordering input fields:", error)
    return { isSuccess: false, message: "Failed to reorder input fields" }
  }
}

// Chain Prompt Management Actions

export async function addChainPromptAction(
  architectId: string,
  data: {
    name: string
    content: string
    systemContext?: string
    modelId: number
    position: number
    inputMapping?: Record<string, string>
    repositoryIds?: number[]
    enabledTools?: string[]
  }
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("addChainPrompt")
  const log = createLogger({ requestId, action: "addChainPrompt" })
  
  try {
    log.info("Action started: Adding chain prompt", { architectId, promptName: data.name })

    // Validate enabled tools if provided
    if (data.enabledTools && data.enabledTools.length > 0) {
      const toolValidation = await validateEnabledTools(data.enabledTools, data.modelId);
      if (!toolValidation.isValid) {
        log.warn("Invalid tools provided", { invalidTools: toolValidation.invalidTools, message: toolValidation.message });
        return {
          isSuccess: false,
          message: toolValidation.message || `Invalid tools: ${toolValidation.invalidTools.join(', ')}`
        };
      }
    }

    // If repository IDs are provided, validate user has access
    if (data.repositoryIds && data.repositoryIds.length > 0) {
      const session = await getServerSession();
      if (!session || !session.sub) {
        return { isSuccess: false, message: "Unauthorized" };
      }

      const hasAccess = await hasToolAccess(session.sub, "knowledge-repositories");
      if (!hasAccess) {
        return { isSuccess: false, message: "Access denied. You need knowledge repository access." };
      }
    }

    await executeSQL<never>(`
      INSERT INTO chain_prompts (assistant_architect_id, name, content, system_context, model_id, position, input_mapping, repository_ids, enabled_tools, created_at, updated_at)
      VALUES (:toolId, :name, :content, :systemContext, :modelId, :position, :inputMapping::jsonb, :repositoryIds::jsonb, :enabledTools::jsonb, NOW(), NOW())
    `, [
      { name: 'toolId', value: { longValue: safeParseInt(architectId, 'architectId') } },
      { name: 'name', value: { stringValue: data.name } },
      { name: 'content', value: { stringValue: data.content } },
      { name: 'systemContext', value: data.systemContext ? { stringValue: data.systemContext } : { isNull: true } },
      { name: 'modelId', value: { longValue: data.modelId } },
      { name: 'position', value: { longValue: data.position } },
      { name: 'inputMapping', value: data.inputMapping ? { stringValue: JSON.stringify(data.inputMapping) } : { isNull: true } },
      { name: 'repositoryIds', value: { stringValue: serializeRepositoryIds(data.repositoryIds) || '[]' } },
      { name: 'enabledTools', value: { stringValue: JSON.stringify(data.enabledTools || []) } }
    ]);

    log.info("Chain prompt added successfully", { architectId })
    timer({ status: "success", architectId })
    
    return {
      isSuccess: true,
      message: "Chain prompt added successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error adding chain prompt:", error)
    return { isSuccess: false, message: "Failed to add chain prompt" }
  }
}

export async function updatePromptAction(
  id: string,
  data: Partial<InsertChainPrompt>
): Promise<ActionState<SelectChainPrompt>> {
  const requestId = generateRequestId()
  const timer = startTimer("updatePrompt")
  const log = createLogger({ requestId, action: "updatePrompt" })
  
  try {
    log.info("Action started: Updating prompt", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized prompt update attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Find the prompt using data API
    const promptResult = await executeSQL<RawDbRow>(`
      SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, parallel_group, timeout_seconds, repository_ids, enabled_tools, created_at, updated_at
      FROM chain_prompts
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    if (!promptResult || promptResult.length === 0) {
      return { isSuccess: false, message: "Prompt not found" }
    }

    const prompt = promptResult[0];
    
    
    // executeSQL converts snake_case to camelCase, so use assistantArchitectId
    const assistantArchitectId = prompt.assistantArchitectId;
    
    if (!assistantArchitectId) {
      return { isSuccess: false, message: "Invalid prompt - missing assistant architect reference" };
    }

    // Get the tool to check permissions
    const toolResult = await executeSQL<{ userId: number }>(`
      SELECT user_id
      FROM assistant_architects
      WHERE id = :toolId
    `, [{ name: 'toolId', value: { longValue: Number(assistantArchitectId) } }]);

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0];

    // Only tool creator or admin can update prompts
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")

    // Get current user with proper error handling
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data?.user?.id) {
      log.error("Failed to get current user for authorization check");
      throw ErrorFactories.authNoSession();
    }

    const currentUserId = currentUser.data.user.id;
    if (!isAdmin && tool.userId !== currentUserId) {
      log.warn("Authorization failed - user doesn't own resource", {
        userId: currentUserId,
        resourceOwnerId: tool.userId,
        isAdmin
      });
      throw ErrorFactories.authzToolAccessDenied("assistant_architect");
    }

    // Validate enabled tools if being updated
    if (data.enabledTools) {
      // Use provided modelId or fall back to existing prompt's modelId
      const modelIdToValidate = data.modelId || prompt.modelId;
      if (modelIdToValidate) {
        const toolValidation = await validateEnabledTools(data.enabledTools, Number(modelIdToValidate));
        if (!toolValidation.isValid) {
          log.warn("Invalid tools provided for update", { invalidTools: toolValidation.invalidTools, message: toolValidation.message });
          return {
            isSuccess: false,
            message: toolValidation.message || `Invalid tools: ${toolValidation.invalidTools.join(', ')}`
          };
        }
      }
    }

    // If repository IDs are being updated, validate user has access
    if (data.repositoryIds && data.repositoryIds.length > 0) {
      const hasAccess = await hasToolAccess(session.sub, "knowledge-repositories");
      if (!hasAccess) {
        return { isSuccess: false, message: "Access denied. You need knowledge repository access." };
      }
    }
    
    // Clean up data object - remove undefined or null for array fields
    // But keep empty arrays so they can be saved to clear the field
    if ('repositoryIds' in data) {
      if (data.repositoryIds === undefined || data.repositoryIds === null) {
        // Remove the key entirely if it's undefined or null
        delete data.repositoryIds;
      }
      // Keep empty arrays - they should be saved as '[]' in the database
    }

    if ('enabledTools' in data) {
      if (data.enabledTools === undefined || data.enabledTools === null) {
        // Remove the key entirely if it's undefined or null
        delete data.enabledTools;
      }
      // Keep empty arrays - they should be saved as '[]' in the database
    }

    // Build update query dynamically
    const updateFields = [];
    const parameters: SqlParameter[] = [];
    let paramIndex = 0;
    
    
    // Filter out undefined values before processing
    const definedEntries = Object.entries(data).filter(([_, value]) => value !== undefined);
    
    for (const [key, value] of definedEntries) {
        
        const snakeKey = key === 'toolId' ? 'assistant_architect_id' :
                        key === 'systemContext' ? 'system_context' :
                        key === 'modelId' ? 'model_id' :
                        key === 'inputMapping' ? 'input_mapping' :
                        key === 'repositoryIds' ? 'repository_ids' :
                        key === 'enabledTools' ? 'enabled_tools' : key;
        
        // Add JSONB cast for JSON columns
        if (key === 'inputMapping' || key === 'repositoryIds' || key === 'enabledTools') {
          updateFields.push(`${snakeKey} = :param${paramIndex}::jsonb`);
        } else {
          updateFields.push(`${snakeKey} = :param${paramIndex}`);
        }
        
        let paramValue;
        if (value === null) {
          paramValue = { isNull: true };
        } else if (typeof value === 'number') {
          paramValue = { longValue: value };
        } else if (typeof value === 'boolean') {
          paramValue = { booleanValue: value };
        } else if (typeof value === 'string') {
          // Ensure string is not empty
          paramValue = { stringValue: value || '' };
        } else if (typeof value === 'object') {
          // Special handling for arrays and objects
          if (key === 'repositoryIds' && Array.isArray(value)) {
            // Use the serialization utility for repository IDs
            paramValue = { stringValue: serializeRepositoryIds(value) || '[]' };
          } else if (key === 'enabledTools' && Array.isArray(value)) {
            // Validate array elements and prevent prototype pollution
            const safeArray = value.filter(item => {
              if (typeof item !== 'string') return false;
              // Prevent dangerous patterns in tool names
              const dangerousPatterns = ['__proto__', 'constructor', 'prototype'];
              return !dangerousPatterns.some(pattern => item.includes(pattern));
            });
            const jsonString = JSON.stringify(safeArray);
            if (jsonString.length > 10000) {
              throw new Error('Enabled tools array too large');
            }
            paramValue = { stringValue: jsonString };
          } else if (Array.isArray(value)) {
            // Always stringify arrays, even empty ones
            // This ensures empty arrays are stored as '[]' not NULL
            const cleanArray = value.filter(v => v !== undefined);
            paramValue = { stringValue: JSON.stringify(cleanArray) };
          } else {
            // For non-array objects, stringify them
            paramValue = { stringValue: JSON.stringify(value) };
          }
        } else {
          paramValue = { stringValue: String(value) };
        }
        
        const param = { name: `param${paramIndex}`, value: paramValue };
        parameters.push(param);
        paramIndex++;
    }
    
    if (updateFields.length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    // Add the id parameter at the end
    parameters.push({ name: 'id', value: { longValue: parseInt(id, 10) } });
    

    const sql = `UPDATE chain_prompts SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = :id RETURNING id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, parallel_group, timeout_seconds, repository_ids, enabled_tools, created_at, updated_at`;
    
    const updatedPromptResult = await executeSQL(sql, parameters);

    log.info("Prompt updated successfully", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Prompt updated successfully",
      data: transformPrompt(updatedPromptResult[0])
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error updating prompt:", error)
    return { isSuccess: false, message: "Failed to update prompt" }
  }
}

export async function deletePromptAction(
  id: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deletePrompt")
  const log = createLogger({ requestId, action: "deletePrompt" })
  
  try {
    log.info("Action started: Deleting prompt", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized prompt deletion attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Find the prompt using data API
    const promptResult = await executeSQL<{ assistantArchitectId: number }>(`
      SELECT assistant_architect_id
      FROM chain_prompts
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    if (!promptResult || promptResult.length === 0) {
      return { isSuccess: false, message: "Prompt not found" }
    }

    const prompt = promptResult[0];

    // Get the tool to check permissions
    const toolResult = await executeSQL<{ userId: number }>(`
      SELECT user_id
      FROM assistant_architects
      WHERE id = :toolId
    `, [{ name: 'toolId', value: { longValue: prompt.assistantArchitectId } }]);

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0];

    // Only tool creator or admin can delete prompts
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) {
      return { isSuccess: false, message: "User not found" }
    }
    if (!isAdmin && tool.userId !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Delete the prompt
    await executeSQL<never>(`
      DELETE FROM chain_prompts
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    log.info("Prompt deleted successfully", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Prompt deleted successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error deleting prompt:", error)
    return { isSuccess: false, message: "Failed to delete prompt" }
  }
}

export async function updatePromptPositionAction(
  id: string,
  position: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("updatePromptPosition")
  const log = createLogger({ requestId, action: "updatePromptPosition" })
  
  try {
    log.info("Action started: Updating prompt position", { id, position })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized prompt position update attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const userId = await getCurrentUserId();
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    // Find the prompt
    const promptResult = await executeSQL(
      `SELECT assistant_architect_id FROM chain_prompts WHERE id = :id`,
      [{ name: 'id', value: { longValue: parseInt(id, 10) } }]
    )

    if (!promptResult || promptResult.length === 0) {
      return { isSuccess: false, message: "Prompt not found" }
    }

    const prompt = promptResult[0] as RawDbRow;
    const toolId = prompt.assistant_architect_id;

    // Get the tool to check permissions
    const toolResult = await executeSQL(
      `SELECT user_id FROM assistant_architects WHERE id = :id`,
      [{ name: 'id', value: { longValue: Number(toolId) } }]
    )

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0] as RawDbRow;
    const toolUserId = tool.user_id;

    // Only tool creator or admin can update prompt positions
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator");
    if (!isAdmin && toolUserId !== userId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Update the prompt's position
    await executeSQL<never>(
      `UPDATE chain_prompts SET position = :position WHERE id = :id`,
      [
        { name: 'position', value: { longValue: position } },
        { name: 'id', value: { longValue: parseInt(id, 10) } }
      ]
    )

    log.info("Prompt position updated successfully", { id, position })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Prompt position updated successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error updating prompt position:", error)
    return { isSuccess: false, message: "Failed to update prompt position" }
  }
}

// Tool Execution Actions

export async function createToolExecutionAction(
  execution: InsertToolExecution
): Promise<ActionState<string>> {
  const requestId = generateRequestId()
  const timer = startTimer("createToolExecution")
  const log = createLogger({ requestId, action: "createToolExecution" })
  
  try {
    log.info("Action started: Creating tool execution", { 
      toolId: execution.assistantArchitectId 
    })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized tool execution attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const userId = await getCurrentUserId();
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    execution.userId = userId

    const [executionResult] = await executeSQL<{ id: string }>(
      `INSERT INTO tool_executions (assistant_architect_id, user_id, input_data, status, started_at) 
       VALUES (:toolId, :userId, :inputData, :status, NOW())
       RETURNING id`,
      [
        { name: 'toolId', value: { longValue: execution.assistantArchitectId } },
        { name: 'userId', value: { longValue: execution.userId } },
        { name: 'inputData', value: { stringValue: JSON.stringify(execution.inputData || {}) } },
        { name: 'status', value: { stringValue: 'pending' } }
      ]
    )
    
    const executionId = Number(executionResult?.id)

    log.info("Tool execution created successfully", { executionId })
    timer({ status: "success", executionId })
    
    return {
      isSuccess: true,
      message: "Tool execution created successfully",
      data: executionId.toString()
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error creating tool execution:", error)
    return { isSuccess: false, message: "Failed to create tool execution" }
  }
}

export async function updatePromptResultAction(
  executionId: string,
  promptId: number,
  result: Record<string, any>
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("updatePromptResult")
  const log = createLogger({ requestId, action: "updatePromptResult" })
  
  try {
    log.info("Action started: Updating prompt result", { executionId, promptId })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized prompt result update attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const userId = await getCurrentUserId();
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    const updates: { name: string; value: SqlParameter['value'] }[] = []
    const setClauses: string[] = []

    if (result.result !== undefined) {
      setClauses.push('result = :result')
      updates.push({ name: 'result', value: { stringValue: result.result } })
    }
    if (result.error !== undefined) {
      setClauses.push('error = :error')
      updates.push({ name: 'error', value: { stringValue: result.error } })
    }
    if (result.executionTime !== undefined) {
      setClauses.push('execution_time = :executionTime')
      updates.push({ name: 'executionTime', value: { longValue: result.executionTime } })
    }
    if (result.tokensUsed !== undefined) {
      setClauses.push('tokens_used = :tokensUsed')
      updates.push({ name: 'tokensUsed', value: { longValue: result.tokensUsed } })
    }

    if (setClauses.length === 0) {
      return { isSuccess: true, message: "No updates to apply", data: undefined }
    }

    updates.push(
      { name: 'executionId', value: { longValue: parseInt(executionId, 10) } },
      { name: 'promptId', value: { longValue: promptId } }
    )

    await executeSQL<never>(
      `UPDATE prompt_results SET ${setClauses.join(', ')} 
       WHERE execution_id = :executionId AND prompt_id = :promptId`,
      updates
    )

    log.info("Prompt result updated successfully", { executionId, promptId })
    timer({ status: "success", executionId })
    
    return {
      isSuccess: true,
      message: "Prompt result updated successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error updating prompt result:", error)
    return { isSuccess: false, message: "Failed to update prompt result" }
  }
}

// Tool Approval Actions

export async function approveAssistantArchitectAction(
  id: string
): Promise<ActionState<SelectAssistantArchitect>> {
  const requestId = generateRequestId()
  const timer = startTimer("approveAssistantArchitect")
  const log = createLogger({ requestId, action: "approveAssistantArchitect" })
  
  try {
    log.info("Action started: Approving assistant architect", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect approval attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Check if user is an administrator
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can approve tools" }
    }

    // Update the tool status to approved
    const updatedToolResult = await executeSQL<RawDbRow>(`
      UPDATE assistant_architects
      SET status = 'approved'::tool_status, updated_at = NOW()
      WHERE id = :id
      RETURNING id, name, description, status, image_path, user_id, created_at, updated_at
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);
    
    if (!updatedToolResult || updatedToolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }
    
    const updatedTool = transformSnakeToCamel<SelectAssistantArchitect>(updatedToolResult[0]);
    
    // Check if tool already exists in tools table
    const existingToolResult = await executeSQL<{ id: string }>(`
      SELECT id FROM tools WHERE assistant_architect_id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);
    
    let identifier = generateToolIdentifier(updatedTool.name);
    let finalToolId: string;
    
    if (existingToolResult && existingToolResult.length > 0) {
      // Update existing tool
      await executeSQL<never>(`
        UPDATE tools
        SET identifier = :identifier, name = :name, description = :description, is_active = true, updated_at = NOW()
        WHERE assistant_architect_id = :id
      `, [
        { name: 'identifier', value: { stringValue: identifier } },
        { name: 'name', value: { stringValue: updatedTool.name } },
        { name: 'description', value: { stringValue: updatedTool.description || '' } },
        { name: 'id', value: { longValue: parseInt(id, 10) } }
      ]);
      finalToolId = existingToolResult[0].id as string;
    } else {
      // Check for duplicate identifier
      const duplicateResult = await executeSQL<{ id: string }>(`
        SELECT id FROM tools WHERE identifier = :identifier
      `, [{ name: 'identifier', value: { stringValue: identifier } }]);
      
      if (duplicateResult && duplicateResult.length > 0) {
        identifier = `${identifier}-${Date.now()}`;
      }
      
      // Create new tool
      const newToolResult = await executeSQL<{ id: string }>(`
        INSERT INTO tools (id, identifier, name, description, is_active, assistant_architect_id, created_at, updated_at)
        VALUES (:identifier, :identifier, :name, :description, true, :assistantArchitectId, NOW(), NOW())
        RETURNING id
      `, [
        { name: 'identifier', value: { stringValue: identifier } },
        { name: 'name', value: { stringValue: updatedTool.name } },
        { name: 'description', value: { stringValue: updatedTool.description || '' } },
        { name: 'assistantArchitectId', value: { longValue: parseInt(id, 10) } }
      ]);
      finalToolId = newToolResult[0].id as string;
    }
    
    // Create navigation item if it doesn't exist
    const navLink = `/tools/assistant-architect/${id}`;
    const existingNavResult = await executeSQL<{ id: string }>(`
      SELECT id FROM navigation_items WHERE parent_id = 'experiments' AND link = :link
    `, [{ name: 'link', value: { stringValue: navLink } }]);
    
    if (!existingNavResult || existingNavResult.length === 0) {
      const baseNavId = generateToolIdentifier(updatedTool.name);
      let navId = baseNavId;
      let navSuffix = 2;
      
      // Check for unique navigation ID
      let navExists = true;
      while (navExists) {
        const navCheckResult = await executeSQL<{ id: string }>(`
          SELECT id FROM navigation_items WHERE id = :navId
        `, [{ name: 'navId', value: { stringValue: navId } }]);
        
        if (!navCheckResult || navCheckResult.length === 0) {
          navExists = false;
        } else {
          navId = `${baseNavId}-${navSuffix++}`;
        }
      }
      
      await executeSQL<never>(`
        INSERT INTO navigation_items (id, label, icon, link, type, parent_id, tool_id, is_active, created_at)
        VALUES (:navId, :label, 'IconWand', :link, 'link', 'experiments', :toolId, true, NOW())
      `, [
        { name: 'navId', value: { stringValue: navId } },
        { name: 'label', value: { stringValue: updatedTool.name } },
        { name: 'link', value: { stringValue: navLink } },
        { name: 'toolId', value: { stringValue: finalToolId } }
      ]);
    }
    
    // Assign tool to staff and administrator roles
    const rolesResult = await executeSQL<{ id: string; name: string }>(`
      SELECT id, name FROM roles WHERE name IN ('staff', 'administrator')
    `);
    
    for (const role of rolesResult) {
      // Check if assignment already exists
      const existingAssignmentResult = await executeSQL<{ '?column?': number }>(`
        SELECT 1 FROM role_tools WHERE role_id = :roleId AND tool_id = :toolId
      `, [
        { name: 'roleId', value: { stringValue: role.id } },
        { name: 'toolId', value: { stringValue: finalToolId } }
      ]);
      
      if (!existingAssignmentResult || existingAssignmentResult.length === 0) {
        await executeSQL<never>(`
          INSERT INTO role_tools (role_id, tool_id, created_at)
          VALUES (:roleId, :toolId, NOW())
        `, [
          { name: 'roleId', value: { stringValue: role.id } },
          { name: 'toolId', value: { stringValue: finalToolId } }
        ]);
      }
    }
    
    log.info("Assistant architect approved successfully", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Tool approved successfully",
      data: updatedTool
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error approving tool:", error)
    return { isSuccess: false, message: "Failed to approve tool" }
  }
}

export async function rejectAssistantArchitectAction(
  id: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("rejectAssistantArchitect")
  const log = createLogger({ requestId, action: "rejectAssistantArchitect" })
  
  try {
    log.info("Action started: Rejecting assistant architect", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect rejection attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Check if user is an administrator
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can reject tools" }
    }

    await executeSQL<never>(`
      UPDATE assistant_architects
      SET status = 'rejected'::tool_status, updated_at = NOW()
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    log.info("Assistant architect rejected successfully", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Tool rejected successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error rejecting Assistant Architect:", error)
    return { isSuccess: false, message: "Failed to reject tool" }
  }
}

// Legacy PromptExecutionResult interface removed - now handled by Lambda workers
// Results are stored in prompt_results table and streamed via universal polling

// Add a function to decode HTML entities and remove escapes for variable placeholders
function decodePromptVariables(content: string): string {
  // Replace HTML entity for $ with $
  let decoded = content.replace(/&#x24;|&\#36;/g, '$');
  // Remove backslash escapes before $
  decoded = decoded.replace(/\\\$/g, '$');
  // Remove backslash escapes before {
  decoded = decoded.replace(/\\\{/g, '{');
  // Remove backslash escapes before }
  decoded = decoded.replace(/\\\}/g, '}');
  // Remove backslash escapes before _
  decoded = decoded.replace(/\\_/g, '_');
  return decoded;
}

// Add slugify utility at the top (before executeAssistantArchitectJob)
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

// For the public view, get only approved tools
export async function getApprovedAssistantArchitectsAction(): Promise<
  ActionState<ArchitectWithRelations[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getApprovedAssistantArchitects")
  const log = createLogger({ requestId, action: "getApprovedAssistantArchitects" })
  
  try {
    log.info("Fetching approved Assistant Architects")
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    // First, get all the tools the user has access to using data API
    const userTools = await executeSQL<{ identifier: string }>(`
      SELECT DISTINCT t.identifier
      FROM tools t
      JOIN role_tools rt ON t.id = rt.tool_id
      JOIN user_roles ur ON rt.role_id = ur.role_id
      JOIN users u ON ur.user_id = u.id
      WHERE u.cognito_sub = :cognitoSub AND t.is_active = true
    `, [{ name: 'cognitoSub', value: { stringValue: session.sub } }]);
    
    if (userTools.length === 0) {
      return { isSuccess: true, message: "No assistants found", data: [] }
    }
    
    const toolIdentifiers = userTools.map(t => t.identifier);
    
    // Get the base tools from the tools table
    const baseTools = await executeSQL<{ id: string; identifier: string; assistant_architect_id: string | null }>(`
      SELECT id, identifier, assistant_architect_id
      FROM tools
      WHERE identifier = ANY(:identifiers) AND is_active = true
    `, [{ name: 'identifiers', value: { stringValue: `{${toolIdentifiers.join(',')}}` } }]);
    
    // Extract assistant architect IDs
    const architectIds = baseTools
      .map(tool => tool.assistant_architect_id)
      .filter((id): id is string => id !== null)
    
    if (architectIds.length === 0) {
      return { isSuccess: true, message: "No assistants found", data: [] }
    }
    
    // Fetch approved architects that the user has access to
    const approvedArchitects = await executeSQL<RawDbRow>(`
      SELECT id, name, description, status, image_path, user_id, created_at, updated_at
      FROM assistant_architects
      WHERE status = 'approved' AND id = ANY(:architectIds)
      ORDER BY created_at DESC
    `, [{ name: 'architectIds', value: { stringValue: `{${architectIds.join(',')}}` } }]);

    if (approvedArchitects.length === 0) {
      return { isSuccess: true, message: "No approved architects found", data: [] };
    }
    
    // Fetch related fields and prompts for all approved architects
    const [allInputFieldsRaw, allPromptsRaw] = await Promise.all([
      executeSQL<RawDbRow>(`
        SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
        FROM tool_input_fields
        WHERE assistant_architect_id = ANY(:architectIds)
        ORDER BY position ASC
      `, [{ name: 'architectIds', value: { stringValue: `{${architectIds.join(',')}}` } }]),
      executeSQL<RawDbRow>(`
        SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, parallel_group, timeout_seconds, created_at, updated_at
        FROM chain_prompts
        WHERE assistant_architect_id = ANY(:architectIds)
        ORDER BY position ASC
      `, [{ name: 'architectIds', value: { stringValue: `{${architectIds.join(',')}}` } }])
    ]);

    // Map relations back and transform to camelCase
    const results: ArchitectWithRelations[] = approvedArchitects.map((architect) => {
      const transformedArchitect = transformSnakeToCamel<SelectAssistantArchitect>(architect);
      
      const inputFieldsForArchitect = allInputFieldsRaw
        .filter((f) => Number(f.assistant_architect_id) === Number(architect.id))
        .map((field) => transformSnakeToCamel<SelectToolInputField>(field));
      
      const promptsForArchitect = allPromptsRaw
        .filter((p) => Number(p.assistant_architect_id) === Number(architect.id))
        .map(transformPrompt);
      
      return {
        ...transformedArchitect,
        inputFields: inputFieldsForArchitect,
        prompts: promptsForArchitect
      };
    });

    log.info("Approved assistant architects retrieved successfully", { count: results.length })
    timer({ status: "success", count: results.length })
    
    return {
      isSuccess: true,
      message: "Approved Assistant Architects retrieved successfully",
      data: results
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error getting approved Assistant Architects:", error)
    return { isSuccess: false, message: "Failed to get approved Assistant Architects" }
  }
}

export async function submitAssistantArchitectForApprovalAction(
  id: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("submitAssistantArchitectForApproval")
  const log = createLogger({ requestId, action: "submitAssistantArchitectForApproval" })
  
  try {
    log.info("Action started: Submitting assistant architect for approval", { id })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect submission attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })

    const toolResult = await executeSQL<RawDbRow>(`
      SELECT id, name, description, user_id, status
      FROM assistant_architects
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Assistant not found" }
    }

    const tool = toolResult[0];
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) {
      return { isSuccess: false, message: "User not found" }
    }
    if (tool.user_id !== currentUserId && !isAdmin) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    // Fetch input fields and prompts for this tool
    const [inputFields, prompts] = await Promise.all([
      executeSQL<{ id: number }>(`
        SELECT id FROM tool_input_fields WHERE assistant_architect_id = :id
      `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]),
      executeSQL<{ id: number }>(`
        SELECT id FROM chain_prompts WHERE assistant_architect_id = :id
      `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }])
    ]);

    if (!tool.name || !tool.description || inputFields.length === 0 || prompts.length === 0) {
      return { isSuccess: false, message: "Assistant is incomplete" }
    }

    await executeSQL<never>(`
      UPDATE assistant_architects
      SET status = 'pending_approval'::tool_status, updated_at = NOW()
      WHERE id = :id
    `, [{ name: 'id', value: { longValue: parseInt(id, 10) } }]);

    log.info("Assistant architect submitted for approval", { id })
    timer({ status: "success", id })
    
    return {
      isSuccess: true,
      message: "Assistant submitted for approval",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error submitting assistant for approval:", error)
    return { isSuccess: false, message: "Failed to submit assistant" }
  }
}

// Action to get execution status and results
export async function getExecutionResultsAction(
  executionId: string
): Promise<ActionState<ExecutionResultDetails>> {
  const requestId = generateRequestId()
  const timer = startTimer("getExecutionResults")
  const log = createLogger({ requestId, action: "getExecutionResults" })
  
  try {
    log.info("Action started: Getting execution results", { executionId })
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized execution results access attempt")
      throw createError("Unauthorized", {
        code: "UNAUTHORIZED",
        level: ErrorLevel.WARN
      });
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    // Get execution details
    const executionResult = await executeSQL<SelectToolExecution>(`
      SELECT te.id, te.assistant_architect_id, te.user_id, te.input_data, te.status, te.started_at, te.completed_at, te.created_at, te.updated_at
      FROM tool_executions te
      JOIN users u ON te.user_id = u.id
      WHERE te.id = :executionId AND u.cognito_sub = :cognitoSub
    `, [
      { name: 'executionId', value: { longValue: parseInt(executionId, 10) } },
      { name: 'cognitoSub', value: { stringValue: session.sub } }
    ]);
    
    if (!executionResult || executionResult.length === 0) {
      throw createError("Execution not found or access denied", {
        code: "NOT_FOUND",
        level: ErrorLevel.WARN,
        details: { executionId }
      });
    }

    const execution = transformSnakeToCamel<SelectToolExecution>(executionResult[0]);

    // Get prompt results for this execution
    const promptResultsRaw = await executeSQL<RawDbRow>(`
      SELECT id, execution_id, prompt_id, input_data, output_data, status, error_message, started_at, completed_at, execution_time_ms
      FROM prompt_results
      WHERE execution_id = :executionId
      ORDER BY started_at ASC
    `, [{ name: 'executionId', value: { longValue: parseInt(executionId, 10) } }]);
    
    // Transform to match SelectPromptResult type - note: the DB schema has evolved
    // but the type definition hasn't been updated to match
    const promptResultsData = promptResultsRaw.map((result: RawDbRow) => {
      const transformedResult = transformSnakeToCamel<SelectPromptResult>(result);
      // Add additional fields from actual DB that aren't in the type definition
      return {
        ...transformedResult,
        result: result.output_data || result.result || '',
        aiModelId: null, // Not in current DB schema
        // Additional fields from actual DB
        inputData: result.input_data,
        outputData: result.output_data,
        status: result.status,
        errorMessage: result.error_message,
        startedAt: result.started_at,
        completedAt: result.completed_at,
        executionTimeMs: result.execution_time_ms
      } as SelectPromptResult & {
        inputData?: Record<string, unknown>;
        outputData?: string;
        status?: string;
        errorMessage?: string;
        startedAt?: Date;
        completedAt?: Date;
        executionTimeMs?: number;
      };
    });

    // Return data in the ExecutionResultDetails format
    const returnData: ExecutionResultDetails = {
        ...execution,
        promptResults: promptResultsData || []
    };

    log.info("Execution results retrieved successfully", { executionId })
    timer({ status: "success", executionId })

    return createSuccess(returnData, "Execution status retrieved");
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get execution results", {
      context: "getExecutionResultsAction"
    });
  }
}

/**
 * Helper function to migrate any database references that might still be using the old prompt-chains terminology
 * This is a one-time migration function that can be run to fix any issues
 */
export async function migratePromptChainsToAssistantArchitectAction(): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("migratePromptChainsToAssistantArchitect")
  const log = createLogger({ requestId, action: "migratePromptChainsToAssistantArchitect" })
  
  try {
    log.info("Action started: Migrating prompt chains to assistant architect")
    
    // This is just a placeholder for the migration function
    // The actual migration steps were done directly via database migrations
    // But we can use this function if we discover any other legacy references
    
    log.info("Migration completed successfully")
    timer({ status: "success" })
    
    return {
      isSuccess: true,
      message: "Migration completed successfully",
      data: undefined
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error migrating prompt chains to assistant architect:", error)
    return { 
      isSuccess: false, 
      message: "Failed to migrate prompt chains to assistant architect"
    }
  }
}

export async function getToolsAction(): Promise<ActionState<SelectTool[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getTools")
  const log = createLogger({ requestId, action: "getTools" })
  
  try {
    log.info("Action started: Getting tools")
    const toolsRaw = await executeSQL<RawDbRow>(`
      SELECT id, identifier, name, description, assistant_architect_id, is_active, created_at, updated_at
      FROM tools
      WHERE is_active = true
      ORDER BY name ASC
    `);
    
    const tools = toolsRaw.map((tool: RawDbRow) => {
      const transformed = transformSnakeToCamel<SelectTool>(tool);
      // Map assistant_architect_id to promptChainToolId for backward compatibility
      return {
        ...transformed,
        promptChainToolId: tool.assistant_architect_id
      } as SelectTool;
    });
    
    log.info("Tools retrieved successfully", { count: tools.length })
    timer({ status: "success", count: tools.length })
    
    return {
      isSuccess: true,
      message: "Tools retrieved successfully",
      data: tools
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error getting tools:", error)
    return { isSuccess: false, message: "Failed to get tools" }
  }
}

export async function getAiModelsAction(): Promise<ActionState<SelectAiModel[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAiModels")
  const log = createLogger({ requestId, action: "getAiModels" })
  
  try {
    log.info("Action started: Getting AI models")
    const aiModelsRaw = await executeSQL<RawDbRow>(`
      SELECT id, name, provider, model_id, description, capabilities, max_tokens, active, chat_enabled, created_at, updated_at
      FROM ai_models
      ORDER BY name ASC
    `);
    
    const aiModels = aiModelsRaw.map((model: RawDbRow) => transformSnakeToCamel<SelectAiModel>(model));
    
    log.info("AI models retrieved successfully", { count: aiModels.length })
    timer({ status: "success", count: aiModels.length })
    
    return {
      isSuccess: true,
      message: "AI models retrieved successfully",
      data: aiModels
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error getting AI models:", error)
    return { isSuccess: false, message: "Failed to get AI models" }
  }
}

export async function setPromptPositionsAction(
  toolId: string,
  positions: { id: string; position: number }[]
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("setPromptPositions")
  const log = createLogger({ requestId, action: "setPromptPositions" })
  
  try {
    log.info("Action started: Setting prompt positions", { toolId, count: positions.length })
    const session = await getServerSession();
    if (!session || !session.sub) {
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    const userId = await getCurrentUserId();
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    // Verify permissions
    const toolResult = await executeSQL(
      `SELECT user_id FROM assistant_architects WHERE id = :id`,
      [{ name: 'id', value: { longValue: parseInt(toolId, 10) } }]
    )

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0] as RawDbRow;
    const toolUserId = tool.user_id;

    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator");
    if (!isAdmin && toolUserId !== userId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Update positions for each prompt
    for (const { id, position } of positions) {
      await executeSQL<never>(
        `UPDATE chain_prompts SET position = :position WHERE id = :id`,
        [
          { name: 'position', value: { longValue: position } },
          { name: 'id', value: { longValue: parseInt(id, 10) } }
        ]
      )
    }

    log.info("Prompt positions updated successfully", { toolId, count: positions.length })
    timer({ status: "success", toolId })
    
    return { isSuccess: true, message: "Prompt positions updated", data: undefined }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error setting prompt positions:", error)
    return { isSuccess: false, message: "Failed to set prompt positions" }
  }
}

export async function getApprovedAssistantArchitectsForAdminAction(): Promise<
  ActionState<SelectAssistantArchitect[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getApprovedAssistantArchitectsForAdmin")
  const log = createLogger({ requestId, action: "getApprovedAssistantArchitectsForAdmin" })
  
  try {
    log.info("Action started: Getting approved assistant architects for admin")
    
    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized admin assistant architects access attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    const userId = await getCurrentUserId();
    if (!userId) {
      return { isSuccess: false, message: "User not found" }
    }

    // Check if user is an administrator
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can view approved tools" }
    }

    // Get all approved tools
    const toolsResultRaw = await executeSQL(
      `SELECT id, name, description, status, image_path, user_id, created_at, updated_at FROM assistant_architects WHERE status = :status`,
      [{ name: 'status', value: { stringValue: 'approved' } }]
    )
    
    const toolsResult = toolsResultRaw.map((raw) => transformSnakeToCamel<SelectAssistantArchitect>(raw))

    if (!toolsResult || toolsResult.length === 0) {
      return {
        isSuccess: true,
        message: "No approved tools found",
        data: []
      }
    }

    // Get related data for each tool
    const toolsWithRelations = await Promise.all(
      toolsResult.map(async (toolRecord) => {
        const toolId = String(toolRecord.id || '')
        
        // Run input fields and prompts queries in parallel
        const [inputFieldsResultRaw, promptsResultRaw] = await Promise.all([
          executeSQL(
            `SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at FROM tool_input_fields WHERE assistant_architect_id = :toolId ORDER BY position ASC`,
            [{ name: 'toolId', value: { longValue: parseInt(toolId, 10) } }]
          ),
          executeSQL(
            `SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, parallel_group, timeout_seconds, repository_ids, enabled_tools, created_at, updated_at FROM chain_prompts WHERE assistant_architect_id = :toolId ORDER BY position ASC`,
            [{ name: 'toolId', value: { longValue: parseInt(toolId, 10) } }]
          )
        ]);
        
        const inputFieldsResult = inputFieldsResultRaw;
        const promptsResult = promptsResultRaw;

        // Map the tool record
        const tool = transformSnakeToCamel<SelectAssistantArchitect>(toolRecord);

        // Map input fields
        const inputFields = inputFieldsResult.map((record) => transformSnakeToCamel<SelectToolInputField>(record));

        // Map prompts
        const prompts = promptsResult.map(transformPrompt)

        return {
          ...tool,
          inputFields,
          prompts
        };
      })
    );

    log.info("Approved assistant architects retrieved for admin", { count: toolsWithRelations.length })
    timer({ status: "success", count: toolsWithRelations.length })
    
    return {
      isSuccess: true,
      message: "Approved Assistant Architects retrieved successfully",
      data: toolsWithRelations
    };
  } catch (error) {
    timer({ status: "error" })
    log.error("Error getting approved Assistant Architects:", error);
    return { isSuccess: false, message: "Failed to get approved Assistant Architects" };
  }
}

export async function getAllAssistantArchitectsForAdminAction(): Promise<ActionState<ArchitectWithRelations[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAllAssistantArchitectsForAdmin")
  const log = createLogger({ requestId, action: "getAllAssistantArchitectsForAdmin" })
  
  try {
    log.info("Action started: Getting all assistant architects for admin")
    const session = await getServerSession();
    if (!session) {
      return { isSuccess: false, message: "Unauthorized" }
    }
    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can view all assistants" }
    }
    // Get all assistants
    const allAssistants = await executeSQL<RawDbRow>(`
      SELECT id, name, description, status, image_path, user_id, created_at, updated_at
      FROM assistant_architects
      ORDER BY created_at DESC
    `);
    
    // Get related data for each assistant
    const assistantsWithRelations = await Promise.all(
      allAssistants.map(async (tool: RawDbRow) => {
        const [inputFieldsRaw, promptsRaw] = await Promise.all([
          executeSQL<RawDbRow>(`
            SELECT * FROM tool_input_fields 
            WHERE assistant_architect_id = :toolId 
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(tool.id) } }]),
          executeSQL<RawDbRow>(`
            SELECT * FROM chain_prompts 
            WHERE assistant_architect_id = :toolId 
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(tool.id) } }])
        ]);
        
        // Transform input fields to camelCase
        const inputFields = inputFieldsRaw.map((field) => transformSnakeToCamel<SelectToolInputField>(field));
        
        // Transform prompts to camelCase
        const prompts = promptsRaw.map(transformPrompt);
        
        const transformedTool = transformSnakeToCamel<SelectAssistantArchitect>(tool);
        
        return {
          ...transformedTool,
          inputFields,
          prompts
        };
      })
    )
    log.info("All assistant architects retrieved for admin", { count: assistantsWithRelations.length })
    timer({ status: "success", count: assistantsWithRelations.length })
    
    return { isSuccess: true, message: "All assistants retrieved successfully", data: assistantsWithRelations }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error getting all assistants for admin:", error)
    return { isSuccess: false, message: "Failed to get all assistants" }
  }
}