/**
 * Drizzle Chain Prompts Operations
 *
 * Chain Prompts CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #532 - Migrate AI Models & Configuration queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, asc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  chainPrompts,
  aiModels,
  toolInputFields,
} from "@/lib/db/schema";
import { createLogger, generateRequestId } from "@/lib/logger";

// ============================================
// Types
// ============================================

export interface ChainPromptData {
  name: string;
  content: string;
  modelId: number;
  assistantArchitectId: number;
  position?: number;
  parallelGroup?: number | null;
  inputMapping?: Record<string, string> | null;
  timeoutSeconds?: number | null;
  systemContext?: string | null;
  repositoryIds?: number[];
  enabledTools?: string[];
}

export interface ChainPromptUpdateData {
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
}

export interface ChainPromptWithModel {
  id: number;
  name: string;
  content: string;
  modelId: number;
  position: number;
  parallelGroup: number | null;
  inputMapping: Record<string, string> | null;
  timeoutSeconds: number | null;
  systemContext: string | null;
  assistantArchitectId: number | null;
  repositoryIds: number[];
  enabledTools: string[];
  createdAt: Date;
  updatedAt: Date;
  model: {
    id: number;
    name: string;
    provider: string;
    modelId: string;
    active: boolean;
  } | null;
}

// ============================================
// Chain Prompt Query Operations
// ============================================

/**
 * Get all chain prompts for an assistant architect
 */
export async function getChainPrompts(assistantArchitectId: number) {
  return executeQuery(
    (db) =>
      db
        .select({
          id: chainPrompts.id,
          name: chainPrompts.name,
          content: chainPrompts.content,
          modelId: chainPrompts.modelId,
          position: chainPrompts.position,
          parallelGroup: chainPrompts.parallelGroup,
          inputMapping: chainPrompts.inputMapping,
          timeoutSeconds: chainPrompts.timeoutSeconds,
          systemContext: chainPrompts.systemContext,
          assistantArchitectId: chainPrompts.assistantArchitectId,
          repositoryIds: chainPrompts.repositoryIds,
          enabledTools: chainPrompts.enabledTools,
          createdAt: chainPrompts.createdAt,
          updatedAt: chainPrompts.updatedAt,
        })
        .from(chainPrompts)
        .where(eq(chainPrompts.assistantArchitectId, assistantArchitectId))
        .orderBy(asc(chainPrompts.position)),
    "getChainPrompts"
  );
}

/**
 * Get chain prompt by ID
 */
export async function getChainPromptById(id: number) {
  const result = await executeQuery(
    (db) =>
      db.select().from(chainPrompts).where(eq(chainPrompts.id, id)).limit(1),
    "getChainPromptById"
  );

  return result[0] || null;
}

/**
 * Get chain prompt with model info
 */
export async function getChainPromptWithModel(
  id: number
): Promise<ChainPromptWithModel | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: chainPrompts.id,
          name: chainPrompts.name,
          content: chainPrompts.content,
          modelId: chainPrompts.modelId,
          position: chainPrompts.position,
          parallelGroup: chainPrompts.parallelGroup,
          inputMapping: chainPrompts.inputMapping,
          timeoutSeconds: chainPrompts.timeoutSeconds,
          systemContext: chainPrompts.systemContext,
          assistantArchitectId: chainPrompts.assistantArchitectId,
          repositoryIds: chainPrompts.repositoryIds,
          enabledTools: chainPrompts.enabledTools,
          createdAt: chainPrompts.createdAt,
          updatedAt: chainPrompts.updatedAt,
          modelDbId: aiModels.id,
          modelName: aiModels.name,
          modelProvider: aiModels.provider,
          modelModelId: aiModels.modelId,
          modelActive: aiModels.active,
        })
        .from(chainPrompts)
        .leftJoin(aiModels, eq(chainPrompts.modelId, aiModels.id))
        .where(eq(chainPrompts.id, id))
        .limit(1),
    "getChainPromptWithModel"
  );

  if (!result[0]) return null;

  const row = result[0];
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    modelId: row.modelId,
    position: row.position,
    parallelGroup: row.parallelGroup,
    inputMapping: row.inputMapping,
    timeoutSeconds: row.timeoutSeconds,
    systemContext: row.systemContext,
    assistantArchitectId: row.assistantArchitectId,
    repositoryIds: row.repositoryIds ?? [],
    enabledTools: row.enabledTools ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    model: row.modelDbId
      ? {
          id: row.modelDbId,
          name: row.modelName!,
          provider: row.modelProvider!,
          modelId: row.modelModelId!,
          active: row.modelActive!,
        }
      : null,
  };
}

/**
 * Get all chain prompts with model info for an assistant architect
 */
export async function getChainPromptsWithModels(
  assistantArchitectId: number
): Promise<ChainPromptWithModel[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: chainPrompts.id,
          name: chainPrompts.name,
          content: chainPrompts.content,
          modelId: chainPrompts.modelId,
          position: chainPrompts.position,
          parallelGroup: chainPrompts.parallelGroup,
          inputMapping: chainPrompts.inputMapping,
          timeoutSeconds: chainPrompts.timeoutSeconds,
          systemContext: chainPrompts.systemContext,
          assistantArchitectId: chainPrompts.assistantArchitectId,
          repositoryIds: chainPrompts.repositoryIds,
          enabledTools: chainPrompts.enabledTools,
          createdAt: chainPrompts.createdAt,
          updatedAt: chainPrompts.updatedAt,
          modelDbId: aiModels.id,
          modelName: aiModels.name,
          modelProvider: aiModels.provider,
          modelModelId: aiModels.modelId,
          modelActive: aiModels.active,
        })
        .from(chainPrompts)
        .leftJoin(aiModels, eq(chainPrompts.modelId, aiModels.id))
        .where(eq(chainPrompts.assistantArchitectId, assistantArchitectId))
        .orderBy(asc(chainPrompts.position)),
    "getChainPromptsWithModels"
  );

  return result.map((row) => ({
    id: row.id,
    name: row.name,
    content: row.content,
    modelId: row.modelId,
    position: row.position,
    parallelGroup: row.parallelGroup,
    inputMapping: row.inputMapping,
    timeoutSeconds: row.timeoutSeconds,
    systemContext: row.systemContext,
    assistantArchitectId: row.assistantArchitectId,
    repositoryIds: row.repositoryIds ?? [],
    enabledTools: row.enabledTools ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    model: row.modelDbId
      ? {
          id: row.modelDbId,
          name: row.modelName!,
          provider: row.modelProvider!,
          modelId: row.modelModelId!,
          active: row.modelActive!,
        }
      : null,
  }));
}

/**
 * Get chain prompts by model ID
 */
export async function getChainPromptsByModelId(modelId: number) {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(chainPrompts)
        .where(eq(chainPrompts.modelId, modelId))
        .orderBy(chainPrompts.assistantArchitectId, asc(chainPrompts.position)),
    "getChainPromptsByModelId"
  );
}

// ============================================
// Chain Prompt CRUD Operations
// ============================================

/**
 * Create a new chain prompt
 */
export async function createChainPrompt(data: ChainPromptData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(chainPrompts)
        .values({
          name: data.name,
          content: data.content,
          modelId: data.modelId,
          assistantArchitectId: data.assistantArchitectId,
          position: data.position ?? 0,
          parallelGroup: data.parallelGroup,
          inputMapping: data.inputMapping,
          timeoutSeconds: data.timeoutSeconds,
          systemContext: data.systemContext,
          repositoryIds: data.repositoryIds ?? [],
          enabledTools: data.enabledTools ?? [],
        })
        .returning(),
    "createChainPrompt"
  );
  return result[0];
}

/**
 * Update a chain prompt
 */
export async function updateChainPrompt(
  id: number,
  updates: ChainPromptUpdateData
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(chainPrompts)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(chainPrompts.id, id))
        .returning(),
    "updateChainPrompt"
  );
  return result[0];
}

/**
 * Delete a chain prompt
 */
export async function deleteChainPrompt(id: number) {
  const result = await executeQuery(
    (db) => db.delete(chainPrompts).where(eq(chainPrompts.id, id)).returning(),
    "deleteChainPrompt"
  );
  return result[0];
}

/**
 * Reorder chain prompts within an assistant architect
 */
export async function reorderChainPrompts(
  assistantArchitectId: number,
  orderedIds: number[]
) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, function: "reorderChainPrompts" });

  log.info("Reordering chain prompts", {
    assistantArchitectId,
    count: orderedIds.length,
  });

  return executeQuery(
    (db) => db.transaction(async (tx) => {
      // Update each prompt's position in parallel within transaction
      const updates = orderedIds.map((promptId, position) =>
        tx
          .update(chainPrompts)
          .set({
            position,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chainPrompts.id, promptId),
              eq(chainPrompts.assistantArchitectId, assistantArchitectId)
            )
          )
      );
      await Promise.all(updates);

      log.info("Chain prompts reordered successfully", {
        assistantArchitectId,
        count: orderedIds.length,
      });

      return { success: true, count: orderedIds.length };
    }),
    "reorderChainPromptsTransaction"
  );
}

// ============================================
// Tool Input Fields Operations
// ============================================

/** Field type values from the database enum */
export type FieldType = "short_text" | "long_text" | "select" | "multi_select" | "file_upload";

/**
 * Get tool input fields for an assistant architect
 */
export async function getToolInputFields(assistantArchitectId: number) {
  return executeQuery(
    (db) =>
      db
        .select({
          id: toolInputFields.id,
          name: toolInputFields.name,
          label: toolInputFields.label,
          fieldType: toolInputFields.fieldType,
          position: toolInputFields.position,
          options: toolInputFields.options,
          assistantArchitectId: toolInputFields.assistantArchitectId,
          createdAt: toolInputFields.createdAt,
          updatedAt: toolInputFields.updatedAt,
        })
        .from(toolInputFields)
        .where(eq(toolInputFields.assistantArchitectId, assistantArchitectId))
        .orderBy(asc(toolInputFields.position)),
    "getToolInputFields"
  );
}

/**
 * Create a tool input field
 */
export async function createToolInputField(data: {
  name: string;
  label: string;
  fieldType: FieldType;
  assistantArchitectId: number;
  position?: number;
  options?: { values?: string[]; multiSelect?: boolean; placeholder?: string };
}) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(toolInputFields)
        .values({
          name: data.name,
          label: data.label,
          fieldType: data.fieldType,
          assistantArchitectId: data.assistantArchitectId,
          position: data.position ?? 0,
          options: data.options ?? null,
        })
        .returning(),
    "createToolInputField"
  );
  return result[0];
}

/**
 * Update a tool input field
 */
export async function updateToolInputField(
  id: number,
  updates: {
    name?: string;
    label?: string;
    fieldType?: FieldType;
    position?: number;
    options?: { values?: string[]; multiSelect?: boolean; placeholder?: string };
  }
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(toolInputFields)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(toolInputFields.id, id))
        .returning(),
    "updateToolInputField"
  );
  return result[0];
}

/**
 * Delete a tool input field
 */
export async function deleteToolInputField(id: number) {
  const result = await executeQuery(
    (db) =>
      db.delete(toolInputFields).where(eq(toolInputFields.id, id)).returning(),
    "deleteToolInputField"
  );
  return result[0];
}
