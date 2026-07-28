import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  createExportFile,
  getAssistantDataForExport,
  mapModelsForImport,
  validateImportFile,
  type ExportFormat,
  type ExportedAssistant,
} from "@/lib/assistant-export-import";
import {
  validateAgentConnectorsForAuthor,
  validateAgentToolsForAuthor,
} from "@/lib/assistant-architect/agent-config-validation";
import { validatePromptToolsForRouting } from "@/lib/assistant-architect/prompt-tool-validation";
import {
  checkUserRole,
  getAccessibleRepositoryIds,
  getRepositoriesByIds,
  getUserRoles,
} from "@/lib/db/drizzle";
import {
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  assistantArchitects,
  capabilities,
  chainPrompts,
  promptResults,
  toolExecutions,
  toolInputFields,
} from "@/lib/db/schema";
import {
  filterAccessibleResourceIds,
  userCanAccessResource,
} from "@/lib/db/drizzle/resource-access";
import type { ToolInputFieldOptions } from "@/lib/db/types/jsonb";
import { createLogger } from "@/lib/logger";
import { decodeMdxEditorEscapes } from "@/lib/utils/text-sanitizer";
import {
  assistantExecutionDeadlineStaleBefore,
  legacyAssistantExecutionStaleBefore,
} from "@/lib/assistant-architect/execution-coordinator";

export const IMPORTED_ASSISTANT_STATUS = "pending_approval" as const;

type ImportedAssistant = ExportFormat["assistants"][number];
type ImportedFieldType =
  "short_text" | "long_text" | "select" | "multi_select" | "file_upload";

export type AssistantImportServiceErrorCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT";

export class AssistantImportServiceError extends Error {
  constructor(
    public readonly code: AssistantImportServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssistantImportServiceError";
  }
}

export interface AssistantImportSuccess {
  name: string;
  id: number;
  status: typeof IMPORTED_ASSISTANT_STATUS;
}

export interface AssistantImportFailure {
  name: string;
  status: "error";
  error: string;
}

export type AssistantImportResult =
  AssistantImportSuccess | AssistantImportFailure;

export interface AssistantModelMapping {
  modelName: string;
  mappedToId: number;
}

export interface AssistantImportBatchResult {
  total: number;
  successful: number;
  failed: number;
  results: AssistantImportResult[];
  modelMappings: AssistantModelMapping[];
}

export interface AssistantMutationResult {
  result: AssistantImportSuccess;
  modelMappings: AssistantModelMapping[];
}

function asValidatedImport(data: unknown): ExportFormat {
  const validation = validateImportFile(data);
  if (!validation.valid) {
    throw new AssistantImportServiceError(
      "VALIDATION_ERROR",
      validation.error ?? "Invalid assistant import",
    );
  }
  return data as ExportFormat;
}

function modelMappings(modelMap: Map<string, number>): AssistantModelMapping[] {
  return Array.from(modelMap.entries()).map(([modelName, mappedToId]) => ({
    modelName,
    mappedToId,
  }));
}

async function mapImportModels(
  assistants: ExportedAssistant[],
): Promise<Map<string, number>> {
  const modelNames = new Set<string>();
  for (const assistant of assistants) {
    for (const prompt of assistant.prompts) {
      modelNames.add(prompt.model_name);
    }
  }
  return mapModelsForImport(Array.from(modelNames));
}

async function validateImportedPromptResourceAccess(
  assistants: ExportedAssistant[],
  modelMap: Map<string, number>,
  authorUserId: number,
): Promise<void> {
  const modelIds = new Set<number>();
  const repositoryIds = new Set<number>();
  for (const assistant of assistants) {
    for (const prompt of assistant.prompts) {
      const modelId = modelMap.get(prompt.model_name);
      if (!modelId) {
        throw new AssistantImportServiceError(
          "VALIDATION_ERROR",
          "One or more prompt models are unavailable",
        );
      }
      modelIds.add(modelId);
      for (const repositoryId of prompt.repository_ids ?? []) {
        repositoryIds.add(repositoryId);
      }
    }
  }

  try {
    const accessibleModelIds = await filterAccessibleResourceIds(
      authorUserId,
      "model",
      [...modelIds],
    );
    if (
      accessibleModelIds.size !== modelIds.size ||
      [...modelIds].some(
        (modelId) => !accessibleModelIds.has(String(modelId)),
      )
    ) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        "One or more prompt models are unavailable",
      );
    }

    if (repositoryIds.size === 0) return;
    const accessibleRepositoryIds = await getAccessibleRepositoryIds(
      [...repositoryIds],
      authorUserId,
    );
    const accessibleRepositoryIdSet = new Set(accessibleRepositoryIds);
    if (
      accessibleRepositoryIdSet.size !== repositoryIds.size ||
      [...repositoryIds].some(
        (repositoryId) => !accessibleRepositoryIdSet.has(repositoryId),
      )
    ) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        "One or more prompt repositories are unavailable",
      );
    }

    const repositories = await getRepositoriesByIds([...repositoryIds]);
    if (
      repositories.length !== repositoryIds.size ||
      repositories.some(
        (repository) =>
          repository.repositoryKind !== "durable" ||
          repository.lifecycleStatus !== "active",
      )
    ) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        "One or more prompt repositories are unavailable",
      );
    }
  } catch (error) {
    if (error instanceof AssistantImportServiceError) throw error;
    throw new AssistantImportServiceError(
      "VALIDATION_ERROR",
      "Unable to validate prompt resource access",
    );
  }
}

async function validateImportedPromptTools(
  assistants: ExportedAssistant[],
  modelMap: Map<string, number>,
  authorUserId: number,
): Promise<void> {
  for (const assistant of assistants) {
    for (const prompt of assistant.prompts) {
      const enabledTools = prompt.enabled_tools ?? [];
      if (enabledTools.length === 0) continue;
      const mappedModelId = modelMap.get(prompt.model_name);
      if (!mappedModelId) continue;

      const validation = await validatePromptToolsForRouting(
        enabledTools,
        {
          modelRoutingMode: assistant.model_routing_mode,
          modelRoutingFamily: assistant.model_routing_family,
        },
        authorUserId,
        mappedModelId,
      );
      if (!validation.isValid) {
        throw new AssistantImportServiceError(
          "VALIDATION_ERROR",
          validation.message ?? "Invalid prompt tools",
        );
      }
    }
  }
}

async function validateAgentAuthoringPermissions(
  assistants: ExportedAssistant[],
  authorUserId: number,
): Promise<void> {
  const hasAgentResources = assistants.some(
    (assistant) =>
      (assistant.agent_enabled_tools?.length ?? 0) > 0 ||
      (assistant.agent_enabled_connectors?.length ?? 0) > 0,
  );
  if (!hasAgentResources) return;

  const authorRoleNames = await getUserRoles(authorUserId);

  for (const assistant of assistants) {
    const toolValidation = await validateAgentToolsForAuthor(
      assistant.agent_enabled_tools ?? [],
      authorRoleNames,
    );
    if (!toolValidation.isValid) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        toolValidation.message ?? "Invalid agent tools",
      );
    }

    const connectorError = await validateAgentConnectorsForAuthor(
      assistant.agent_enabled_connectors ?? [],
      authorUserId,
      authorRoleNames,
    );
    if (connectorError) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        connectorError,
      );
    }
  }
}

function importedFieldType(value: string): ImportedFieldType {
  switch (value) {
    case "short_text":
    case "long_text":
    case "select":
    case "multi_select":
    case "file_upload":
      return value;
    default:
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        `Unsupported input field type: ${value}`,
      );
  }
}

async function insertImportedPrompts(
  tx: DbTransaction,
  assistantId: number,
  assistant: ImportedAssistant,
  modelMap: Map<string, number>,
): Promise<void> {
  for (const prompt of assistant.prompts) {
    const modelId = modelMap.get(prompt.model_name);
    if (!modelId) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        "One or more prompt models are unavailable",
      );
    }

    await tx.insert(chainPrompts).values({
      assistantArchitectId: assistantId,
      name: prompt.name,
      content: decodeMdxEditorEscapes(prompt.content),
      systemContext: prompt.system_context
        ? decodeMdxEditorEscapes(prompt.system_context)
        : (prompt.system_context ?? null),
      modelId,
      position: prompt.position,
      parallelGroup: prompt.parallel_group ?? null,
      inputMapping: prompt.input_mapping ?? null,
      timeoutSeconds: prompt.timeout_seconds ?? null,
      repositoryIds: prompt.repository_ids ?? [],
      enabledTools: prompt.enabled_tools ?? [],
    });
  }
}

async function insertImportedFields(
  tx: DbTransaction,
  assistantId: number,
  assistant: ImportedAssistant,
): Promise<void> {
  for (const field of assistant.input_fields) {
    await tx.insert(toolInputFields).values({
      assistantArchitectId: assistantId,
      name: field.name,
      label: field.label,
      fieldType: importedFieldType(field.field_type),
      position: field.position,
      options: (field.options as ToolInputFieldOptions | undefined) ?? null,
    });
  }
}

function importedAssistantRuntimeValues(assistant: ImportedAssistant) {
  return {
    mode: assistant.mode ?? "prompt_chain",
    modelRoutingMode: assistant.model_routing_mode ?? "legacy",
    modelRoutingFamily: assistant.model_routing_family ?? null,
    agentEnabledTools: assistant.agent_enabled_tools ?? [],
    agentEnabledConnectors: assistant.agent_enabled_connectors ?? [],
    agentMaxSteps: assistant.agent_max_steps ?? 10,
    agentTimeoutSeconds: assistant.agent_timeout_seconds ?? 300,
    agentCostCapCents: assistant.agent_cost_cap_cents ?? null,
    agentMaxRequestsPerHour: assistant.agent_max_requests_per_hour ?? null,
    retrievalScope: assistant.retrieval_scope ?? null,
  };
}

async function insertAssistantGraph(
  tx: DbTransaction,
  assistant: ImportedAssistant,
  modelMap: Map<string, number>,
  userId: number,
): Promise<AssistantImportSuccess> {
  const [createdAssistant] = await tx
    .insert(assistantArchitects)
    .values({
      name: assistant.name,
      description: assistant.description || "",
      status: IMPORTED_ASSISTANT_STATUS,
      imagePath: assistant.image_path ?? null,
      isParallel: assistant.is_parallel ?? false,
      timeoutSeconds: assistant.timeout_seconds ?? null,
      userId,
      ...importedAssistantRuntimeValues(assistant),
    })
    .returning({ id: assistantArchitects.id });

  if (!createdAssistant) {
    throw new Error("Assistant insert did not return a row");
  }

  await insertImportedPrompts(tx, createdAssistant.id, assistant, modelMap);
  await insertImportedFields(tx, createdAssistant.id, assistant);

  return {
    name: assistant.name,
    id: createdAssistant.id,
    status: IMPORTED_ASSISTANT_STATUS,
  };
}

/**
 * Create every assistant from an ExportFormat envelope.
 *
 * Each assistant graph is isolated in its own transaction so one failed prompt
 * or input-field insert rolls back that assistant without discarding successful
 * siblings in the same import file.
 */
export async function createAssistantsFromImport(
  data: unknown,
  userId: number,
  options: {
    throwOnAssistantFailure?: boolean;
    /**
     * Internal policy hook used when the create is derived from another
     * protected object. It runs in the same transaction immediately before
     * the new assistant row is inserted.
     */
    beforeAssistantInsert?: (tx: DbTransaction) => Promise<void>;
  } = {},
): Promise<AssistantImportBatchResult> {
  const importData = asValidatedImport(data);
  await validateAgentAuthoringPermissions(importData.assistants, userId);
  const modelMap = await mapImportModels(importData.assistants);
  await validateImportedPromptResourceAccess(
    importData.assistants,
    modelMap,
    userId,
  );
  await validateImportedPromptTools(importData.assistants, modelMap, userId);
  const log = createLogger({ action: "createAssistantsFromImport" });
  const results: AssistantImportResult[] = [];

  for (const assistant of importData.assistants) {
    try {
      const result = await executeTransaction(
        async (tx) => {
          await options.beforeAssistantInsert?.(tx);
          return insertAssistantGraph(tx, assistant, modelMap, userId);
        },
        "createAssistantFromImport",
      );
      results.push(result);
    } catch (error) {
      if (options.throwOnAssistantFailure) throw error;
      const internalMessage =
        error instanceof Error ? error.message : "Unknown import error";
      log.error("Assistant import failed", {
        assistantName: assistant.name,
        error: internalMessage,
      });
      results.push({
        name: assistant.name,
        status: "error",
        error:
          error instanceof AssistantImportServiceError
            ? error.message
            : "Failed to import assistant",
      });
    }
  }

  const successful = results.filter(
    (result) => result.status === IMPORTED_ASSISTANT_STATUS,
  ).length;
  return {
    total: importData.assistants.length,
    successful,
    failed: importData.assistants.length - successful,
    results,
    modelMappings: modelMappings(modelMap),
  };
}

async function replaceAssistantGraph(
  tx: DbTransaction,
  assistantId: number,
  assistant: ImportedAssistant,
  modelMap: Map<string, number>,
): Promise<AssistantImportSuccess> {
  await tx
    .update(capabilities)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(capabilities.promptChainToolId, assistantId));

  const [updated] = await tx
    .update(assistantArchitects)
    .set({
      name: assistant.name,
      description: assistant.description || "",
      status: IMPORTED_ASSISTANT_STATUS,
      imagePath: assistant.image_path ?? null,
      isParallel: assistant.is_parallel ?? false,
      timeoutSeconds: assistant.timeout_seconds ?? null,
      ...importedAssistantRuntimeValues(assistant),
      updatedAt: new Date(),
    })
    .where(eq(assistantArchitects.id, assistantId))
    .returning({ id: assistantArchitects.id });

  if (!updated) {
    throw new AssistantImportServiceError(
      "NOT_FOUND",
      `Assistant not found: ${assistantId}`,
    );
  }

  const historicalPromptRows = await tx
    .select({ id: chainPrompts.id })
    .from(chainPrompts)
    .innerJoin(promptResults, eq(promptResults.promptId, chainPrompts.id))
    .where(eq(chainPrompts.assistantArchitectId, assistantId));
  const historicalPromptIds = Array.from(
    new Set(historicalPromptRows.map(({ id }) => id)),
  );
  if (historicalPromptIds.length > 0) {
    await tx
      .update(chainPrompts)
      .set({ assistantArchitectId: null, updatedAt: new Date() })
      .where(inArray(chainPrompts.id, historicalPromptIds));
  }

  await tx
    .delete(chainPrompts)
    .where(eq(chainPrompts.assistantArchitectId, assistantId));
  await tx
    .delete(toolInputFields)
    .where(eq(toolInputFields.assistantArchitectId, assistantId));
  await insertImportedPrompts(tx, assistantId, assistant, modelMap);
  await insertImportedFields(tx, assistantId, assistant);

  return {
    name: assistant.name,
    id: updated.id,
    status: IMPORTED_ASSISTANT_STATUS,
  };
}

/**
 * Replace an assistant's import-controlled fields, prompts, and input fields.
 * The assistant owner or an administrator may update it. The entire replacement
 * is atomic and every update resets the human approval gate.
 */
export async function updateAssistantFromImport(
  assistantId: number,
  data: unknown,
  callerUserId: number,
): Promise<AssistantMutationResult> {
  const importData = asValidatedImport(data);
  if (importData.assistants.length !== 1) {
    throw new AssistantImportServiceError(
      "VALIDATION_ERROR",
      "Update requires exactly one assistant in the import envelope",
    );
  }

  const assistant = importData.assistants[0];
  await validateAgentAuthoringPermissions([assistant], callerUserId);
  const modelMap = await mapImportModels([assistant]);
  await validateImportedPromptResourceAccess(
    [assistant],
    modelMap,
    callerUserId,
  );
  await validateImportedPromptTools([assistant], modelMap, callerUserId);
  const result = await executeTransaction(async (tx) => {
    const [existing] = await tx
      .select({
        userId: assistantArchitects.userId,
        mode: assistantArchitects.mode,
      })
      .from(assistantArchitects)
      .where(eq(assistantArchitects.id, assistantId))
      .limit(1)
      .for("update");

    if (!existing) {
      throw new AssistantImportServiceError(
        "NOT_FOUND",
        `Assistant not found: ${assistantId}`,
      );
    }
    const isAdmin = await checkUserRole(
      callerUserId,
      "administrator",
      tx,
    );
    if (!isAdmin && existing.userId !== callerUserId) {
      throw new AssistantImportServiceError(
        "NOT_FOUND",
        `Assistant not found: ${assistantId}`,
      );
    }
    if (
      existing.mode === "agentic" &&
      (assistant.mode ?? "prompt_chain") === "prompt_chain"
    ) {
      throw new AssistantImportServiceError(
        "VALIDATION_ERROR",
        "Cannot convert an agentic assistant back to prompt-chain mode",
      );
    }

    const now = new Date();
    const staleDeadlineBefore =
      assistantExecutionDeadlineStaleBefore(now);
    const legacyStaleBefore =
      legacyAssistantExecutionStaleBefore(now);
    await tx
      .update(toolExecutions)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: "Execution expired before assistant update",
      })
      .where(
        and(
          eq(toolExecutions.assistantArchitectId, assistantId),
          inArray(toolExecutions.status, ["pending", "running"]),
          or(
            lt(toolExecutions.deadlineAt, staleDeadlineBefore),
            and(
              isNull(toolExecutions.deadlineAt),
              lt(toolExecutions.startedAt, legacyStaleBefore),
            ),
          ),
        ),
      );

    const activeExecutions = await tx
      .select({ id: toolExecutions.id })
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.assistantArchitectId, assistantId),
          inArray(toolExecutions.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (activeExecutions.length > 0) {
      throw new AssistantImportServiceError(
        "CONFLICT",
        "Assistant cannot be updated while an execution is in progress",
      );
    }

    return replaceAssistantGraph(tx, assistantId, assistant, modelMap);
  }, "updateAssistantFromImport");

  return { result, modelMappings: modelMappings(modelMap) };
}

async function requireForkSourceAccess(
  tx: DbTransaction,
  assistantId: number,
  callerUserId: number,
  notFound: () => AssistantImportServiceError,
): Promise<void> {
  const [source] = await tx
    .select({
      userId: assistantArchitects.userId,
      status: assistantArchitects.status,
    })
    .from(assistantArchitects)
    .where(eq(assistantArchitects.id, assistantId))
    .limit(1)
    .for("update");

  if (!source) throw notFound();

  const isAdmin = await checkUserRole(
    callerUserId,
    "administrator",
    tx,
  );
  const hasBaseVisibility =
    source.userId === callerUserId ||
    isAdmin ||
    source.status === "approved";
  if (!hasBaseVisibility) throw notFound();

  const hasResourceVisibility = await userCanAccessResource(
    callerUserId,
    "assistant",
    assistantId,
    { ownerUserId: source.userId },
    tx,
  );
  if (!hasResourceVisibility) throw notFound();
}

/**
 * Fork a visible assistant through the existing portable export format.
 * Visibility denials are deliberately existence-masked as 404-equivalent
 * service errors. The source is read only; the fork is owned by the caller.
 */
export async function forkAssistant(
  assistantId: number,
  callerUserId: number,
  nameOverride?: string,
): Promise<AssistantMutationResult> {
  const notFound = () =>
    new AssistantImportServiceError(
      "NOT_FOUND",
      `Assistant not found: ${assistantId}`,
    );
  const exportedSource = await executeTransaction(
    async (tx) => {
      await requireForkSourceAccess(
        tx,
        assistantId,
        callerUserId,
        notFound,
      );

      const exported = await getAssistantDataForExport([assistantId], tx);
      const snapshot = exported[0];
      if (!snapshot) throw notFound();
      return snapshot;
    },
    "getAssistantForForkSnapshot",
    { isolationLevel: "repeatable read" },
  );

  const forkData = createExportFile([
    {
      ...exportedSource,
      ...(nameOverride !== undefined ? { name: nameOverride } : {}),
    },
  ]);
  const created = await createAssistantsFromImport(
    forkData,
    callerUserId,
    {
      throwOnAssistantFailure: true,
      // Model/tool/repository authoring validation happens after the source
      // snapshot. Re-read current source visibility in the destination create
      // transaction so a revocation committed during that work fails before
      // any copied row is persisted.
      beforeAssistantInsert: async (tx) => {
        await requireForkSourceAccess(
          tx,
          assistantId,
          callerUserId,
          notFound,
        );
      },
    },
  );
  const result = created.results[0];
  if (!result || result.status === "error") {
    throw new AssistantImportServiceError(
      "VALIDATION_ERROR",
      result?.error ?? "Failed to fork assistant",
    );
  }

  return {
    result,
    modelMappings: created.modelMappings,
  };
}
