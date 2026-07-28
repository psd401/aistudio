import { eq, inArray } from "drizzle-orm";
import {
  createExportFile,
  getAssistantDataForExport,
  mapModelsForImport,
  validateImportFile,
  type ExportFormat,
  type ExportedAssistant,
} from "@/lib/assistant-export-import";
import { checkUserRole } from "@/lib/db/drizzle";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  assistantArchitects,
  chainPrompts,
  promptResults,
  toolInputFields,
} from "@/lib/db/schema";
import { userCanAccessResource } from "@/lib/db/drizzle/resource-access";
import type { ToolInputFieldOptions } from "@/lib/db/types/jsonb";
import { createLogger } from "@/lib/logger";
import { decodeMdxEditorEscapes } from "@/lib/utils/text-sanitizer";

export const IMPORTED_ASSISTANT_STATUS = "pending_approval" as const;

type ImportedAssistant = ExportFormat["assistants"][number];
type ImportedFieldType =
  "short_text" | "long_text" | "select" | "multi_select" | "file_upload";

export type AssistantImportServiceErrorCode =
  "VALIDATION_ERROR" | "NOT_FOUND" | "FORBIDDEN";

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
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  for (const prompt of assistant.prompts) {
    const modelId = modelMap.get(prompt.model_name);
    if (!modelId) {
      log.warn("Skipping imported prompt without an active model mapping", {
        assistantName: assistant.name,
        promptName: prompt.name,
        modelName: prompt.model_name,
      });
      continue;
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
  log: ReturnType<typeof createLogger>,
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

  await insertImportedPrompts(tx, createdAssistant.id, assistant, modelMap, log);
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
): Promise<AssistantImportBatchResult> {
  const importData = asValidatedImport(data);
  const modelMap = await mapImportModels(importData.assistants);
  const log = createLogger({ action: "createAssistantsFromImport" });
  const results: AssistantImportResult[] = [];

  for (const assistant of importData.assistants) {
    try {
      const result = await executeTransaction(
        (tx) => insertAssistantGraph(tx, assistant, modelMap, userId, log),
        "createAssistantFromImport",
      );
      results.push(result);
    } catch (error) {
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
  log: ReturnType<typeof createLogger>,
): Promise<AssistantImportSuccess> {
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
  await insertImportedPrompts(tx, assistantId, assistant, modelMap, log);
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
  const modelMap = await mapImportModels([assistant]);
  const isAdmin = await checkUserRole(callerUserId, "administrator");
  const log = createLogger({
    action: "updateAssistantFromImport",
    assistantId,
  });

  const result = await executeTransaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: assistantArchitects.userId })
      .from(assistantArchitects)
      .where(eq(assistantArchitects.id, assistantId))
      .limit(1);

    if (!existing) {
      throw new AssistantImportServiceError(
        "NOT_FOUND",
        `Assistant not found: ${assistantId}`,
      );
    }
    if (!isAdmin && existing.userId !== callerUserId) {
      throw new AssistantImportServiceError(
        "FORBIDDEN",
        "You do not have permission to update this assistant",
      );
    }

    return replaceAssistantGraph(tx, assistantId, assistant, modelMap, log);
  }, "updateAssistantFromImport");

  return { result, modelMappings: modelMappings(modelMap) };
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
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          userId: assistantArchitects.userId,
          status: assistantArchitects.status,
        })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, assistantId))
        .limit(1),
    "getAssistantForFork",
  );
  const source = rows[0];
  const notFound = () =>
    new AssistantImportServiceError(
      "NOT_FOUND",
      `Assistant not found: ${assistantId}`,
    );

  if (!source) throw notFound();

  const isAdmin = await checkUserRole(callerUserId, "administrator");
  const hasBaseVisibility =
    source.userId === callerUserId || isAdmin || source.status === "approved";
  if (!hasBaseVisibility) throw notFound();

  const hasResourceVisibility = await userCanAccessResource(
    callerUserId,
    "assistant",
    assistantId,
    { ownerUserId: source.userId },
  );
  if (!hasResourceVisibility) throw notFound();

  const exported = await getAssistantDataForExport([assistantId]);
  const exportedSource = exported[0];
  if (!exportedSource) throw notFound();

  const forkData = createExportFile([
    {
      ...exportedSource,
      ...(nameOverride !== undefined ? { name: nameOverride } : {}),
    },
  ]);
  const created = await createAssistantsFromImport(forkData, callerUserId);
  const result = created.results[0];
  if (!result || result.status === "error") {
    throw new Error(result?.error ?? "Failed to fork assistant");
  }

  return {
    result,
    modelMappings: created.modelMappings,
  };
}
