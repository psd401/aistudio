"use server"

import {
  type InsertAssistantArchitect,
  type SelectAssistantArchitect,
  type InsertToolInputField,
  type InsertChainPrompt,
  type InsertToolExecution,
  type SelectToolInputField,
  type SelectChainPrompt,
  type SelectAiModel,
  type ToolInputFieldOptions
} from "@/types/db-types"
// CoreMessage import removed - AI completion now handled by Lambda workers
import { parseRepositoryIds } from "@/lib/utils/repository-utils"
import { getAvailableToolsForModel, getAllTools } from "@/lib/tools/tool-registry"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { getScopesForRoles } from "@/lib/api-keys/scopes"

import { handleError, createSuccess, ErrorFactories, createError } from "@/lib/error-utils";
import { ActionState, ErrorLevel } from "@/types";
import { ExecutionResultDetails } from "@/types/assistant-architect-types";
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"
import { getServerSession } from "@/lib/auth/server-session";
import { hasCapabilityAccess, hasRole } from "@/utils/roles";
import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access";
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
  createToolInputField,
  deleteToolInputField,
  updateToolInputField,
  createChainPrompt,
  updateChainPrompt,
  deleteChainPrompt,
  getAIModels,
  getAIModelById,
  getArchitectEnabledModels,
  getAssistantArchitectsByStatus,
  getRoleByName
} from "@/lib/db/drizzle";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { navigationItems, toolInputFields, chainPrompts, assistantArchitects, userRoles, toolExecutions, promptResults, capabilities, roleCapabilities, type AssistantRetrievalScope } from "@/lib/db/schema";
import type { AssistantModelFamily, AssistantModelRoutingMode } from "@/lib/db/schema/tables/assistant-architects";
import {
  inferModelFamily,
  isExecutableTextModel,
  modelSupportsProviderNativeTool,
} from "@/lib/ai/model-router/core";

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

// Helper function to map UI field types to database enum values
function mapFieldTypeToDb(uiType: string): "short_text" | "long_text" | "select" | "multi_select" | "file_upload" {
  switch (uiType) {
    case "textarea":
    case "long_text":
      return "long_text"
    case "select":
      return "select"
    case "multiselect":
    case "multi_select":
      return "multi_select"
    case "file_upload":
      return "file_upload"
    default:
      // text, number, email, url, date, etc. all map to short_text
      return "short_text"
  }
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
    const model = await getAIModelById(modelId)

    if (!model || !model.active) {
      return {
        isValid: false,
        invalidTools: enabledTools,
        message: "Model not found or inactive"
      }
    }

    const modelIdString = model.modelId

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

function resolveModelRoutingFields(data: Partial<InsertAssistantArchitect>):
  | { fields: { modelRoutingMode?: AssistantModelRoutingMode; modelRoutingFamily?: AssistantModelFamily | null } }
  | { error: string } {
  if (data.modelRoutingMode === undefined && data.modelRoutingFamily === undefined) {
    return { fields: {} };
  }
  const mode = data.modelRoutingMode;
  if (mode !== undefined && !["legacy", "standard", "advanced"].includes(mode)) {
    return { error: "Invalid model routing mode" };
  }
  if (mode === "advanced") {
    if (!data.modelRoutingFamily || !["openai", "anthropic", "google"].includes(data.modelRoutingFamily)) {
      return { error: "Advanced routing requires ChatGPT, Claude, or Gemini" };
    }
    return { fields: { modelRoutingMode: mode, modelRoutingFamily: data.modelRoutingFamily } };
  }
  if (mode === "legacy" || mode === "standard") {
    return { fields: { modelRoutingMode: mode, modelRoutingFamily: null } };
  }
  if (data.modelRoutingFamily !== undefined) {
    return { error: "Choose Advanced routing before selecting a model family" };
  }
  return { fields: {} };
}

async function validateEnabledToolsForRouting(
  enabledTools: string[],
  architect: Pick<SelectAssistantArchitect, "modelRoutingMode" | "modelRoutingFamily">,
  userId: number,
  fallbackModelId: number | null | undefined
): Promise<{ isValid: boolean; invalidTools: string[]; message?: string }> {
  const routingMode = architect.modelRoutingMode ?? "legacy";
  if (routingMode === "legacy") {
    if (!fallbackModelId) {
      return { isValid: false, invalidTools: enabledTools, message: "Choose a model before enabling tools" };
    }
    return validateEnabledTools(enabledTools, fallbackModelId);
  }
  if (enabledTools.length === 0) return { isValid: true, invalidTools: [] };

  const knownTools = new Set(getAllTools().map(tool => tool.name));
  const unknownTools = enabledTools.filter(tool => !knownTools.has(tool));
  if (unknownTools.length > 0) {
    return { isValid: false, invalidTools: unknownTools, message: `Unknown tools: ${unknownTools.join(", ")}` };
  }

  const models = (await getArchitectEnabledModels()).filter(model =>
    isExecutableTextModel(model)
    && (routingMode !== "advanced"
      || inferModelFamily(model) === architect.modelRoutingFamily)
  );
  const accessibleIds = await filterAccessibleResourceIds(userId, "model", models.map(model => model.id));
  const accessible = models.filter(model => accessibleIds.has(String(model.id)));
  const availableByModel = await Promise.all(
    accessible.map(async model => new Set(
      (await getAvailableToolsForModel(model.modelId))
        .filter(tool => modelSupportsProviderNativeTool(model, tool.name))
        .map(tool => tool.name)
    ))
  );
  if (availableByModel.some(tools => enabledTools.every(tool => tools.has(tool)))) {
    return { isValid: true, invalidTools: [] };
  }
  return {
    isValid: false,
    invalidTools: enabledTools,
    message: "No accessible model in this routing mode supports all selected tools",
  };
}

async function resolveAutomaticPromptFallbackModelId(
  architect: Pick<SelectAssistantArchitect, "modelRoutingMode" | "modelRoutingFamily">,
  userId: number,
  requestedModelId: number | undefined,
  enabledTools: string[]
): Promise<number | null> {
  const routingMode = architect.modelRoutingMode ?? "legacy";
  const candidates = (await getArchitectEnabledModels()).filter(model =>
    isExecutableTextModel(model)
    && (routingMode !== "advanced"
      || inferModelFamily(model) === architect.modelRoutingFamily)
  );
  const accessibleIds = await filterAccessibleResourceIds(
    userId,
    "model",
    candidates.map(model => model.id)
  );
  const accessible = candidates.filter(model => accessibleIds.has(String(model.id)));
  const compatible = enabledTools.length === 0
    ? accessible
    : (await Promise.all(accessible.map(async model => ({
      model,
      tools: new Set(
        (await getAvailableToolsForModel(model.modelId))
          .filter(tool => modelSupportsProviderNativeTool(model, tool.name))
          .map(tool => tool.name)
      ),
    })))).filter(candidate => enabledTools.every(tool => candidate.tools.has(tool)))
      .map(candidate => candidate.model);

  const requested = requestedModelId
    ? compatible.find(model => model.id === requestedModelId)
    : undefined;
  return requested?.id ?? compatible[0]?.id ?? null;
}

/**
 * Validate an agentic assistant's `agentEnabledTools` (catalog `domain.action`
 * identifiers) against the unified catalog (#924). A tool is valid only if it is
 * exposed on the `internal` surface, is `agentCallable`, and the AUTHOR's
 * role-derived scopes permit it — so an author cannot enable a tool they could
 * not themselves invoke. The caller's scopes are re-checked at execution time
 * (resolveAgentTools), giving the required dual scope intersection (#926).
 */
async function validateAgentTools(
  agentEnabledTools: string[],
  authorRoleNames: string[]
): Promise<{ isValid: boolean; invalidTools: string[]; message?: string }> {
  if (!agentEnabledTools || agentEnabledTools.length === 0) {
    return { isValid: true, invalidTools: [] };
  }
  try {
    const authorScopes = getScopesForRoles(authorRoleNames);
    const allowed = await toolCatalogInstance.list({
      surface: "internal",
      scopes: authorScopes,
      agentOnly: true,
    });
    const allowedIdentifiers = new Set(allowed.map((e) => e.identifier));
    const invalidTools = agentEnabledTools.filter(
      (id) => !allowedIdentifiers.has(id)
    );
    if (invalidTools.length > 0) {
      return {
        isValid: false,
        invalidTools,
        // Report a count rather than echoing the caller-supplied identifiers back
        // in the message (avoids reflecting arbitrary input into the response).
        message: `Tools not available for agentic use with your permissions: ${invalidTools.length} not accessible`,
      };
    }
    return { isValid: true, invalidTools: [] };
  } catch (error) {
    return {
      isValid: false,
      invalidTools: agentEnabledTools,
      message: `Error validating agent tools: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/** Agentic-mode columns an update may set (Issue #926). */
type AgenticUpdateFields = Partial<{
  mode: "prompt_chain" | "agentic";
  agentEnabledTools: string[];
  agentEnabledConnectors: string[];
  agentMaxSteps: number;
  agentTimeoutSeconds: number;
  agentCostCapCents: number | null;
  agentMaxRequestsPerHour: number | null;
}>;

/**
 * Resolve + validate the agentic-mode fields from an update payload (Issue #926).
 * Enforces the one-way mode transition (prompt_chain -> agentic only), validates
 * the agent tool list against the catalog with the AUTHOR's scopes, and clamps
 * the numeric limits to their DB CHECK ranges. Returns either the partial fields
 * to merge or a user-facing error string.
 */
async function resolveAgenticUpdateFields(
  data: Partial<InsertAssistantArchitect>,
  currentMode: string | null | undefined,
  authorRoleNames: string[],
  authorUserId: number
): Promise<{ fields: AgenticUpdateFields } | { error: string }> {
  const fields: AgenticUpdateFields = {};

  if (data.mode !== undefined) {
    // Validate at runtime rather than blind-casting: a malformed payload would
    // otherwise reach the DB and surface as a generic constraint failure instead
    // of a clear validation error.
    if (data.mode !== "prompt_chain" && data.mode !== "agentic") {
      return { error: `Invalid assistant mode: ${String(data.mode)}` };
    }
    const nextMode = data.mode;
    // Mode is one-way: agentic -> prompt_chain is not supported.
    if (currentMode === "agentic" && nextMode === "prompt_chain") {
      return { error: "Cannot convert an agentic assistant back to prompt-chain mode" };
    }
    fields.mode = nextMode;
  }
  if (data.agentEnabledTools !== undefined) {
    const toolValidation = await validateAgentTools(data.agentEnabledTools, authorRoleNames);
    if (!toolValidation.isValid) {
      return { error: toolValidation.message || "Invalid agent tools" };
    }
    fields.agentEnabledTools = data.agentEnabledTools;
  }
  if (data.agentEnabledConnectors !== undefined) {
    const connectorError = await validateAgentConnectors(
      data.agentEnabledConnectors,
      authorUserId,
      authorRoleNames
    );
    if (connectorError) return { error: connectorError };
    fields.agentEnabledConnectors = data.agentEnabledConnectors;
  }
  if (data.agentMaxSteps !== undefined) {
    fields.agentMaxSteps = clampIntInRange(data.agentMaxSteps, 1, 50, 10);
  }
  if (data.agentTimeoutSeconds !== undefined) {
    fields.agentTimeoutSeconds = clampIntInRange(data.agentTimeoutSeconds, 1, 900, 300);
  }
  // null/<=0/non-finite => no cap. Keeps NaN out of the DB (which would surface
  // as a generic insert failure) and avoids a negative becoming a 1-unit cap.
  if (data.agentCostCapCents !== undefined) {
    fields.agentCostCapCents = nullablePositiveInt(data.agentCostCapCents);
  }
  if (data.agentMaxRequestsPerHour !== undefined) {
    fields.agentMaxRequestsPerHour = nullablePositiveInt(data.agentMaxRequestsPerHour);
  }

  return { fields };
}

/**
 * Validate that every connector ID is one the author can access (parity with
 * agentEnabledTools). Returns a user-facing error string when one or more IDs are
 * not accessible, or null when all are valid (or none were supplied).
 *
 * Execution-time resolution already filters connectors by the CALLER's access, so
 * an unowned connector can't be invoked regardless — this is defense in depth plus
 * a clear authoring-time error. Reports a count rather than echoing the raw IDs.
 */
async function validateAgentConnectors(
  connectorIds: string[],
  authorUserId: number,
  authorRoleNames: string[]
): Promise<string | null> {
  if (connectorIds.length === 0) return null;
  const { getAvailableConnectors } = await import("@/lib/mcp/connector-service");
  const accessible = await getAvailableConnectors(authorUserId, authorRoleNames);
  const accessibleIds = new Set(accessible.map(c => c.id));
  const invalidCount = connectorIds.filter(id => !accessibleIds.has(id)).length;
  if (invalidCount > 0) {
    return `Connectors not available with your permissions: ${invalidCount} not accessible`;
  }
  return null;
}

/** Normalize a nullable numeric limit to a positive integer, or null for no cap. */
function nullablePositiveInt(value: number | null): number | null {
  if (value === null) return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse + clamp an integer into [min, max]; falls back for non-finite input. */
function clampIntInRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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

    // Agentic fields (Issue #926). Resolved + validated in a helper (shared
    // clamping/validation with the update path) to persist agentic config on the
    // initial create — previously dropped (PR review) — without inflating this
    // action's complexity. Mode transition guard is N/A on create (no prior mode).
    const agentResult = await resolveAgenticUpdateFields(
      assistant,
      undefined,
      currentUser.data.roles.map(r => r.name),
      currentUser.data.user.id
    )
    if ("error" in agentResult) {
      throw ErrorFactories.validationFailed([{
        field: 'agentEnabledTools',
        message: agentResult.error
      }])
    }

    const routingResult = resolveModelRoutingFields({
      ...assistant,
      modelRoutingMode: assistant.modelRoutingMode ?? "standard",
    });
    if ("error" in routingResult) {
      throw ErrorFactories.validationFailed([{
        field: "modelRoutingMode",
        message: routingResult.error,
      }]);
    }

    const architect = await drizzleCreateAssistantArchitect({
      name: assistant.name,
      description: assistant.description || null,
      userId: currentUser.data.user.id,
      status: (assistant.status || 'draft') as "draft" | "pending_approval" | "approved" | "rejected" | "disabled",
      imagePath: assistant.imagePath || null,
      ...routingResult.fields,
      ...agentResult.fields,
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
    creator: { firstName: string; lastName: string } | null;
  })[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getAssistantArchitects")
  const log = createLogger({ requestId, action: "getAssistantArchitects" })

  try {
    log.info("Action started: Getting assistant architects via Drizzle")

    // Auth (REV-COR-034): this action is in the client manifest, so it is
    // directly invocable regardless of the /api wrapper's gate. Require a session
    // and the assistant-architect capability (or admin) before querying, matching
    // app/api/assistant-architects/route.ts. Previously this returned every
    // user's drafts, prompt contents, creator emails, and cognito_subs to anyone.
    const session = await getServerSession();
    if (!session?.sub) {
      return { isSuccess: false, message: "Unauthorized" };
    }
    const isAdmin = await hasRole("administrator");
    if (!isAdmin && !(await hasCapabilityAccess("assistant-architect"))) {
      return { isSuccess: false, message: "Access denied" };
    }

    // Scope the result set (Codex P1, follow-up on REV-COR-034): the generic
    // "assistant-architect" capability is held by every staff/capability user,
    // so returning every record here — not just the ones an admin gate would
    // catch — let any capability holder read other users' draft/pending/
    // rejected prompt contents. Non-admins only ever see approved tools plus
    // their own; admins keep full visibility (approvals, moderation).
    const allArchitects = await drizzleGetAssistantArchitects();
    let callerId: number | undefined
    if (!isAdmin) {
      const currentUser = await getCurrentUserAction();
      callerId = currentUser.isSuccess ? currentUser.data?.user?.id : undefined;
    }
    let architects: typeof allArchitects;
    if (isAdmin) {
      architects = allArchitects;
    } else {
      // Per-resource grant filter (#1206): an approved assistant NOT owned by the
      // caller is additionally gated by resource_access_grants — a restricted
      // assistant only appears in the gallery for a user who matches a role/group
      // grant (zero grants = unrestricted). The caller always sees their own (any
      // status). Batch lookup to avoid an N+1 over the gallery.
      const approvedNotOwnedIds = allArchitects
        .filter((a) => a.status === "approved" && a.userId !== callerId)
        .map((a) => a.id);
      const accessibleIds = await filterAccessibleResourceIds(
        callerId ?? -1,
        "assistant",
        approvedNotOwnedIds
      );
      architects = allArchitects.filter(
        (architect) =>
          architect.userId === callerId ||
          (architect.status === "approved" &&
            accessibleIds.has(String(architect.id)))
      );
    }

    // For each architect, get input fields and prompts in parallel
    const architectsWithRelations = await Promise.all(
      architects.map(async (architect) => {
        const [inputFields, prompts] = await Promise.all([
          getToolInputFields(architect.id),
          getChainPrompts(architect.id)
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
          // Agentic mode fields (Issue #926)
          mode: architect.mode,
          modelRoutingMode: architect.modelRoutingMode,
          modelRoutingFamily: architect.modelRoutingFamily,
          agentEnabledTools: architect.agentEnabledTools,
          agentEnabledConnectors: architect.agentEnabledConnectors,
          agentMaxSteps: architect.agentMaxSteps,
          agentTimeoutSeconds: architect.agentTimeoutSeconds,
          agentCostCapCents: architect.agentCostCapCents,
          agentMaxRequestsPerHour: architect.agentMaxRequestsPerHour,
          retrievalScope: architect.retrievalScope,
          inputFields,
          prompts: transformedPrompts,
          // creator.email and cognito_sub removed (REV-COR-034): the list page
          // renders names only, and cognito_sub is a stable identity key that
          // must not leak (see REV-COR-035 for how a leaked sub is abused).
          creator: architect.creator ? {
            firstName: architect.creator.firstName || '',
            lastName: architect.creator.lastName || ''
          } : null
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

    // Visibility (REV-COR-034): a non-approved architect and its prompt contents
    // (author IP / internal instructions) are readable only by the creator or an
    // admin. Approved tools stay readable by any route-authenticated caller
    // (browser session OR API key at the route layer) so execution and the v1 API
    // are unaffected — this gates draft/pending enumeration without a hard session
    // requirement that would break API-key callers.
    if (architect.status !== "approved") {
      const isAdmin = await hasRole("administrator");
      const currentUser = await getCurrentUserAction();
      const callerId = currentUser.isSuccess ? currentUser.data?.user?.id : undefined;
      if (!isAdmin && architect.userId !== callerId) {
        throw createError("Assistant architect not found", {
          code: "NOT_FOUND",
          level: ErrorLevel.WARN,
          details: { id }
        });
      }
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

/** Resolved current-user data (roles + user) for an authorized architect edit. */
type CurrentUserData = NonNullable<
  Awaited<ReturnType<typeof getCurrentUserAction>>["data"]
>;

/**
 * Authorize an assistant-architect edit: the caller must resolve to a current user
 * and be either an administrator or the tool's creator. Returns the resolved user
 * data on success or a user-facing error message. Extracted from
 * updateAssistantArchitectAction to keep that action's cyclomatic complexity bounded.
 */
function resolveArchitectEditAuthorization(
  currentUser: Awaited<ReturnType<typeof getCurrentUserAction>>,
  toolUserId: number | null,
  isAdmin: boolean
): { data: CurrentUserData } | { error: string } {
  if (!currentUser.isSuccess || !currentUser.data) {
    return { error: "User not found" };
  }
  const isCreator = toolUserId === currentUser.data.user.id;
  if (!isAdmin && !isCreator) {
    return { error: "Unauthorized" };
  }
  return { data: currentUser.data };
}

/** Base (non-agentic) update fields an assistant-architect update may set. */
type AssistantArchitectBaseUpdates = Partial<{
  name: string;
  description: string | null;
  status: "draft" | "pending_approval" | "approved" | "rejected" | "disabled";
  imagePath: string | null;
  isParallel: boolean;
  timeoutSeconds: number | null;
  // Retrieval scoping (Atrium Phase 6, Issue #1056)
  retrievalScope: AssistantRetrievalScope | null;
  modelRoutingMode: AssistantModelRoutingMode;
  modelRoutingFamily: AssistantModelFamily | null;
  // Agentic mode (Issue #926)
  mode: "prompt_chain" | "agentic";
  agentEnabledTools: string[];
  agentEnabledConnectors: string[];
  agentMaxSteps: number;
  agentTimeoutSeconds: number;
  agentCostCapCents: number | null;
  agentMaxRequestsPerHour: number | null;
}>;

/**
 * Build the base (non-agentic) update object from the provided payload, including
 * only fields that were supplied. Extracted from updateAssistantArchitectAction to
 * keep that action's cyclomatic complexity bounded; behavior is identical to the
 * inline branches.
 */
function buildAssistantArchitectBaseUpdates(
  data: Partial<InsertAssistantArchitect>
): AssistantArchitectBaseUpdates {
  const updateData: AssistantArchitectBaseUpdates = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description || null;
  if (data.status !== undefined) updateData.status = data.status as "draft" | "pending_approval" | "approved" | "rejected" | "disabled";
  if (data.imagePath !== undefined) updateData.imagePath = data.imagePath || null;
  // Handle isParallel and timeoutSeconds if provided. Use `!== undefined` for
  // consistency with the fields above (an explicit `undefined` means "not set").
  if (data.isParallel !== undefined) updateData.isParallel = Boolean(data.isParallel);
  if (data.timeoutSeconds !== undefined) updateData.timeoutSeconds = data.timeoutSeconds as number | null;
  // Retrieval scoping (Atrium Phase 6, Issue #1056) — persist an explicitly
  // provided scope (including `null` to clear it) so action-layer updates are
  // not silently stripped.
  if (data.retrievalScope !== undefined) updateData.retrievalScope = data.retrievalScope;

  return updateData;
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

    // Authorization: caller must be an admin or the tool's creator. Branch logic
    // is extracted to keep this action's cyclomatic complexity bounded.
    const authResult = resolveArchitectEditAuthorization(currentUser, currentTool.userId, isAdmin);
    if ("error" in authResult) {
      return { isSuccess: false, message: authResult.error }
    }
    const currentUserData = authResult.data;

    // Track whether this edit must atomically deactivate the capability.
    // Decoupling the capability-deactivate from the architect-update creates an
    // unrecoverable inconsistency: capability appears active but architect is back
    // in review, locking users out of a feature until manual DB intervention.
    const needsCapabilityDeactivation = currentTool.status === "approved";
    if (needsCapabilityDeactivation) {
      data.status = "pending_approval";
    }

    // Build update data object with only provided fields. Branch logic is
    // extracted to keep this action's cyclomatic complexity bounded.
    const updateData = buildAssistantArchitectBaseUpdates(data);

    const routingResult = data.modelRoutingMode === undefined && data.modelRoutingFamily === undefined
      ? { fields: {} }
      : resolveModelRoutingFields({
        modelRoutingMode: data.modelRoutingMode ?? currentTool.modelRoutingMode ?? "legacy",
        modelRoutingFamily: data.modelRoutingFamily !== undefined
          ? data.modelRoutingFamily
          : currentTool.modelRoutingFamily,
      });
    if ("error" in routingResult) {
      return { isSuccess: false, message: routingResult.error }
    }
    Object.assign(updateData, routingResult.fields);

    // Agentic mode fields (Issue #926) — resolved + validated in a helper to keep
    // this action's cyclomatic complexity bounded.
    const agentResult = await resolveAgenticUpdateFields(
      data,
      currentTool.mode,
      currentUserData.roles.map(r => r.name),
      currentUserData.user.id
    );
    if ("error" in agentResult) {
      return { isSuccess: false, message: agentResult.error }
    }
    Object.assign(updateData, agentResult.fields);

    if (Object.keys(updateData).length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    // Update via Drizzle — atomically deactivate capability when transitioning
    // from approved so the two writes either both succeed or both roll back.
    let updatedTool;
    if (needsCapabilityDeactivation) {
      updatedTool = await executeTransaction(
        async (tx) => {
          await tx
            .update(capabilities)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(capabilities.promptChainToolId, idInt));
          const result = await tx
            .update(assistantArchitects)
            .set({ ...updateData, updatedAt: new Date() })
            .where(eq(assistantArchitects.id, idInt))
            .returning();
          return result[0];
        },
        "deactivateAndUpdateApprovedArchitect"
      );
    } else {
      updatedTool = await drizzleUpdateAssistantArchitect(idInt, updateData);
    }

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

    // Get current user and admin status before applying the status guard so
    // that admins can bypass the draft/rejected restriction (issue #1000).
    const { getCurrentUserAction } = await import("@/actions/db/get-current-user-action");
    const currentUserResult = await getCurrentUserAction();

    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      log.error("Failed to get current user information")
      timer({ status: "error" })
      return { isSuccess: false, message: "Failed to verify user identity" }
    }

    const currentUser = currentUserResult.data.user;
    const isOwner = architect.userId === currentUser.id;
    const isAdmin = await hasRole("administrator");

    log.debug("Permission check", {
      userId: currentUser.id,
      assistantOwnerId: architect.userId,
      isOwner,
      isAdmin
    })

    // Non-admins may only delete assistants they own that are in draft or
    // rejected state. Admins can delete any assistant regardless of status.
    if (!isAdmin && architect.status !== 'draft' && architect.status !== 'rejected') {
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

    // deleteAssistantArchitect handles all FK-constrained cleanup atomically in one transaction
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
): Promise<ActionState<SelectToolInputField>> {
  const requestId = generateRequestId()
  const timer = startTimer("addToolInputField")
  const log = createLogger({ requestId, action: "addToolInputField" })

  try {
    log.info("Action started: Adding tool input field", { architectId, fieldName: data.name })

    const createdField = await createToolInputField({
      assistantArchitectId: Number.parseInt(architectId, 10),
      name: data.name,
      label: data.label ?? data.name,
      fieldType: mapFieldTypeToDb(data.type),
      position: data.position ?? 0,
      options: data.options ?? undefined
    });

    log.info("Tool input field added successfully", { architectId, fieldName: data.name })
    timer({ status: "success", architectId })

    return {
      isSuccess: true,
      message: "Tool input field added successfully",
      data: createdField
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

/** Update payload shape accepted by `updateToolInputField`. */
type ToolInputFieldUpdates = {
  name?: string;
  label?: string;
  fieldType?: "short_text" | "long_text" | "select" | "multi_select" | "file_upload";
  position?: number;
  options?: { values?: string[]; multiSelect?: boolean; placeholder?: string };
};

/**
 * Build the input-field update object from the provided payload, including only
 * fields that were supplied and defaulting an unset label to the name. Extracted
 * from updateInputFieldAction to keep that action's cyclomatic complexity bounded;
 * behavior is identical to the inline branches.
 */
function buildInputFieldUpdates(data: Partial<InsertToolInputField>): ToolInputFieldUpdates {
  const updates: ToolInputFieldUpdates = {};

  if (data.name !== undefined) updates.name = data.name;
  if (data.label !== undefined) updates.label = data.label;
  if (data.fieldType !== undefined) updates.fieldType = mapFieldTypeToDb(data.fieldType);
  if (data.position !== undefined) updates.position = data.position;
  if (data.options !== undefined && data.options !== null) updates.options = data.options;

  // Always ensure label is set to name if not provided
  if (!updates.label && updates.name) {
    updates.label = updates.name;
  }

  return updates;
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

    // Build update data. Branch logic is extracted to keep this action's
    // cyclomatic complexity bounded.
    const updates = buildInputFieldUpdates(data);

    if (Object.keys(updates).length === 0) {
      return { isSuccess: false, message: "No fields to update" }
    }

    const updatedField = await updateToolInputField(idInt, updates);

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

    // Scope caller-supplied field IDs to THIS tool (REV-COR-033) — same
    // confused-deputy fix as setPromptPositionsAction. updateToolInputField
    // filters by id alone, so without this a caller could reposition input
    // fields belonging to another user's tool by supplying their IDs.
    const toolFields = await getToolInputFields(toolIdInt);
    const allowedFieldIds = new Set(toolFields.map(f => f.id));
    const suppliedFieldIds = fieldOrders.map(({ id }) => Number.parseInt(id, 10));
    if (suppliedFieldIds.some(id => Number.isNaN(id) || !allowedFieldIds.has(id))) {
      log.warn("Rejected input field reorder with out-of-tool IDs", { toolId });
      return { isSuccess: false, message: "One or more fields do not belong to this tool" }
    }

    // Update each field's position
    const updatedFields = await Promise.all(
      fieldOrders.map(async ({ id, position }) => {
        const field = await updateToolInputField(Number.parseInt(id, 10), { position });
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
    modelId?: number
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

    // Auth: require a session and admin-or-creator ownership of the target
    // architect BEFORE any write, on ALL input shapes. Previously the only check
    // was conditional — inside the repositoryIds branch — leaving the common path
    // fully unauthenticated (REV-COR-031 / REV-SEC-041). Chain prompts are the
    // executable instructions of an assistant, so an unauthorized insert is stored
    // prompt injection into a possibly-approved, shared tool that others execute.
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn("Unauthorized addChainPrompt attempt");
      return { isSuccess: false, message: "Unauthorized" };
    }
    const architectIdInt = safeParseInt(architectId, 'architectId');
    const architect = await drizzleGetAssistantArchitectById(architectIdInt);
    if (!architect) {
      return { isSuccess: false, message: "Tool not found" };
    }
    const currentUserId = await authorizePromptMutation(architect.userId, log);

    const routingMode = architect.modelRoutingMode ?? "legacy";
    const fallbackModelId = routingMode === "legacy"
      ? data.modelId ?? (await getArchitectEnabledModels())[0]?.id
      : await resolveAutomaticPromptFallbackModelId(
        architect,
        currentUserId,
        data.modelId,
        data.enabledTools ?? []
      );
    if (!fallbackModelId) {
      return {
        isSuccess: false,
        message: routingMode === "legacy"
          ? "No Assistant Architect model is available"
          : "No accessible model in this routing mode supports all selected tools",
      };
    }

    // Validate enabled tools if provided
    if (data.enabledTools && data.enabledTools.length > 0) {
      const toolValidation = await validateEnabledToolsForRouting(
        data.enabledTools,
        architect,
        currentUserId,
        fallbackModelId
      );
      if (!toolValidation.isValid) {
        log.warn("Invalid tools provided", { invalidTools: toolValidation.invalidTools, message: toolValidation.message });
        return {
          isSuccess: false,
          message: toolValidation.message || `Invalid tools: ${toolValidation.invalidTools.join(', ')}`
        };
      }
    }

    // If repository IDs are provided, validate the caller has repository access
    // (the auth gate above already established the session + ownership).
    if (data.repositoryIds && data.repositoryIds.length > 0) {
      const hasAccess = await hasCapabilityAccess("knowledge-repositories");
      if (!hasAccess) {
        return { isSuccess: false, message: "Access denied. You need knowledge repository access." };
      }
    }

    await createChainPrompt({
      assistantArchitectId: architectIdInt,
      name: data.name,
      content: data.content,
      modelId: fallbackModelId,
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
    return handleError(error, "Failed to add chain prompt", {
      context: "addChainPrompt",
      requestId,
      operation: "addChainPrompt"
    })
  }
}

/** Update payload shape accepted by `updateChainPrompt` (ChainPromptUpdateData). */
type ChainPromptUpdates = {
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
};

/** True when a value is neither undefined nor null (matches `x !== undefined && x !== null`). */
function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/**
 * Assign the "present-only, copy-as-is" prompt fields. A field is copied only when
 * it is neither undefined nor null, matching the original inline branches. Split
 * out of buildChainPromptUpdates to keep cyclomatic complexity bounded.
 */
function assignPresentPromptUpdates(
  data: Partial<InsertChainPrompt>,
  updates: ChainPromptUpdates
): void {
  if (isPresent(data.name)) updates.name = data.name;
  if (isPresent(data.content)) updates.content = data.content;
  if (isPresent(data.modelId)) updates.modelId = data.modelId;
  if (isPresent(data.position)) updates.position = data.position;
  if (isPresent(data.repositoryIds)) updates.repositoryIds = data.repositoryIds;
  if (isPresent(data.enabledTools)) updates.enabledTools = data.enabledTools;
}

/**
 * Assign the "defined → coalesce null" prompt fields. A field is set whenever it is
 * defined (including explicit null), coalescing null/undefined to null, matching the
 * original inline branches. Split out of buildChainPromptUpdates to keep cyclomatic
 * complexity bounded.
 */
function assignNullablePromptUpdates(
  data: Partial<InsertChainPrompt>,
  updates: ChainPromptUpdates
): void {
  if (data.systemContext !== undefined) updates.systemContext = data.systemContext ?? null;
  if (data.parallelGroup !== undefined) updates.parallelGroup = data.parallelGroup ?? null;
  if (data.timeoutSeconds !== undefined) updates.timeoutSeconds = data.timeoutSeconds ?? null;
  if (data.inputMapping !== undefined) updates.inputMapping = data.inputMapping ?? null;
}

/**
 * Build the prompt update object from the provided payload, including only fields
 * that were supplied. Extracted from updatePromptAction to keep that action's
 * cyclomatic complexity bounded; behavior is identical to the inline branches.
 */
function buildChainPromptUpdates(data: Partial<InsertChainPrompt>): ChainPromptUpdates {
  const updates: ChainPromptUpdates = {};
  assignPresentPromptUpdates(data, updates);
  assignNullablePromptUpdates(data, updates);
  return updates;
}

/**
 * Validate a prompt's `enabledTools` update against the resolved model. Returns a
 * user-facing error message plus warn-log metadata when validation fails, or null
 * when there is nothing to validate or the tools are valid. Extracted from
 * updatePromptAction to keep that action's cyclomatic complexity bounded.
 */
async function validatePromptEnabledToolsUpdate(
  enabledTools: string[] | null | undefined,
  dataModelId: unknown,
  promptModelId: unknown,
  architect: Pick<SelectAssistantArchitect, "modelRoutingMode" | "modelRoutingFamily">,
  userId: number
): Promise<{ message: string; logMeta: { invalidTools: string[]; message?: string } } | null> {
  if (!enabledTools) return null;

  // Use provided modelId or fall back to existing prompt's modelId
  const modelIdToValidate = dataModelId ?? promptModelId;
  if (typeof modelIdToValidate !== "number" && typeof modelIdToValidate !== "string") {
    return {
      message: "Invalid model ID format",
      logMeta: { invalidTools: enabledTools, message: "Invalid model ID format" },
    };
  }
  const parsedModelId = Number(modelIdToValidate);
  if (!Number.isSafeInteger(parsedModelId) || parsedModelId <= 0) {
    return {
      message: "Invalid model ID format",
      logMeta: { invalidTools: enabledTools, message: "Invalid model ID format" },
    };
  }

  const toolValidation = await validateEnabledToolsForRouting(
    enabledTools,
    architect,
    userId,
    parsedModelId
  );
  if (toolValidation.isValid) return null;

  return {
    message: toolValidation.message || `Invalid tools: ${toolValidation.invalidTools.join(', ')}`,
    logMeta: { invalidTools: toolValidation.invalidTools, message: toolValidation.message }
  };
}

/**
 * Validate that the caller may attach the supplied repository IDs to a prompt.
 * Returns a user-facing error message when access is denied, or null when there
 * are no repository IDs to check or access is granted. Extracted from
 * updatePromptAction to keep that action's cyclomatic complexity bounded.
 */
async function validatePromptRepositoryAccessUpdate(
  repositoryIds: number[] | null | undefined
): Promise<string | null> {
  if (!repositoryIds || repositoryIds.length === 0) return null;
  const hasAccess = await hasCapabilityAccess("knowledge-repositories");
  if (!hasAccess) {
    return "Access denied. You need knowledge repository access.";
  }
  return null;
}

/**
 * Authorize a prompt mutation: resolve the current user (throwing authNoSession on
 * failure) and require admin-or-creator access (throwing authzToolAccessDenied
 * otherwise). Preserves the exact logging and thrown-error semantics of the inline
 * block. Extracted from updatePromptAction to keep that action's cyclomatic
 * complexity bounded.
 */
async function authorizePromptMutation(
  architectUserId: number | null,
  log: ReturnType<typeof createLogger>
): Promise<number> {
  const isAdmin = await hasRole("administrator");

  // Get current user with proper error handling
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess || !currentUser.data?.user?.id) {
    log.error("Failed to get current user for authorization check");
    throw ErrorFactories.authNoSession();
  }

  const currentUserId = currentUser.data.user.id;
  if (!isAdmin && architectUserId !== currentUserId) {
    log.warn("Authorization failed - user doesn't own resource", {
      userId: currentUserId,
      resourceOwnerId: architectUserId,
      isAdmin
    });
    throw ErrorFactories.authzToolAccessDenied("assistant_architect");
  }
  return currentUserId;
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
            modelId: chainPrompts.modelId,
            enabledTools: chainPrompts.enabledTools,
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

    // Only tool creator or admin can update prompts. Auth resolution (admin/creator
    // check, with the original throwing semantics) is extracted to keep this action's
    // cyclomatic complexity bounded.
    const currentUserId = await authorizePromptMutation(architect.userId, log);

    const routingMode = architect.modelRoutingMode ?? "legacy";
    const automaticFallbackModelId = routingMode === "legacy"
      ? null
      : await resolveAutomaticPromptFallbackModelId(
        architect,
        currentUserId,
        data.modelId ?? prompt.modelId ?? undefined,
        data.enabledTools ?? prompt.enabledTools ?? []
      );
    if (routingMode !== "legacy" && !automaticFallbackModelId) {
      return {
        isSuccess: false,
        message: "No accessible model in this routing mode supports all selected tools",
      };
    }
    const effectiveData: Partial<InsertChainPrompt> = automaticFallbackModelId
      ? { ...data, modelId: automaticFallbackModelId }
      : data;

    // Validate enabled tools if being updated. Branch logic is extracted to keep
    // this action's cyclomatic complexity bounded.
    const enabledToolsError = await validatePromptEnabledToolsUpdate(
      effectiveData.enabledTools,
      effectiveData.modelId,
      prompt.modelId,
      architect,
      currentUserId
    );
    if (enabledToolsError) {
      log.warn("Invalid tools provided for update", enabledToolsError.logMeta);
      return { isSuccess: false, message: enabledToolsError.message };
    }

    // If repository IDs are being updated, validate user has access.
    const repositoryAccessError = await validatePromptRepositoryAccessUpdate(effectiveData.repositoryIds);
    if (repositoryAccessError) {
      return { isSuccess: false, message: repositoryAccessError };
    }

    // Build update data matching ChainPromptUpdateData type. The branch logic is
    // extracted to keep this action's cyclomatic complexity bounded.
    const updates = buildChainPromptUpdates(effectiveData);

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

    const currentUserResult = await getCurrentUserAction()
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const userId = currentUserResult.data.user.id

    execution.userId = userId

    // CRITICAL: Drizzle's AWS Data API driver doesn't properly serialize JSONB.
    // The driver bypasses customType.toDriver() and passes objects directly,
    // causing RDS Data API to fail. We must use raw SQL to work around this.
    // See: Issue #599, https://github.com/drizzle-team/drizzle-orm/issues/724
    const inputData = execution.inputData && Object.keys(execution.inputData).length > 0
      ? execution.inputData
      : { __no_inputs: true };
    const inputDataJson = JSON.stringify(inputData);

    const executionResult = await executeQuery(
      (db) => db.execute(sql`
        INSERT INTO tool_executions (user_id, input_data, status, started_at, assistant_architect_id)
        VALUES (${execution.userId}, ${inputDataJson}::jsonb, 'pending', ${new Date().toISOString()}::timestamp, ${execution.assistantArchitectId})
        RETURNING id
      `),
      "createToolExecution"
    );

    // postgres.js returns result directly as array-like object (no .rows property - Issue #603)
    const rows = executionResult as unknown as Array<{ id: number }>;
    if (!rows || rows.length === 0 || !rows[0]?.id) {
      throw ErrorFactories.dbQueryFailed("INSERT INTO tool_executions", new Error("No rows returned"))
    }

    const executionId = rows[0].id

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

    const currentUserResult = await getCurrentUserAction()
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }

    const executionIdInt = Number.parseInt(executionId, 10)
    if (Number.isNaN(executionIdInt)) {
      return { isSuccess: false, message: "Invalid execution ID" }
    }

    // Ownership: the execution must belong to the caller (REV-COR-036). The
    // resolved user was previously dropped, so any authenticated user could
    // overwrite another user's execution output/status by iterating the integer
    // executionId — stored-content injection across users. Mirror the ownership
    // scoping in getExecutionResultsAction.
    const currentUserId = currentUserResult.data.user.id
    const execRows = await executeQuery(
      (db) =>
        db
          .select({ userId: toolExecutions.userId })
          .from(toolExecutions)
          .where(eq(toolExecutions.id, executionIdInt))
          .limit(1),
      "getExecutionOwnerForResultUpdate"
    )
    if (!execRows[0] || execRows[0].userId !== currentUserId) {
      log.warn("Prompt result update denied (not execution owner)", { executionId: executionIdInt })
      return { isSuccess: false, message: "Execution not found" }
    }

    // Build update object conditionally (matching promptResults schema)
    const updates: Partial<{
      outputData: string;
      errorMessage: string;
      executionTimeMs: number;
      status: "pending" | "running" | "completed" | "failed";
    }> = {}

    if (result.result !== undefined && typeof result.result === 'string') {
      updates.outputData = result.result
    }
    if (result.error !== undefined && typeof result.error === 'string') {
      updates.errorMessage = result.error
      updates.status = "failed"
    }
    if (result.executionTime !== undefined && typeof result.executionTime === 'number') {
      updates.executionTimeMs = result.executionTime
    }
    // A successful output write should mark the row completed (REV-COR-036);
    // previously only the error branch set a status, leaving successes stale.
    if (updates.outputData !== undefined && updates.errorMessage === undefined) {
      updates.status = "completed"
    }
    // Note: tokensUsed is not in the schema, so we ignore it

    if (Object.keys(updates).length === 0) {
      return { isSuccess: true, message: "No updates to apply", data: undefined }
    }

    await executeQuery(
      (db) =>
        db
          .update(promptResults)
          .set(updates)
          .where(and(eq(promptResults.executionId, executionIdInt), eq(promptResults.promptId, promptId))),
      "updatePromptResult"
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
    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can approve tools" }
    }

    const idInt = Number.parseInt(id, 10)
    if (Number.isNaN(idInt)) {
      return { isSuccess: false, message: "Invalid ID format" }
    }

    // Approve the assistant architect and create its capability entry (transaction)
    const updatedTool = await drizzleApproveAssistantArchitect(idInt)

    // Fetch the capability row created in the same approval transaction. Its id
    // backs both the navigation item (navigation_items.capability_id) and the
    // role grants (role_capabilities.capability_id).
    const [capability] = await executeQuery(
      (db) =>
        db
          .select({ id: capabilities.id })
          .from(capabilities)
          .where(eq(capabilities.promptChainToolId, idInt))
          .limit(1),
      "getCapabilityByPromptChainToolId"
    )

    if (!capability) {
      log.error("Capability not created after approval", { assistantArchitectId: idInt })
      return { isSuccess: false, message: "Capability creation failed" }
    }

    const finalCapabilityId = capability.id

    const navLink = `/tools/assistant-architect/${id}`

    // Resolve the target roles before the transaction (these are reads).
    const staffRole = await getRoleByName("staff")
    const adminRole = await getRoleByName("administrator")
    const roleIdsToGrant = [staffRole, adminRole]
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(r => r.id)

    // Wire the approved tool's access ATOMICALLY (REV-COR-037): the nav item and
    // BOTH role grants either all commit or all roll back, so a failure part-way
    // never leaves the tool approved-with-capability but half-wired (a nav item
    // no role can reach, or only one role granted). Idempotent — re-running after
    // a partial failure converges: the nav item is guarded by an existence check
    // and the grants use onConflictDoNothing on the unique (role_id, capability_id)
    // constraint. Replaces the previous non-transactional await-in-loop.
    await executeTransaction(async (tx) => {
      const existingNavTx = await tx
        .select({ id: navigationItems.id })
        .from(navigationItems)
        .where(eq(navigationItems.link, navLink))
        .limit(1)
      if (existingNavTx.length === 0) {
        // Gate the item on the architect's capability (navigation_items.capability_id, #928).
        await tx.insert(navigationItems).values({
          label: updatedTool.name,
          icon: "IconWand",
          link: navLink,
          type: "link",
          capabilityId: finalCapabilityId,
          isActive: true
        })
      }
      if (roleIdsToGrant.length > 0) {
        await tx
          .insert(roleCapabilities)
          .values(roleIdsToGrant.map(roleId => ({ roleId, capabilityId: finalCapabilityId })))
          .onConflictDoNothing()
      }
    }, "wireApprovedArchitectAccess")

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

    // Get current user ID
    const currentUserResult = await getCurrentUserAction()
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const currentUserId = currentUserResult.data.user.id

    // Get all capabilities the user has access to via role assignments
    // (#923 — reads the renamed capabilities/role_capabilities tables).
    const userTools = await executeQuery(
      (db) =>
        db
          .selectDistinct({ identifier: capabilities.identifier, promptChainToolId: capabilities.promptChainToolId })
          .from(capabilities)
          .innerJoin(roleCapabilities, eq(capabilities.id, roleCapabilities.capabilityId))
          .innerJoin(userRoles, eq(roleCapabilities.roleId, userRoles.roleId))
          .where(and(eq(userRoles.userId, currentUserId), eq(capabilities.isActive, true))),
      "getUserAccessibleTools"
    )

    if (userTools.length === 0) {
      return { isSuccess: true, message: "No assistants found", data: [] }
    }

    // Extract assistant architect IDs
    const architectIds = userTools
      .map(tool => tool.promptChainToolId)
      .filter((id): id is number => id !== null)

    if (architectIds.length === 0) {
      return { isSuccess: true, message: "No assistants found", data: [] }
    }

    // Fetch approved architects that the user has access to
    const approvedArchitects = await executeQuery(
      (db) =>
        db
          .select()
          .from(assistantArchitects)
          .where(
            and(
              eq(assistantArchitects.status, "approved"),
              inArray(assistantArchitects.id, architectIds)
            )
          )
          .orderBy(desc(assistantArchitects.createdAt)),
      "getApprovedArchitectsByIds"
    )

    if (approvedArchitects.length === 0) {
      return { isSuccess: true, message: "No approved architects found", data: [] }
    }

    // Fetch related fields and prompts for all approved architects
    const results: ArchitectWithRelations[] = await Promise.all(
      approvedArchitects.map(async (architect) => {
        const [inputFields, prompts] = await Promise.all([
          getToolInputFields(architect.id),
          getChainPrompts(architect.id)
        ])

        return {
          ...architect,
          inputFields,
          prompts
        }
      })
    )

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

    // Fetch prompts for validation. Input fields are now optional to support
    // scheduled/automated assistants without user inputs (PR #651)
    const prompts = await getChainPrompts(idInt);

    if (!tool.name || !tool.description || prompts.length === 0) {
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

    const executionIdInt = Number.parseInt(executionId, 10)
    if (Number.isNaN(executionIdInt)) {
      throw createError("Invalid execution ID", {
        code: "INVALID_INPUT",
        level: ErrorLevel.WARN
      })
    }

    // Get current user ID
    const currentUserResult = await getCurrentUserAction()
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      throw createError("User not found", {
        code: "NOT_FOUND",
        level: ErrorLevel.WARN
      })
    }
    const currentUserId = currentUserResult.data.user.id

    // Get execution details with user verification
    const [execution] = await executeQuery(
      (db) =>
        db
          .select()
          .from(toolExecutions)
          .where(and(eq(toolExecutions.id, executionIdInt), eq(toolExecutions.userId, currentUserId)))
          .limit(1),
      "getToolExecutionByIdAndUser"
    )

    if (!execution) {
      throw createError("Execution not found or access denied", {
        code: "NOT_FOUND",
        level: ErrorLevel.WARN,
        details: { executionId }
      })
    }

    // Get prompt results for this execution
    const promptResultsData = await executeQuery(
      (db) =>
        db
          .select()
          .from(promptResults)
          .where(eq(promptResults.executionId, executionIdInt))
          .orderBy(promptResults.startedAt),
      "getPromptResultsByExecution"
    )

    // Return data in the ExecutionResultDetails format
    const returnData: ExecutionResultDetails = {
      ...execution,
      promptResults: promptResultsData || []
    }

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

/** A tool the current user may enable for an agentic assistant (Issue #926). */
export interface AvailableAgentTool {
  /** Catalog `domain.action` identifier — what `agentEnabledTools` stores. */
  identifier: string;
  /** Model/human-facing tool name. */
  name: string;
  /** Description shown in the tools picker. */
  description: string;
}

/**
 * List the agent-callable tools the CURRENT user may enable for an agentic
 * assistant (Issue #926). Resolved from the unified catalog on the `internal`
 * surface, filtered by the user's role-derived scopes and `agentOnly`. The author
 * can only pick tools they themselves could invoke; the caller's scopes are
 * re-checked at execution time.
 */
export async function getAvailableAgentToolsAction(): Promise<ActionState<AvailableAgentTool[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAvailableAgentTools")
  const log = createLogger({ requestId, action: "getAvailableAgentTools" })

  try {
    const session = await getServerSession();
    if (!session || !session.sub) {
      return { isSuccess: false, message: "Unauthorized" }
    }
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const roleNames = currentUser.data.roles.map(r => r.name);
    const scopes = getScopesForRoles(roleNames);

    const entries = await toolCatalogInstance.list({
      surface: "internal",
      scopes,
      agentOnly: true,
    });
    const tools: AvailableAgentTool[] = entries.map(e => ({
      identifier: e.identifier,
      name: e.name,
      description: e.description,
    }));

    log.info("Available agent tools retrieved", { count: tools.length })
    timer({ status: "success", count: tools.length })
    return createSuccess(tools, "Available agent tools retrieved")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get available agent tools", {
      context: "getAvailableAgentTools",
      requestId,
    })
  }
}

/** One MCP connector the author may enable for an agentic assistant. */
export interface AvailableAgentConnector {
  id: string;
  name: string;
}

/**
 * List the MCP connectors the CURRENT user may enable for an agentic assistant
 * (Issue #926 — epic #922 completion audit: the backend accepted
 * `agentEnabledConnectors` but the editor had no way to populate it). Same
 * access source as the Nexus chat connector list (`getAvailableConnectors`);
 * `validateAgentConnectors` re-checks on save and the executor re-resolves per
 * caller at run time.
 */
export async function getAvailableAgentConnectorsAction(): Promise<ActionState<AvailableAgentConnector[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAvailableAgentConnectors")
  const log = createLogger({ requestId, action: "getAvailableAgentConnectors" })

  try {
    const session = await getServerSession();
    if (!session || !session.sub) {
      return { isSuccess: false, message: "Unauthorized" }
    }
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess || !currentUser.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const roleNames = currentUser.data.roles.map(r => r.name);

    const { getAvailableConnectors } = await import("@/lib/mcp/connector-service");
    const connectors = await getAvailableConnectors(currentUser.data.user.id, roleNames);
    const available: AvailableAgentConnector[] = connectors.map(c => ({
      id: c.id,
      name: c.name,
    }));

    log.info("Available agent connectors retrieved", { count: available.length })
    timer({ status: "success", count: available.length })
    return createSuccess(available, "Available agent connectors retrieved")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get available agent connectors", {
      context: "getAvailableAgentConnectors",
      requestId,
    })
  }
}

export async function getAiModelsAction(): Promise<ActionState<SelectAiModel[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAiModels")
  const log = createLogger({ requestId, action: "getAiModels" })
  
  try {
    log.info("Action started: Getting AI models")

    const aiModels = await getAIModels();

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

    const currentUserResult = await getCurrentUserAction();
    if (!currentUserResult.isSuccess || !currentUserResult.data) {
      return { isSuccess: false, message: "User not found" }
    }
    const userId = currentUserResult.data.user.id;

    const toolIdInt = Number.parseInt(toolId, 10);

    // Verify permissions
    const architect = await drizzleGetAssistantArchitectById(toolIdInt);

    if (!architect) {
      return { isSuccess: false, message: "Tool not found" }
    }

    const isAdmin = await hasRole("administrator");
    if (!isAdmin && architect.userId !== userId) {
      return { isSuccess: false, message: "Forbidden" }
    }

    // Scope the caller-supplied prompt IDs to THIS tool (REV-COR-033). The
    // ownership check above only authorizes `toolId`; updateChainPrompt filters
    // by id alone, so without this a caller who owns tool A could rewrite the
    // position/parallelGroup of prompts belonging to another user's (approved)
    // assistant B by supplying B's prompt IDs. Reject any id not in this tool.
    const toolPrompts = await getChainPrompts(toolIdInt);
    const allowedPromptIds = new Set(toolPrompts.map(p => p.id));
    const suppliedPromptIds = positions.map(({ id }) => Number.parseInt(id, 10));
    if (suppliedPromptIds.some(id => Number.isNaN(id) || !allowedPromptIds.has(id))) {
      log.warn("Rejected prompt position update with out-of-tool IDs", { toolId });
      return { isSuccess: false, message: "One or more prompts do not belong to this tool" }
    }

    // Update positions and parallel_group for each prompt
    // Use Promise.all for concurrent updates
    await Promise.all(
      positions.map(({ id, position, parallelGroup }) =>
        updateChainPrompt(Number.parseInt(id, 10), {
          position,
          parallelGroup: parallelGroup ?? null
        })
      )
    );

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

    // Check if user is an administrator
    const isAdmin = await hasRole("administrator");
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can view approved tools" }
    }

    // Get all approved tools
    const toolsResult = await getAssistantArchitectsByStatus("approved");

    if (!toolsResult || toolsResult.length === 0) {
      return {
        isSuccess: true,
        message: "No approved tools found",
        data: []
      }
    }

    // Get related data for each tool
    const toolsWithRelations = await Promise.all(
      toolsResult.map(async (tool) => {
        // Run input fields and prompts queries in parallel
        const [inputFields, prompts] = await Promise.all([
          getToolInputFields(tool.id),
          getChainPrompts(tool.id)
        ]);

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
    const isAdmin = await hasRole("administrator");
    if (!isAdmin) {
      return { isSuccess: false, message: "Only administrators can view all assistants" }
    }
    // Get all assistants
    const allAssistants = await drizzleGetAssistantArchitects();

    // Get related data for each assistant
    const assistantsWithRelations = await Promise.all(
      allAssistants.map(async (tool) => {
        const [inputFields, prompts] = await Promise.all([
          getToolInputFields(tool.id),
          getChainPrompts(tool.id)
        ]);

        return {
          ...tool,
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
