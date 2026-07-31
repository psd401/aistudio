/**
 * Drizzle AI Models Operations
 *
 * AI model CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * server action layer before calling these functions.
 *
 * **Expected Authorization Pattern** (implement in server actions):
 * ```typescript
 * // In /actions/ai-model.actions.ts
 * export async function deleteAIModelAction(id: number): Promise<ActionState<void>> {
 *   const session = await getServerSession();
 *   if (!session) {
 *     throw ErrorFactories.authNoSession();
 *   }
 *
 *   // Check admin role
 *   const isAdmin = await checkUserRole(session.user.id, "admin");
 *   if (!isAdmin) {
 *     throw ErrorFactories.authInsufficientPermissions();
 *   }
 *
 *   // Now safe to call infrastructure layer
 *   await deleteAIModel(id);
 *   return createSuccess(undefined, "Model deleted");
 * }
 * ```
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #532 - Migrate AI Models & Configuration queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, sql, or, inArray } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  aiModels,
  chainPrompts,
  nexusMessages,
  nexusConversations,
  modelComparisons,
  modelReplacementAudit,
  promptLibrary,
  resourceAccessGrants,
} from "@/lib/db/schema";
import { createLogger, generateRequestId } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";
import type { ProviderMetadata } from "@/lib/db/types/jsonb";
import type { CapabilityKey, DatabaseCapability } from "@/lib/ai/capability-utils";
import { toDatabaseCapability } from "@/lib/ai/capability-utils";
import { countAsInt } from "@/lib/db/drizzle/helpers/pagination";

// ============================================
// Types
// ============================================

export interface AIModelData {
  name: string;
  modelId: string;
  provider: string;
  description?: string | null;
  capabilities?: string | null;
  maxTokens?: number | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  agenticReady?: boolean;
  active?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  inputCostPer1kTokens?: string | null;
  outputCostPer1kTokens?: string | null;
  cachedInputCostPer1kTokens?: string | null;
  // Cache-WRITE rate (migration 092, issue #1089). Pairs with the cache-read
  // rate above so an admin can price a caching-capable model end-to-end.
  cacheWriteCostPer1kTokens?: string | null;
  pricingUpdatedAt?: Date | null;
  averageLatencyMs?: number | null;
  maxConcurrency?: number | null;
  supportsBatching?: boolean | null;
  providerMetadata?: ProviderMetadata | null;
}

export interface AIModelUpdateData {
  name?: string;
  modelId?: string;
  provider?: string;
  description?: string | null;
  capabilities?: string | null;
  maxTokens?: number | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  agenticReady?: boolean;
  active?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  inputCostPer1kTokens?: string | null;
  outputCostPer1kTokens?: string | null;
  cachedInputCostPer1kTokens?: string | null;
  // Cache-WRITE rate (migration 092, issue #1089).
  cacheWriteCostPer1kTokens?: string | null;
  pricingUpdatedAt?: Date | null;
  averageLatencyMs?: number | null;
  maxConcurrency?: number | null;
  supportsBatching?: boolean | null;
  providerMetadata?: ProviderMetadata | null;
}

// ============================================
// AI Model Query Operations
// ============================================

/**
 * Get all AI models ordered by name
 */
export async function getAIModels() {
  return executeQuery(
    (db) =>
      db
        .select({
          id: aiModels.id,
          name: aiModels.name,
          provider: aiModels.provider,
          modelId: aiModels.modelId,
          description: aiModels.description,
          capabilities: aiModels.capabilities,
          maxTokens: aiModels.maxTokens,
          contextWindowTokens: aiModels.contextWindowTokens,
          maxOutputTokens: aiModels.maxOutputTokens,
          agenticReady: aiModels.agenticReady,
          active: aiModels.active,
          nexusEnabled: aiModels.nexusEnabled,
          architectEnabled: aiModels.architectEnabled,
          createdAt: aiModels.createdAt,
          updatedAt: aiModels.updatedAt,
          inputCostPer1kTokens: aiModels.inputCostPer1kTokens,
          outputCostPer1kTokens: aiModels.outputCostPer1kTokens,
          cachedInputCostPer1kTokens: aiModels.cachedInputCostPer1kTokens,
          cacheWriteCostPer1kTokens: aiModels.cacheWriteCostPer1kTokens,
          pricingUpdatedAt: aiModels.pricingUpdatedAt,
          averageLatencyMs: aiModels.averageLatencyMs,
          maxConcurrency: aiModels.maxConcurrency,
          supportsBatching: aiModels.supportsBatching,
          providerMetadata: aiModels.providerMetadata,
        })
        .from(aiModels)
        .orderBy(aiModels.name),
    "getAIModels"
  );
}

/**
 * Get AI model by database ID
 */
export async function getAIModelById(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(eq(aiModels.id, id))
        .limit(1),
    "getAIModelById"
  );

  return result[0] || null;
}

/**
 * Get AI model by model ID string (e.g., "gpt-4-turbo")
 */
export async function getAIModelByModelId(modelId: string) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(eq(aiModels.modelId, modelId))
        .limit(1),
    "getAIModelByModelId"
  );

  return result[0] || null;
}

/**
 * Get active AI models for chat
 */
export async function getActiveAIModels() {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(eq(aiModels.active, true))
        .orderBy(aiModels.provider, aiModels.name),
    "getActiveAIModels"
  );
}

/**
 * Get models enabled for Nexus chat and Model Compare
 * These models appear in Nexus chat model selector and Model Compare feature
 */
export async function getNexusEnabledModels() {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(and(eq(aiModels.active, true), eq(aiModels.nexusEnabled, true)))
        .orderBy(aiModels.provider, aiModels.name),
    "getNexusEnabledModels"
  );
}

/**
 * Get models enabled for Assistant Architect
 * These models appear in Assistant Architect prompt configuration
 */
export async function getArchitectEnabledModels() {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(and(eq(aiModels.active, true), eq(aiModels.architectEnabled, true)))
        .orderBy(aiModels.provider, aiModels.name),
    "getArchitectEnabledModels"
  );
}

/** Models that are explicitly safe for an agentic cost-bounded tool loop. */
export async function getAgenticReadyArchitectModels() {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(
          and(
            eq(aiModels.active, true),
            eq(aiModels.architectEnabled, true),
            eq(aiModels.agenticReady, true)
          )
        )
        .orderBy(aiModels.provider, aiModels.name),
    "getAgenticReadyArchitectModels"
  );
}

/**
 * Get AI models by provider
 */
export async function getAIModelsByProvider(provider: string) {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(eq(aiModels.provider, provider))
        .orderBy(aiModels.name),
    "getAIModelsByProvider"
  );
}

/**
 * Get models with specific capabilities
 *
 * Queries the `capabilities` TEXT field (JSON array) for capability values.
 * Part of Issue #594 - Consolidate to single capabilities field.
 *
 * @param requiredCapabilities - Array of required capability keys (camelCase)
 * @returns Models that have ALL the specified capabilities
 *
 * @example
 * ```typescript
 * // Find models with web search and code interpreter
 * const models = await getModelsWithCapabilities(['webSearch', 'codeInterpreter']);
 * ```
 */
export async function getModelsWithCapabilities(
  requiredCapabilities: CapabilityKey[]
) {
  // Convert runtime capability keys to database format (snake_case)
  const dbCapabilities = requiredCapabilities
    .map((cap) => toDatabaseCapability(cap))
    .filter((cap): cap is DatabaseCapability => cap !== undefined);

  if (dbCapabilities.length === 0) {
    // If no valid capabilities requested, return all active Nexus-enabled models
    return executeQuery(
      (db) =>
        db
          .select()
          .from(aiModels)
          .where(and(eq(aiModels.active, true), eq(aiModels.nexusEnabled, true)))
          .orderBy(aiModels.provider, aiModels.name),
      "getModelsWithCapabilities"
    );
  }

  // Build conditions to check each capability exists in the JSON array
  // The capabilities field stores a JSON array like '["web_search", "canvas"]'
  const conditions = dbCapabilities.map((cap) => {
    // Use JSON containment operator to check if array contains the capability
    // capabilities::jsonb @> '["web_search"]' checks if array contains "web_search"
    return sql`${aiModels.capabilities}::jsonb @> ${JSON.stringify([cap])}::jsonb`;
  });

  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(
          and(
            eq(aiModels.active, true),
            eq(aiModels.nexusEnabled, true),
            ...conditions
          )
        )
        .orderBy(aiModels.provider, aiModels.name),
    "getModelsWithCapabilities"
  );
}

// ============================================
// AI Model CRUD Operations
// ============================================

/**
 * Create a new AI model
 */
export async function createAIModel(modelData: AIModelData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(aiModels)
        .values({
          name: modelData.name,
          modelId: modelData.modelId,
          provider: modelData.provider,
          description: modelData.description,
          capabilities: modelData.capabilities,
          maxTokens: modelData.maxTokens,
          contextWindowTokens: modelData.contextWindowTokens,
          maxOutputTokens: modelData.maxOutputTokens,
          agenticReady: modelData.agenticReady ?? false,
          active: modelData.active ?? true,
          nexusEnabled: modelData.nexusEnabled ?? true,
          architectEnabled: modelData.architectEnabled ?? true,
          inputCostPer1kTokens: modelData.inputCostPer1kTokens,
          outputCostPer1kTokens: modelData.outputCostPer1kTokens,
          cachedInputCostPer1kTokens: modelData.cachedInputCostPer1kTokens,
          cacheWriteCostPer1kTokens: modelData.cacheWriteCostPer1kTokens,
          pricingUpdatedAt: modelData.pricingUpdatedAt,
          averageLatencyMs: modelData.averageLatencyMs,
          maxConcurrency: modelData.maxConcurrency,
          supportsBatching: modelData.supportsBatching,
          providerMetadata: modelData.providerMetadata ?? {},
        })
        .returning(),
    "createAIModel"
  );
  return result[0];
}

/**
 * Update an AI model
 */
export async function updateAIModel(id: number, updates: AIModelUpdateData) {
  const result = await executeQuery(
    (db) =>
      db
        .update(aiModels)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(aiModels.id, id))
        .returning(),
    "updateAIModel"
  );
  return result[0];
}

/**
 * Delete an AI model. Also removes any per-resource access grants on the model
 * (#1206) in the SAME transaction, so a recycled serial id can never inherit a
 * departed model's grants.
 */
export async function deleteAIModel(id: number) {
  return executeTransaction(
    async (tx) => {
      await tx
        .delete(resourceAccessGrants)
        .where(
          and(
            eq(resourceAccessGrants.resourceType, "model"),
            eq(resourceAccessGrants.resourceId, String(id))
          )
        );
      const result = await tx.delete(aiModels).where(eq(aiModels.id, id)).returning();
      return result[0];
    },
    "deleteAIModel"
  );
}

/**
 * Set AI model active status
 */
export async function setAIModelActive(id: number, active: boolean) {
  return updateAIModel(id, { active });
}

// ============================================
// Model Reference Count Operations
// ============================================

/**
 * Get counts of references to a model across related tables
 * Used for validation before model deletion/replacement
 */
export async function getModelReferenceCounts(modelId: number) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, function: "getModelReferenceCounts" });

  log.info("Getting model reference counts", { modelId });

  // Execute all count queries in parallel with individual error handling
  // Use Promise.allSettled to get detailed error context if any query fails
  const results = await Promise.allSettled([
    executeQuery(
      (db) =>
        db
          .select({ count: countAsInt })
          .from(chainPrompts)
          .where(eq(chainPrompts.modelId, modelId)),
      "countChainPrompts"
    ),
    executeQuery(
      (db) =>
        db
          .select({ count: countAsInt })
          .from(nexusMessages)
          .where(eq(nexusMessages.modelId, modelId)),
      "countNexusMessages"
    ),
    executeQuery(
      (db) =>
        db
          .select({ count: countAsInt })
          .from(nexusConversations)
          .where(
            sql`${nexusConversations.modelUsed} = (SELECT model_id FROM ai_models WHERE id = ${modelId})`
          ),
      "countNexusConversations"
    ),
    executeQuery(
      (db) =>
        db
          .select({ count: countAsInt })
          .from(modelComparisons)
          .where(
            or(
              eq(modelComparisons.model1Id, modelId),
              eq(modelComparisons.model2Id, modelId)
            )
          ),
      "countModelComparisons"
    ),
    executeQuery(
      (db) =>
        db
          .select({ count: countAsInt })
          .from(promptLibrary)
          .where(
            and(
              sql`${promptLibrary.settings}->>'modelId' = (SELECT model_id FROM ai_models WHERE id = ${modelId})`,
              sql`${promptLibrary.deletedAt} IS NULL`
            )
          ),
      "countPromptLibrarySettings"
    ),
  ]);

  // Check for failures and provide detailed error context
  const labels = ["chainPrompts", "nexusMessages", "nexusConversations", "modelComparisons", "promptLibrary"];
  const failedQueries = results
    .map((result, index) => (result.status === "rejected" ? labels[index] : null))
    .filter(Boolean);

  if (failedQueries.length > 0) {
    log.error("Count queries failed", { failedQueries, modelId });
    throw new Error(`Failed to count references in: ${failedQueries.join(", ")}`);
  }

  // Extract successful results
  const [chainPromptsResult, nexusMessagesResult, nexusConversationsResult, modelComparisonsResult, promptLibraryResult] =
    results.map((r) => (r.status === "fulfilled" ? r.value : []));

  return {
    chainPromptsCount: chainPromptsResult[0]?.count ?? 0,
    nexusMessagesCount: nexusMessagesResult[0]?.count ?? 0,
    nexusConversationsCount: nexusConversationsResult[0]?.count ?? 0,
    modelComparisonsCount: modelComparisonsResult[0]?.count ?? 0,
    promptLibraryCount: promptLibraryResult[0]?.count ?? 0,
  };
}

/**
 * Validate if a model can be used as a replacement for another
 *
 * **WARNING**: This function is for pre-validation checks only (e.g., UI validation).
 * DO NOT rely on this for transactional safety - validation is re-performed inside
 * the replaceModelReferences() transaction to prevent race conditions.
 *
 * Between calling this function and executing the replacement, models could be
 * modified or deleted by other processes.
 */
export async function validateModelReplacement(
  targetModelId: number,
  replacementModelId: number
) {
  // Prevent self-replacement
  if (targetModelId === replacementModelId) {
    return {
      valid: false,
      reason: "A model cannot replace itself",
    };
  }

  // Check both models exist and replacement is active
  const [targetModel, replacementModel] = await Promise.all([
    getAIModelById(targetModelId),
    getAIModelById(replacementModelId),
  ]);

  if (!targetModel) {
    return {
      valid: false,
      reason: `Target model with ID ${targetModelId} not found`,
    };
  }

  if (!replacementModel) {
    return {
      valid: false,
      reason: `Replacement model with ID ${replacementModelId} not found`,
    };
  }

  if (!replacementModel.active) {
    return {
      valid: false,
      reason: "Replacement model is not active",
    };
  }

  return {
    valid: true,
    targetModel,
    replacementModel,
  };
}

/**
 * Replace model references across all related tables and delete original
 * Uses a transaction to ensure atomicity
 */
export async function replaceModelReferences(
  targetModelId: number,
  replacementModelId: number,
  userId: number
) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, operation: "replaceModelReferences" });

  log.info("Starting model replacement", {
    targetModelId,
    replacementModelId,
    userId,
  });

  try {
    // Execute all validation and updates in a single transaction to prevent race conditions
    const result = await executeTransaction(
      (tx) => performModelReplacement(
        tx,
        targetModelId,
        replacementModelId,
        userId
      ),
      "replaceModelReferencesTransaction"
    );

    log.info("Model replacement completed successfully", result);

    return result;
  } catch (error) {
    log.error("Model replacement failed", {
      error: error instanceof Error ? error.message : String(error),
      targetModelId,
      replacementModelId,
    });
    throw error;
  }
}

type AIModelRow = typeof aiModels.$inferSelect;

interface ModelReferenceCounts {
  chainPromptsCount: number;
  nexusMessagesCount: number;
  nexusConversationsCount: number;
  modelComparisonsCount: number;
  promptLibraryCount: number;
}

interface ModelReplacementContext {
  targetModelId: number;
  replacementModelId: number;
  userId: number;
  targetModel: AIModelRow;
  replacementModel: AIModelRow;
  counts: ModelReferenceCounts;
}

async function performModelReplacement(
  tx: DbTransaction,
  targetModelId: number,
  replacementModelId: number,
  userId: number
) {
  if (targetModelId === replacementModelId) {
    throw new Error("A model cannot replace itself");
  }
  const { targetModel, replacementModel } = await loadReplacementModels(
    tx,
    targetModelId,
    replacementModelId
  );
  const counts = await loadModelReferenceCounts(tx, targetModelId, targetModel.modelId);
  const context: ModelReplacementContext = {
    targetModelId,
    replacementModelId,
    userId,
    targetModel,
    replacementModel,
    counts,
  };
  await updateModelReferences(tx, context);
  await recordModelReplacement(tx, context);
  await tx.delete(aiModels).where(eq(aiModels.id, targetModelId));
  return modelReplacementResult(
    targetModelId,
    replacementModelId,
    targetModel,
    replacementModel,
    counts
  );
}

async function loadReplacementModels(
  tx: DbTransaction,
  targetModelId: number,
  replacementModelId: number
): Promise<{ targetModel: AIModelRow; replacementModel: AIModelRow }> {
  const targetRows = await tx.select().from(aiModels).where(eq(aiModels.id, targetModelId));
  const replacementRows = await tx
    .select()
    .from(aiModels)
    .where(eq(aiModels.id, replacementModelId));
  const targetModel = targetRows[0];
  const replacementModel = replacementRows[0];
  if (!targetModel) {
    throw ErrorFactories.dbRecordNotFound("ai_models", targetModelId);
  }
  if (!replacementModel) {
    throw ErrorFactories.dbRecordNotFound("ai_models", replacementModelId);
  }
  if (!replacementModel.active) throw new Error("Replacement model is not active");
  return { targetModel, replacementModel };
}

async function loadModelReferenceCounts(
  tx: DbTransaction,
  targetModelId: number,
  targetModelKey: string
): Promise<ModelReferenceCounts> {
  const chain = await tx.select({ count: countAsInt }).from(chainPrompts)
    .where(eq(chainPrompts.modelId, targetModelId));
  const messages = await tx.select({ count: countAsInt }).from(nexusMessages)
    .where(eq(nexusMessages.modelId, targetModelId));
  const conversations = await tx.select({ count: countAsInt }).from(nexusConversations)
    .where(sql`${nexusConversations.modelUsed} = ${targetModelKey}`);
  const comparisons = await tx.select({ count: countAsInt }).from(modelComparisons)
    .where(or(
      eq(modelComparisons.model1Id, targetModelId),
      eq(modelComparisons.model2Id, targetModelId)
    ));
  const library = await tx.select({ count: countAsInt }).from(promptLibrary)
    .where(and(
      sql`${promptLibrary.settings}->>'modelId' = ${targetModelKey}`,
      sql`${promptLibrary.deletedAt} IS NULL`
    ));
  return {
    chainPromptsCount: chain[0]?.count ?? 0,
    nexusMessagesCount: messages[0]?.count ?? 0,
    nexusConversationsCount: conversations[0]?.count ?? 0,
    modelComparisonsCount: comparisons[0]?.count ?? 0,
    promptLibraryCount: library[0]?.count ?? 0,
  };
}

async function updateModelReferences(
  tx: DbTransaction,
  context: ModelReplacementContext
): Promise<void> {
  const {
    targetModelId,
    replacementModelId,
    targetModel,
    replacementModel,
    counts,
  } = context;
  if (counts.chainPromptsCount > 0) {
    await tx.update(chainPrompts)
      .set({ modelId: replacementModelId, updatedAt: new Date() })
      .where(eq(chainPrompts.modelId, targetModelId));
  }
  if (counts.nexusMessagesCount > 0) {
    await tx.update(nexusMessages)
      .set({ modelId: replacementModelId, updatedAt: new Date() })
      .where(eq(nexusMessages.modelId, targetModelId));
  }
  if (counts.nexusConversationsCount > 0) {
    await tx.update(nexusConversations)
      .set({ modelUsed: replacementModel.modelId, updatedAt: new Date() })
      .where(eq(nexusConversations.modelUsed, targetModel.modelId));
  }
  if (counts.modelComparisonsCount > 0) {
    await updateModelComparisonReferences(tx, targetModelId, replacementModelId);
  }
  if (counts.promptLibraryCount > 0) {
    await tx.execute(sql`
      UPDATE prompt_library
      SET settings = jsonb_set(settings, '{modelId}', to_jsonb(${replacementModel.modelId}::text)),
          updated_at = NOW()
      WHERE settings->>'modelId' = ${targetModel.modelId}
      AND deleted_at IS NULL
    `);
  }
}

async function updateModelComparisonReferences(
  tx: DbTransaction,
  targetModelId: number,
  replacementModelId: number
): Promise<void> {
  await tx.update(modelComparisons)
    .set({ model1Id: replacementModelId, updatedAt: new Date() })
    .where(eq(modelComparisons.model1Id, targetModelId));
  await tx.update(modelComparisons)
    .set({ model2Id: replacementModelId, updatedAt: new Date() })
    .where(eq(modelComparisons.model2Id, targetModelId));
}

async function recordModelReplacement(
  tx: DbTransaction,
  context: ModelReplacementContext
): Promise<void> {
  const {
    targetModelId,
    replacementModelId,
    userId,
    targetModel,
    replacementModel,
    counts,
  } = context;
  await tx.insert(modelReplacementAudit).values({
    id: sql`(EXTRACT(EPOCH FROM NOW()) * 1000000)::bigint`,
    originalModelId: targetModelId,
    originalModelName: targetModel.name,
    replacementModelId,
    replacementModelName: replacementModel.name,
    replacedBy: userId,
    chainPromptsUpdated: counts.chainPromptsCount,
    nexusMessagesUpdated: counts.nexusMessagesCount,
    nexusConversationsUpdated: counts.nexusConversationsCount,
    modelComparisonsUpdated: counts.modelComparisonsCount,
    promptLibraryUpdated: counts.promptLibraryCount,
  });
}

function modelReplacementResult(
  targetModelId: number,
  replacementModelId: number,
  targetModel: AIModelRow,
  replacementModel: AIModelRow,
  counts: ModelReferenceCounts
) {
  const recordsUpdated = {
    chainPrompts: counts.chainPromptsCount,
    nexusMessages: counts.nexusMessagesCount,
    nexusConversations: counts.nexusConversationsCount,
    modelComparisons: counts.modelComparisonsCount,
    promptLibrary: counts.promptLibraryCount,
  };
  return {
    success: true,
    targetModel: { id: targetModelId, name: targetModel.name },
    replacementModel: { id: replacementModelId, name: replacementModel.name },
    recordsUpdated,
    totalUpdated: Object.values(recordsUpdated).reduce((sum, count) => sum + count, 0),
  };
}

// ============================================
// Bulk Import Operations
// ============================================

/**
 * Data structure for bulk model import
 */
export interface BulkModelImportData {
  name: string;
  modelId: string;
  provider: string;
  description?: string | null;
  capabilities?: string[] | null;
  maxTokens?: number | null;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  agenticReady?: boolean;
  active?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  inputCostPer1kTokens?: string | null;
  outputCostPer1kTokens?: string | null;
  cachedInputCostPer1kTokens?: string | null;
}

/**
 * Result of bulk model import operation
 */
export interface BulkImportResult {
  created: number;
  updated: number;
  errors: string[];
}

/**
 * Import multiple AI models with upsert logic (create or update based on modelId)
 * Uses a transaction to ensure atomicity - all models succeed or all fail
 */
export async function bulkImportAIModels(
  models: BulkModelImportData[]
): Promise<BulkImportResult> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, operation: "bulkImportAIModels" });

  log.info("Starting bulk model import", { count: models.length });

  const result: BulkImportResult = {
    created: 0,
    updated: 0,
    errors: [],
  };

  try {
    await executeTransaction(
      (tx) => importAIModels(tx, models, result),
      "bulkImportAIModelsTransaction"
    );

    log.info("Bulk import completed successfully", {
      created: result.created,
      updated: result.updated,
    });

    return result;
  } catch (error) {
    log.error("Bulk import failed", {
      error: error instanceof Error ? error.message : String(error),
      modelsCount: models.length,
    });
    throw error;
  }
}

async function importAIModels(
  tx: DbTransaction,
  models: BulkModelImportData[],
  result: BulkImportResult
): Promise<void> {
  const existingByModelId = await loadExistingImportModels(tx, models);
  for (const model of models) {
    const existing = existingByModelId.get(model.modelId);
    if (existing) {
      await updateImportedModel(tx, model, existing);
      result.updated++;
    } else {
      await createImportedModel(tx, model);
      result.created++;
    }
  }
}

async function loadExistingImportModels(
  tx: DbTransaction,
  models: BulkModelImportData[]
): Promise<Map<string, AIModelRow>> {
  const modelIds = models.map(model => model.modelId);
  if (modelIds.length === 0) return new Map();
  const existing = await tx
    .select()
    .from(aiModels)
    .where(inArray(aiModels.modelId, modelIds));
  return new Map(existing.map(model => [model.modelId, model]));
}

function importedValue<K extends keyof BulkModelImportData>(
  model: BulkModelImportData,
  key: K,
  fallback: AIModelRow[K]
): BulkModelImportData[K] | AIModelRow[K] {
  return key in model ? model[key] : fallback;
}

async function updateImportedModel(
  tx: DbTransaction,
  model: BulkModelImportData,
  existing: AIModelRow
): Promise<void> {
  const capabilities = model.capabilities
    ? JSON.stringify(model.capabilities)
    : null;
  await tx.update(aiModels).set({
    name: model.name,
    provider: model.provider,
    description: importedValue(model, "description", existing.description),
    capabilities:
      "capabilities" in model ? capabilities : existing.capabilities,
    maxTokens: importedValue(model, "maxTokens", existing.maxTokens),
    contextWindowTokens: importedValue(
      model,
      "contextWindowTokens",
      existing.contextWindowTokens
    ),
    maxOutputTokens: importedValue(
      model,
      "maxOutputTokens",
      existing.maxOutputTokens
    ),
    agenticReady: importedValue(
      model,
      "agenticReady",
      existing.agenticReady
    ),
    active: importedValue(model, "active", existing.active),
    nexusEnabled: importedValue(model, "nexusEnabled", existing.nexusEnabled),
    architectEnabled: importedValue(
      model,
      "architectEnabled",
      existing.architectEnabled
    ),
    inputCostPer1kTokens: importedValue(
      model,
      "inputCostPer1kTokens",
      existing.inputCostPer1kTokens
    ),
    outputCostPer1kTokens: importedValue(
      model,
      "outputCostPer1kTokens",
      existing.outputCostPer1kTokens
    ),
    cachedInputCostPer1kTokens: importedValue(
      model,
      "cachedInputCostPer1kTokens",
      existing.cachedInputCostPer1kTokens
    ),
    updatedAt: new Date(),
  }).where(eq(aiModels.id, existing.id));
}

async function createImportedModel(
  tx: DbTransaction,
  model: BulkModelImportData
): Promise<void> {
  await tx.insert(aiModels).values({
    name: model.name,
    modelId: model.modelId,
    provider: model.provider,
    description: model.description,
    capabilities: model.capabilities ? JSON.stringify(model.capabilities) : null,
    maxTokens: model.maxTokens,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    agenticReady: model.agenticReady ?? false,
    active: model.active ?? true,
    nexusEnabled: model.nexusEnabled ?? true,
    architectEnabled: model.architectEnabled ?? true,
    inputCostPer1kTokens: model.inputCostPer1kTokens,
    outputCostPer1kTokens: model.outputCostPer1kTokens,
    cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens,
  });
}
