"use server"

import {
  type InsertAssistantArchitect,
  type SelectAssistantArchitect,
  type InsertToolInputField,
  type InsertChainPrompt,
  type InsertToolExecution,
  type SelectToolInputField,
  type SelectChainPrompt,
  type SelectToolExecution,
  type SelectPromptResult,
  type SelectTool,
  type SelectAiModel,
  type ToolInputFieldOptions
} from "@/types/db-types"
// CoreMessage import removed - AI completion now handled by Lambda workers
import { parseRepositoryIds, serializeRepositoryIds } from "@/lib/utils/repository-utils"
import { getAvailableToolsForModel, getAllTools } from "@/lib/tools/tool-registry"

import { handleError, createSuccess, ErrorFactories, createError } from "@/lib/error-utils";
import { generateToolIdentifier } from "@/lib/utils";
import { ActionState, ErrorLevel } from "@/types";
import { ExecutionResultDetails } from "@/types/assistant-architect-types";
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"
import { getServerSession } from "@/lib/auth/server-session";
import { hasToolAccess, hasRole } from "@/utils/roles";
import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import {
  getAssistantArchitects as drizzleGetAssistantArchitects,
  getAssistantArchitectById as drizzleGetAssistantArchitectById,
  createAssistantArchitect as drizzleCreateAssistantArchitect,
  updateAssistantArchitect as drizzleUpdateAssistantArchitect,
  deleteAssistantArchitect as drizzleDeleteAssistantArchitect,
  approveAssistantArchitect as drizzleApproveAssistantArchitect,
  rejectAssistantArchitect as drizzleRejectAssistantArchitect,
  submitForApproval as drizzleSubmitForApproval,
  getPendingAssistantArchitects as drizzleGetPendingAssistantArchitects,
  getToolInputFields,
  getChainPrompts,
  getUserById,
  createToolInputField,
  deleteToolInputField,
  updateToolInputField,
  createChainPrompt,
  updateChainPrompt,
  deleteChainPrompt
} from "@/lib/db/drizzle";
import { executeQuery } from "@/lib/db/drizzle-client";
import { eq } from "drizzle-orm";
import { tools, navigationItems, toolInputFields, chainPrompts } from "@/lib/db/schema";

// Use inline type for architect with relations
type ArchitectWithRelations = SelectAssistantArchitect & {
  inputFields?: SelectToolInputField[];
  prompts?: SelectChainPrompt[];
}

// Helper function to safely parse integers with validation
function safeParseInt(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw ErrorFactories.validationFailed([{
      field: fieldName,
      message: `Invalid ${fieldName} format`
    }]);
  }
  return parsed;
}

// Helper function to transform and parse prompt data consistently
// TODO: Remove when all functions migrated - temporary generic version for unmigrated functions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformPrompt(prompt: any): SelectChainPrompt {
  // Handle both snake_case (from executeSQL) and camelCase (from Drizzle)
  const repositoryIds = parseRepositoryIds(prompt.repository_ids || prompt.repositoryIds);

  // Parse enabled_tools from JSONB array to string array
  let enabledTools: string[] = [];
  const tools = prompt.enabled_tools || prompt.enabledTools;
  if (tools && typeof tools === 'string') {
    try {
      // Add length check to prevent DoS
      if ((tools as string).length > 10000) {
        enabledTools = [];
      } else {
        const parsed = JSON.parse(tools);
        // Validate parsed data structure
        enabledTools = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      enabledTools = [];
    }
  } else if (Array.isArray(tools)) {
    enabledTools = tools;
  }

  return {
    id: prompt.id,
    assistantArchitectId: prompt.assistant_architect_id || prompt.assistantArchitectId,
    name: prompt.name,
    content: prompt.content,
    systemContext: prompt.system_context || prompt.systemContext,
    modelId: prompt.model_id || prompt.modelId,
    position: prompt.position,
    parallelGroup: prompt.parallel_group || prompt.parallelGroup,
    inputMapping: prompt.input_mapping || prompt.inputMapping,
    timeoutSeconds: prompt.timeout_seconds || prompt.timeoutSeconds,
    repositoryIds,
    enabledTools,
    createdAt: prompt.created_at || prompt.createdAt,
    updatedAt: prompt.updated_at || prompt.updatedAt
  };
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

    // Create assistant architect via Drizzle
    log.info("Creating assistant architect in database", {
      name: assistant.name,
      userId: currentUser.data.user.id
    })

    const architect = await drizzleCreateAssistantArchitect({
      name: assistant.name,
      description: assistant.description || null,
      userId: currentUser.data.user.id,
      status: (assistant.status || 'draft') as "draft" | "pending_approval" | "approved" | "rejected" | "disabled",
      imagePath: assistant.imagePath || null
    });

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
    log.info("Action started: Getting assistant architects via Drizzle")

    // Get all architects with creator info via Drizzle
    const architects = await drizzleGetAssistantArchitects();

    // For each architect, get input fields, prompts, and cognito_sub in parallel
    const architectsWithRelations = await Promise.all(
      architects.map(async (architect) => {
        const [inputFields, prompts, user] = await Promise.all([
          getToolInputFields(architect.id),
          getChainPrompts(architect.id),
          architect.userId ? getUserById(architect.userId) : Promise.resolve(null)
        ]);

        // Transform prompts to handle repositoryIds and enabledTools
        const transformedPrompts = prompts.map(prompt => ({
          ...prompt,
          repositoryIds: parseRepositoryIds(prompt.repositoryIds),
          enabledTools: Array.isArray(prompt.enabledTools) ? prompt.enabledTools : []
        }));

        return {
          id: architect.id,
          name: architect.name,
          description: architect.description,
          status: architect.status,
          imagePath: architect.imagePath,
          userId: architect.userId,
          isParallel: architect.isParallel,
          timeoutSeconds: architect.timeoutSeconds,
          createdAt: architect.createdAt,
          updatedAt: architect.updatedAt,
          inputFields,
          prompts: transformedPrompts,
          creator: architect.creator ? {
            firstName: architect.creator.firstName || '',
            lastName: architect.creator.lastName || '',
            email: architect.creator.email
          } : null,
          cognito_sub: user?.cognitoSub || ''
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
  const log = createLogger({ requestId, action: "getAssistantArchitectById" })

  try {
    log.info("Action started: Getting assistant architect by ID via Drizzle", { architectId: id })

    // Parse string ID to integer
    const idInt = Number.parseInt(id, 10);
    if (Number.isNaN(idInt)) {
      log.warn("Invalid assistant architect ID provided", { architectId: id })
      throw createError("Invalid assistant architect ID", {
        code: "VALIDATION",
        level: ErrorLevel.WARN,
        details: { id }
      });
    }

    // Get architect via Drizzle
    const architect = await drizzleGetAssistantArchitectById(idInt);

    if (!architect) {
      throw createError("Assistant architect not found", {
        code: "NOT_FOUND",
        level: ErrorLevel.WARN,
        details: { id }
      });
    }

    // Get input fields and prompts in parallel via Drizzle
    const [inputFields, prompts] = await Promise.all([
      getToolInputFields(idInt),
      getChainPrompts(idInt)
    ]);

    // Transform prompts to handle repositoryIds and enabledTools
    const transformedPrompts = prompts.map(prompt => ({
      ...prompt,
      repositoryIds: parseRepositoryIds(prompt.repositoryIds),
      enabledTools: Array.isArray(prompt.enabledTools) ? prompt.enabledTools : []
    }));

    const architectWithRelations: ArchitectWithRelations = {
      ...architect,
      inputFields,
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
    log.info("Action started: Getting pending assistant architects via Drizzle")

    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized pending assistant architects access attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }

    log.debug("User authenticated", { userId: session.sub })

    // Check if user is an administrator
    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can view pending tools" }
    }

    // Get pending tools via Drizzle
    const pendingTools = await drizzleGetPendingAssistantArchitects();

    // For each tool, get its input fields and prompts
    const toolsWithRelations = await Promise.all(
      pendingTools.map(async (tool) => {
        const [inputFields, prompts] = await Promise.all([
          getToolInputFields(tool.id),
          getChainPrompts(tool.id)
        ]);

        // Transform prompts to handle repositoryIds and enabledTools
        const transformedPrompts = prompts.map(prompt => ({
          ...prompt,
          repositoryIds: parseRepositoryIds(prompt.repositoryIds),
          enabledTools: Array.isArray(prompt.enabledTools) ? prompt.enabledTools : []
        }));

        return {
          ...tool,
          inputFields: inputFields || [],
          prompts: transformedPrompts || []
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
    log.info("Action started: Updating assistant architect via Drizzle", { id })

    const session = await getServerSession();
    if (!session || !session.sub) {
      log.warn("Unauthorized assistant architect update attempt")
      return { isSuccess: false, message: "Unauthorized" }
    }

    log.debug("User authenticated", { userId: session.sub })

    const idInt = Number.parseInt(id, 10);
    if (Number.isNaN(idInt)) {
      return { isSuccess: false, message: "Invalid ID" }
    }

    // Get the current tool via Drizzle
    const currentTool = await drizzleGetAssistantArchitectById(idInt);

    if (!currentTool) {
      return { isSuccess: false, message: "Assistant not found" }
    }

    const isAdmin = await hasRole("administrator")

    // Get the current user's database ID
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data) {
      return { isSuccess: false, message: "User not found" }
    }

    const isCreator = currentTool.userId === currentUser.data.user.id
    if (!isAdmin && !isCreator) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    // If the tool was approved and is being edited, set status to pending_approval and deactivate it in the tools table
    if (currentTool.status === "approved") {
      data.status = "pending_approval"
      await executeQuery(
        (db) =>
          db
            .update(tools)
            .set({ isActive: false })
            .where(eq(tools.promptChainToolId, idInt)),
        "deactivateApprovedTool"
      );
    }

    // Build update data object with only provided fields
    const updateData: Partial<{
      name: string;
      description: string | null;
      status: "draft" | "pending_approval" | "approved" | "rejected" | "disabled";
      imagePath: string | null;
      isParallel: boolean;
      timeoutSeconds: number | null;
    }> = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description || null;
    if (data.status !== undefined) updateData.status = data.status as "draft" | "pending_approval" | "approved" | "rejected" | "disabled";
    if (data.imagePath !== undefined) updateData.imagePath = data.imagePath || null;
    // Handle isParallel and timeoutSeconds if present in data
    if ('isParallel' in data) updateData.isParallel = Boolean(data.isParallel);
    if ('timeoutSeconds' in data) updateData.timeoutSeconds = data.timeoutSeconds as number | null;

    if (Object.keys(updateData).length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    // Update via Drizzle
    const updatedTool = await drizzleUpdateAssistantArchitect(idInt, updateData);

    if (!updatedTool) {
      return { isSuccess: false, message: "Failed to update assistant" }
    }

    log.info("Assistant architect updated successfully", { id })
    timer({ status: "success", id })

    return {
      isSuccess: true,
      message: "Assistant updated successfully",
      data: updatedTool
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
    const idInt = Number.parseInt(id, 10);
    if (Number.isNaN(idInt)) {
      log.warn("Invalid assistant architect ID provided", { id })
      timer({ status: "error" })
      return { isSuccess: false, message: "Invalid assistant ID" }
    }
    
    // Get assistant details to check ownership and status
    const architect = await drizzleGetAssistantArchitectById(idInt);

    if (!architect) {
      log.warn("Assistant architect not found", { id })
      timer({ status: "error" })
      return { isSuccess: false, message: "Assistant not found" }
    }
    log.debug("Assistant architect retrieved", {
      id,
      status: architect.status,
      ownerId: architect.userId
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
    const isOwner = architect.userId === currentUser.id;
    
    // Check if user is an administrator
    const isAdmin = await hasRole("administrator");

    log.debug("Permission check", {
      userId: currentUser.id,
      assistantOwnerId: architect.userId,
      isOwner,
      isAdmin
    })
    
    // Check permissions: owner OR admin can delete
    if (!isOwner && !isAdmin) {
      log.warn("Unauthorized deletion attempt", {
        userId: currentUser.id,
        assistantId: id,
        ownerId: architect.userId
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
      isAdminDeletion: !isOwner && isAdmin
    })
    
    // Delete from tools table (using prompt_chain_tool_id which references assistant_architect)
    await executeQuery(
      (db) =>
        db
          .delete(tools)
          .where(eq(tools.promptChainToolId, idInt)),
      "deleteToolsByAssistantArchitect"
    );

    // Delete from navigation_items
    await executeQuery(
      (db) =>
        db
          .delete(navigationItems)
          .where(eq(navigationItems.link, `/tools/assistant-architect/${id}`)),
      "deleteNavigationItemByLink"
    );

    // Use the deleteAssistantArchitect function which handles all the cascade deletes properly
    await drizzleDeleteAssistantArchitect(idInt);

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
    options?: ToolInputFieldOptions;
  }
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("addToolInputField")
  const log = createLogger({ requestId, action: "addToolInputField" })
  
  try {
    log.info("Action started: Adding tool input field", { architectId, fieldName: data.name })

    await createToolInputField({
      assistantArchitectId: Number.parseInt(architectId, 10),
      name: data.name,
      label: data.label ?? data.name,
      fieldType: data.type as "text" | "number" | "select" | "multiselect" | "textarea" | "checkbox" | "date" | "email" | "url" | "tel" | "color" | "range" | "time" | "datetime-local" | "month" | "week",
      position: data.position ?? 0,
      options: data.options ?? undefined
    });

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

    const fieldIdInt = Number.parseInt(fieldId, 10);

    // Get the field to find its tool
    const [field] = await executeQuery(
      (db) =>
        db
          .select({
            id: toolInputFields.id,
            assistantArchitectId: toolInputFields.assistantArchitectId
          })
          .from(toolInputFields)
          .where(eq(toolInputFields.id, fieldIdInt))
          .limit(1),
      "getToolInputFieldById"
    );

    if (!field || !field.assistantArchitectId) {
      return { isSuccess: false, message: "Input field not found" }
    }

    // Check if user is the creator of the tool
    const architect = await drizzleGetAssistantArchitectById(field.assistantArchitectId);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    // Check permissions
    const isAdmin = await hasRole("administrator");
    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const currentUserId = currentUserResult.data.user.id;

    if (!isAdmin && architect.userId !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Delete the field
    await deleteToolInputField(fieldIdInt);

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

    const idInt = Number.parseInt(id, 10);

    // Find the field
    const [field] = await executeQuery(
      (db) =>
        db
          .select({
            id: toolInputFields.id,
            assistantArchitectId: toolInputFields.assistantArchitectId
          })
          .from(toolInputFields)
          .where(eq(toolInputFields.id, idInt))
          .limit(1),
      "getToolInputFieldById"
    );

    if (!field || !field.assistantArchitectId) {
      return { isSuccess: false, message: "Input field not found" }
    }

    // Get the tool to check permissions
    const architect = await drizzleGetAssistantArchitectById(field.assistantArchitectId);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    // Only tool creator or admin can update fields
    const isAdmin = await hasRole("administrator");
    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const currentUserId = currentUserResult.data.user.id;

    if (!isAdmin && architect.userId !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Build update data
    const updates: {
      name?: string;
      label?: string;
      fieldType?: "text" | "number" | "select" | "multiselect" | "textarea" | "checkbox" | "date" | "email" | "url" | "tel" | "color" | "range" | "time" | "datetime-local" | "month" | "week";
      position?: number;
      options?: { values?: string[]; multiSelect?: boolean; placeholder?: string };
    } = {};

    if (data.name !== undefined) updates.name = data.name;
    if (data.label !== undefined) updates.label = data.label;
    if (data.fieldType !== undefined) updates.fieldType = data.fieldType as typeof updates.fieldType;
    if (data.position !== undefined) updates.position = data.position;
    if (data.options !== undefined) updates.options = data.options;

    // Always ensure label is set to name if not provided
    if (!updates.label && updates.name) {
      updates.label = updates.name;
    }

    if (Object.keys(updates).length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    const [updatedField] = await updateToolInputField(idInt, updates);

    log.info("Input field updated successfully", { id })
    timer({ status: "success", id })

    return {
      isSuccess: true,
      message: "Input field updated successfully",
      data: updatedField
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

    const toolIdInt = Number.parseInt(toolId, 10);

    // Get the tool to check permissions
    const architect = await drizzleGetAssistantArchitectById(toolIdInt);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    // Only tool creator or admin can reorder fields
    const isAdmin = await hasRole("administrator");
    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const currentUserId = currentUserResult.data.user.id;

    if (!isAdmin && architect.userId !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Update each field's position
    const updatedFields = await Promise.all(
      fieldOrders.map(async ({ id, position }) => {
        const [field] = await updateToolInputField(Number.parseInt(id, 10), { position });
        return field;
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

    await createChainPrompt({
      assistantArchitectId: safeParseInt(architectId, 'architectId'),
      name: data.name,
      content: data.content,
      modelId: data.modelId,
      position: data.position,
      systemContext: data.systemContext,
      inputMapping: data.inputMapping,
      repositoryIds: data.repositoryIds ?? [],
      enabledTools: data.enabledTools ?? []
    });

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

    const idInt = Number.parseInt(id, 10);

    // Find the prompt
    const [prompt] = await executeQuery(
      (db) =>
        db
          .select({
            id: chainPrompts.id,
            assistantArchitectId: chainPrompts.assistantArchitectId,
            modelId: chainPrompts.modelId
          })
          .from(chainPrompts)
          .where(eq(chainPrompts.id, idInt))
          .limit(1),
      "getChainPromptById"
    );

    if (!prompt || !prompt.assistantArchitectId) {
      return { isSuccess: false, message: "Prompt not found" }
    }

    // Get the tool to check permissions
    const architect = await drizzleGetAssistantArchitectById(prompt.assistantArchitectId);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    // Only tool creator or admin can update prompts
    const isAdmin = await hasRole("administrator");

    // Get current user with proper error handling
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data?.user?.id) {
      log.error("Failed to get current user for authorization check");
      throw ErrorFactories.authNoSession();
    }

    const currentUserId = currentUser.data.user.id;
    if (!isAdmin && architect.userId !== currentUserId) {
      log.warn("Authorization failed - user doesn't own resource", {
        userId: currentUserId,
        resourceOwnerId: architect.userId,
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
    
    // Build update data matching ChainPromptUpdateData type
    const updates: {
      name?: string;
      content?: string;
      modelId?: number;
      position?: number;
      parallelGroup?: number | null;
      inputMapping?: Record<string, string> | null;
      timeoutSeconds?: number | null;
      systemContext?: string | null;
      repositoryIds?: number[];
      enabledTools?: string[];
    } = {};

    if (data.name !== undefined && data.name !== null) updates.name = data.name;
    if (data.content !== undefined && data.content !== null) updates.content = data.content;
    if (data.systemContext !== undefined) updates.systemContext = data.systemContext ?? null;
    if (data.modelId !== undefined && data.modelId !== null) updates.modelId = data.modelId;
    if (data.position !== undefined && data.position !== null) updates.position = data.position;
    if (data.parallelGroup !== undefined) updates.parallelGroup = data.parallelGroup ?? null;
    if (data.timeoutSeconds !== undefined) updates.timeoutSeconds = data.timeoutSeconds ?? null;
    if (data.inputMapping !== undefined) updates.inputMapping = data.inputMapping ?? null;
    if (data.repositoryIds !== undefined && data.repositoryIds !== null) updates.repositoryIds = data.repositoryIds;
    if (data.enabledTools !== undefined && data.enabledTools !== null) updates.enabledTools = data.enabledTools;

    if (Object.keys(updates).length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    const updatedPrompt = await updateChainPrompt(idInt, updates);

    log.info("Prompt updated successfully", { id })
    timer({ status: "success", id })

    return {
      isSuccess: true,
      message: "Prompt updated successfully",
      data: updatedPrompt
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

    const idInt = Number.parseInt(id, 10);

    // Find the prompt
    const [prompt] = await executeQuery(
      (db) =>
        db
          .select({
            assistantArchitectId: chainPrompts.assistantArchitectId
          })
          .from(chainPrompts)
          .where(eq(chainPrompts.id, idInt))
          .limit(1),
      "getChainPromptById"
    );

    if (!prompt || !prompt.assistantArchitectId) {
      return { isSuccess: false, message: "Prompt not found" }
    }

    // Get the tool to check permissions
    const architect = await drizzleGetAssistantArchitectById(prompt.assistantArchitectId);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    // Only tool creator or admin can delete prompts
    const isAdmin = await hasRole("administrator");
    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const currentUserId = currentUserResult.data.user.id;

    if (!isAdmin && architect.userId !== currentUserId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Delete the prompt
    await deleteChainPrompt(idInt);

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

    const idInt = Number.parseInt(id, 10);

    // Find the prompt
    const [prompt] = await executeQuery(
      (db) =>
        db
          .select({
            assistantArchitectId: chainPrompts.assistantArchitectId
          })
          .from(chainPrompts)
          .where(eq(chainPrompts.id, idInt))
          .limit(1),
      "getChainPromptById"
    );

    if (!prompt || !prompt.assistantArchitectId) {
      return { isSuccess: false, message: "Prompt not found" }
    }

    // Get the tool to check permissions
    const architect = await drizzleGetAssistantArchitectById(prompt.assistantArchitectId);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    // Only tool creator or admin can update prompt positions
    const isAdmin = await hasRole("administrator");
    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const userId = currentUserResult.data.user.id;

    if (!isAdmin && architect.userId !== userId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Update the prompt's position
    await updateChainPrompt(idInt, { position });

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
        { name: 'toolId', value: execution.assistantArchitectId !== null && execution.assistantArchitectId !== undefined ? { longValue: execution.assistantArchitectId } : { isNull: true } },
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
  result: Record<string, unknown>
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

    if (result.result !== undefined && typeof result.result === 'string') {
      setClauses.push('result = :result')
      updates.push({ name: 'result', value: { stringValue: result.result } })
    }
    if (result.error !== undefined && typeof result.error === 'string') {
      setClauses.push('error = :error')
      updates.push({ name: 'error', value: { stringValue: result.error } })
    }
    if (result.executionTime !== undefined && typeof result.executionTime === 'number') {
      setClauses.push('execution_time = :executionTime')
      updates.push({ name: 'executionTime', value: { longValue: result.executionTime } })
    }
    if (result.tokensUsed !== undefined && typeof result.tokensUsed === 'number') {
      setClauses.push('tokens_used = :tokensUsed')
      updates.push({ name: 'tokensUsed', value: { longValue: result.tokensUsed } })
    }

    if (setClauses.length === 0) {
      return { isSuccess: true, message: "No updates to apply", data: undefined }
    }

    updates.push(
      { name: 'executionId', value: { longValue: Number.parseInt(executionId, 10) } },
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
    const updatedToolResult = await executeSQL<FormattedRow>(`
      UPDATE assistant_architects
      SET status = 'approved'::tool_status, updated_at = NOW()
      WHERE id = :id
      RETURNING id, name, description, status, image_path, user_id, created_at, updated_at
    `, [{ name: 'id', value: { longValue: Number.parseInt(id, 10) } }]);
    
    if (!updatedToolResult || updatedToolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }
    
    const updatedTool = transformSnakeToCamel<SelectAssistantArchitect>(updatedToolResult[0]);
    
    // Check if tool already exists in tools table
    const existingToolResult = await executeSQL<{ id: string }>(`
      SELECT id FROM tools WHERE assistant_architect_id = :id
    `, [{ name: 'id', value: { longValue: Number.parseInt(id, 10) } }]);
    
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
        { name: 'id', value: { longValue: Number.parseInt(id, 10) } }
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
        { name: 'assistantArchitectId', value: { longValue: Number.parseInt(id, 10) } }
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
    const isAdmin = await hasRole("administrator");
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can reject tools" }
    }

    await drizzleRejectAssistantArchitect(Number.parseInt(id, 10));

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
// Removed unused utility functions - if needed in future, restore from git history
// - decodePromptVariables: HTML entity decoding for variable placeholders
// - slugify: String to URL-safe slug conversion

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
    const approvedArchitects = await executeSQL<FormattedRow>(`
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
      executeSQL<FormattedRow>(`
        SELECT id, assistant_architect_id, name, label, field_type, position, options, created_at, updated_at
        FROM tool_input_fields
        WHERE assistant_architect_id = ANY(:architectIds)
        ORDER BY position ASC
      `, [{ name: 'architectIds', value: { stringValue: `{${architectIds.join(',')}}` } }]),
      executeSQL<FormattedRow>(`
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

    const idInt = Number.parseInt(id, 10);

    const tool = await drizzleGetAssistantArchitectById(idInt);

    if (!tool) {
      return { isSuccess: false, message: "Assistant not found" }
    }

    const isAdmin = await hasRole("administrator");
    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const currentUserId = currentUserResult.data.user.id;

    if (tool.userId !== currentUserId && !isAdmin) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    // Fetch input fields and prompts for this tool
    const [inputFields, prompts] = await Promise.all([
      getToolInputFields(idInt),
      getChainPrompts(idInt)
    ]);

    if (!tool.name || !tool.description || inputFields.length === 0 || prompts.length === 0) {
      return { isSuccess: false, message: "Assistant is incomplete" }
    }

    await drizzleSubmitForApproval(idInt);

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
      { name: 'executionId', value: { longValue: Number.parseInt(executionId, 10) } },
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
    const promptResultsRaw = await executeSQL<FormattedRow>(`
      SELECT id, execution_id, prompt_id, input_data, output_data, status, error_message, started_at, completed_at, execution_time_ms, user_feedback
      FROM prompt_results
      WHERE execution_id = :executionId
      ORDER BY started_at ASC
    `, [{ name: 'executionId', value: { longValue: Number.parseInt(executionId, 10) } }]);

    // Transform to match SelectPromptResult type (now updated to match DB schema)
    const promptResultsData = promptResultsRaw.map((result: FormattedRow) => {
      return transformSnakeToCamel<SelectPromptResult>(result);
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
    const toolsRaw = await executeSQL<FormattedRow>(`
      SELECT id, identifier, name, description, assistant_architect_id, is_active, created_at, updated_at
      FROM tools
      WHERE is_active = true
      ORDER BY name ASC
    `);
    
    const tools = toolsRaw.map((tool: FormattedRow) => {
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
    const aiModelsRaw = await executeSQL<FormattedRow>(`
      SELECT id, name, provider, model_id, description, capabilities, max_tokens, active, chat_enabled, created_at, updated_at
      FROM ai_models
      ORDER BY name ASC
    `);
    
    const aiModels = aiModelsRaw.map((model: FormattedRow) => transformSnakeToCamel<SelectAiModel>(model));
    
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
  positions: { id: string; position: number; parallelGroup?: number | null }[]
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
      [{ name: 'id', value: { longValue: Number.parseInt(toolId, 10) } }]
    )

    if (!toolResult || toolResult.length === 0) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const tool = toolResult[0] as FormattedRow;
    const toolUserId = tool.user_id;

    const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator");
    if (!isAdmin && toolUserId !== userId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Update positions and parallel_group for each prompt using parameterized queries
    // Note: Individual queries are used to maintain security (prevent SQL injection)
    // Performance impact is minimal for typical use cases (<20 prompts)
    for (const { id, position, parallelGroup } of positions) {
      await executeSQL<never>(
        `UPDATE chain_prompts SET position = :position, parallel_group = :parallelGroup WHERE id = :id`,
        [
          { name: 'position', value: { longValue: position } },
          { name: 'parallelGroup', value: parallelGroup !== undefined && parallelGroup !== null ? { longValue: parallelGroup } : { isNull: true } },
          { name: 'id', value: { longValue: Number.parseInt(id, 10) } }
        ]
      )
    }

    log.info("Prompt positions updated successfully", { toolId, count: positions.length })
    timer({ status: "success", toolId })

    return { isSuccess: true, message: "Prompt positions updated", data: undefined }
  } catch (error) {
    timer({ status: "error" })
    log.error("Error setting prompt positions:", {
      error,
      count: positions.length,
      toolId
    })
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
            [{ name: 'toolId', value: { longValue: Number.parseInt(toolId, 10) } }]
          ),
          executeSQL(
            `SELECT id, assistant_architect_id, name, content, system_context, model_id, position, input_mapping, parallel_group, timeout_seconds, repository_ids, enabled_tools, created_at, updated_at FROM chain_prompts WHERE assistant_architect_id = :toolId ORDER BY position ASC`,
            [{ name: 'toolId', value: { longValue: Number.parseInt(toolId, 10) } }]
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
    const allAssistants = await executeSQL<FormattedRow>(`
      SELECT id, name, description, status, image_path, user_id, created_at, updated_at
      FROM assistant_architects
      ORDER BY created_at DESC
    `);
    
    // Get related data for each assistant
    const assistantsWithRelations = await Promise.all(
      allAssistants.map(async (tool: FormattedRow) => {
        const [inputFieldsRaw, promptsRaw] = await Promise.all([
          executeSQL<FormattedRow>(`
            SELECT * FROM tool_input_fields 
            WHERE assistant_architect_id = :toolId 
            ORDER BY position ASC
          `, [{ name: 'toolId', value: { longValue: Number(tool.id) } }]),
          executeSQL<FormattedRow>(`
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