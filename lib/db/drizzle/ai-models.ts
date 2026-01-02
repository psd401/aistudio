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

import { eq, and, sql, or } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  aiModels,
  chainPrompts,
  nexusMessages,
  nexusConversations,
  modelComparisons,
  modelReplacementAudit,
} from "@/lib/db/schema";
import { createLogger, generateRequestId } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";
import type { NexusCapabilities, ProviderMetadata } from "@/lib/db/types/jsonb";
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
  allowedRoles?: string[] | null;
  maxTokens?: number | null;
  active?: boolean;
  chatEnabled?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  inputCostPer1kTokens?: string | null;
  outputCostPer1kTokens?: string | null;
  cachedInputCostPer1kTokens?: string | null;
  pricingUpdatedAt?: Date | null;
  averageLatencyMs?: number | null;
  maxConcurrency?: number | null;
  supportsBatching?: boolean | null;
  nexusCapabilities?: NexusCapabilities | null;
  providerMetadata?: ProviderMetadata | null;
}

export interface AIModelUpdateData {
  name?: string;
  modelId?: string;
  provider?: string;
  description?: string | null;
  capabilities?: string | null;
  allowedRoles?: string[] | null;
  maxTokens?: number | null;
  active?: boolean;
  chatEnabled?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  inputCostPer1kTokens?: string | null;
  outputCostPer1kTokens?: string | null;
  cachedInputCostPer1kTokens?: string | null;
  pricingUpdatedAt?: Date | null;
  averageLatencyMs?: number | null;
  maxConcurrency?: number | null;
  supportsBatching?: boolean | null;
  nexusCapabilities?: NexusCapabilities | null;
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
          allowedRoles: aiModels.allowedRoles,
          maxTokens: aiModels.maxTokens,
          active: aiModels.active,
          chatEnabled: aiModels.chatEnabled,
          nexusEnabled: aiModels.nexusEnabled,
          architectEnabled: aiModels.architectEnabled,
          createdAt: aiModels.createdAt,
          updatedAt: aiModels.updatedAt,
          inputCostPer1kTokens: aiModels.inputCostPer1kTokens,
          outputCostPer1kTokens: aiModels.outputCostPer1kTokens,
          cachedInputCostPer1kTokens: aiModels.cachedInputCostPer1kTokens,
          pricingUpdatedAt: aiModels.pricingUpdatedAt,
          averageLatencyMs: aiModels.averageLatencyMs,
          maxConcurrency: aiModels.maxConcurrency,
          supportsBatching: aiModels.supportsBatching,
          nexusCapabilities: aiModels.nexusCapabilities,
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
 * Get active chat-enabled models
 * @deprecated Since January 2025 (PR #592, Issue #585). Use getNexusEnabledModels() instead.
 * This function is maintained for backward compatibility and will be removed in v2.0.
 */
export async function getChatEnabledModels() {
  return getNexusEnabledModels();
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
 * Get models with specific Nexus capabilities
 * Queries JSONB nexus_capabilities field for capability flags at the database level
 */
export async function getModelsWithCapabilities(
  capabilities: Partial<NexusCapabilities>
) {
  // Whitelist of valid NexusCapabilities keys to prevent SQL injection
  const validKeys: Set<keyof NexusCapabilities> = new Set([
    "canvas",
    "thinking",
    "artifacts",
    "grounding",
    "reasoning",
    "webSearch",
    "computerUse",
    "responsesAPI",
    "codeExecution",
    "promptCaching",
    "contextCaching",
    "workspaceTools",
    "codeInterpreter",
  ]);

  // Build JSONB conditions for database-level filtering with validated keys
  const conditions = Object.entries(capabilities)
    .filter(([key, value]) => {
      // Only include valid keys that are set to true
      return value === true && validKeys.has(key as keyof NexusCapabilities);
    })
    .map(([key]) => {
      // Runtime assertion: Key must be alphanumeric for SQL safety
      // This defends against whitelist compromise or extension errors
      if (!/^[A-Za-z]+$/.test(key)) {
        throw new Error(`Invalid capability key format: ${key}`);
      }

      // Use COALESCE to handle null/missing fields as false
      return sql`COALESCE((${aiModels.nexusCapabilities} ->> ${key})::boolean, false) = true`;
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
          allowedRoles: modelData.allowedRoles,
          maxTokens: modelData.maxTokens,
          active: modelData.active ?? true,
          chatEnabled: modelData.chatEnabled ?? false,
          nexusEnabled: modelData.nexusEnabled ?? true,
          architectEnabled: modelData.architectEnabled ?? true,
          inputCostPer1kTokens: modelData.inputCostPer1kTokens,
          outputCostPer1kTokens: modelData.outputCostPer1kTokens,
          cachedInputCostPer1kTokens: modelData.cachedInputCostPer1kTokens,
          pricingUpdatedAt: modelData.pricingUpdatedAt,
          averageLatencyMs: modelData.averageLatencyMs,
          maxConcurrency: modelData.maxConcurrency,
          supportsBatching: modelData.supportsBatching,
          nexusCapabilities: modelData.nexusCapabilities,
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
 * Delete an AI model
 */
export async function deleteAIModel(id: number) {
  const result = await executeQuery(
    (db) => db.delete(aiModels).where(eq(aiModels.id, id)).returning(),
    "deleteAIModel"
  );
  return result[0];
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
  ]);

  // Check for failures and provide detailed error context
  const labels = ["chainPrompts", "nexusMessages", "nexusConversations", "modelComparisons"];
  const failedQueries = results
    .map((result, index) => (result.status === "rejected" ? labels[index] : null))
    .filter(Boolean);

  if (failedQueries.length > 0) {
    log.error("Count queries failed", { failedQueries, modelId });
    throw new Error(`Failed to count references in: ${failedQueries.join(", ")}`);
  }

  // Extract successful results
  const [chainPromptsResult, nexusMessagesResult, nexusConversationsResult, modelComparisonsResult] =
    results.map((r) => (r.status === "fulfilled" ? r.value : []));

  return {
    chainPromptsCount: chainPromptsResult[0]?.count ?? 0,
    nexusMessagesCount: nexusMessagesResult[0]?.count ?? 0,
    nexusConversationsCount: nexusConversationsResult[0]?.count ?? 0,
    modelComparisonsCount: modelComparisonsResult[0]?.count ?? 0,
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
      async (tx) => {
        // Validate replacement within transaction
        if (targetModelId === replacementModelId) {
          throw new Error("A model cannot replace itself");
        }

        // Get both models within transaction
        // NOTE: Sequential execution required for RDS Data API parameter binding.
        // Concurrent queries with WHERE clauses cause malformed bindings like ":1params: 22".
        // Even without .limit(), Promise.all() with parameterized queries confuses the driver's
        // offset tracker. See Issue #583 and docs/database/drizzle-patterns.md.
        const targetModelResult = await tx.select().from(aiModels).where(eq(aiModels.id, targetModelId));
        const replacementModelResult = await tx.select().from(aiModels).where(eq(aiModels.id, replacementModelId));

        const targetModel = targetModelResult[0];
        const replacementModel = replacementModelResult[0];

        if (!targetModel) {
          throw ErrorFactories.dbRecordNotFound("ai_models", targetModelId);
        }
        if (!replacementModel) {
          throw ErrorFactories.dbRecordNotFound("ai_models", replacementModelId);
        }
        if (!replacementModel.active) {
          throw new Error("Replacement model is not active");
        }

        // Get reference counts within transaction
        // NOTE: Sequential execution required for RDS Data API parameter binding.
        // Concurrent queries cause offset tracking issues, especially with multi-parameter
        // queries like or(eq(...), eq(...)) which creates :1 and :2 bindings.
        // Uses countAsInt helper (CAST syntax) instead of ::int - see Issue #583.
        const chainPromptsResult = await tx.select({ count: countAsInt }).from(chainPrompts).where(eq(chainPrompts.modelId, targetModelId));
        const nexusMessagesResult = await tx.select({ count: countAsInt }).from(nexusMessages).where(eq(nexusMessages.modelId, targetModelId));
        const nexusConversationsResult = await tx.select({ count: countAsInt }).from(nexusConversations).where(sql`${nexusConversations.modelUsed} = ${targetModel.modelId}`);
        const modelComparisonsResult = await tx.select({ count: countAsInt }).from(modelComparisons).where(or(eq(modelComparisons.model1Id, targetModelId), eq(modelComparisons.model2Id, targetModelId)));

        const counts = {
          chainPromptsCount: chainPromptsResult[0]?.count ?? 0,
          nexusMessagesCount: nexusMessagesResult[0]?.count ?? 0,
          nexusConversationsCount: nexusConversationsResult[0]?.count ?? 0,
          modelComparisonsCount: modelComparisonsResult[0]?.count ?? 0,
        };
        // Update chain_prompts
        if (counts.chainPromptsCount > 0) {
          await tx
            .update(chainPrompts)
            .set({ modelId: replacementModelId, updatedAt: new Date() })
            .where(eq(chainPrompts.modelId, targetModelId));
        }

        // Update nexus_messages
        if (counts.nexusMessagesCount > 0) {
          await tx
            .update(nexusMessages)
            .set({ modelId: replacementModelId, updatedAt: new Date() })
            .where(eq(nexusMessages.modelId, targetModelId));
        }

        // Update nexus_conversations (uses model_id string, not FK)
        if (counts.nexusConversationsCount > 0) {
          await tx
            .update(nexusConversations)
            .set({
              modelUsed: replacementModel.modelId,
              updatedAt: new Date(),
            })
            .where(eq(nexusConversations.modelUsed, targetModel.modelId));
        }

        // Update model_comparisons (both columns)
        if (counts.modelComparisonsCount > 0) {
          await tx
            .update(modelComparisons)
            .set({ model1Id: replacementModelId, updatedAt: new Date() })
            .where(eq(modelComparisons.model1Id, targetModelId));

          await tx
            .update(modelComparisons)
            .set({ model2Id: replacementModelId, updatedAt: new Date() })
            .where(eq(modelComparisons.model2Id, targetModelId));
        }

        // Record in audit table with generated ID
        // FIXME: COLLISION RISK - Epoch-based ID generation is dangerous
        //
        // Current approach: EXTRACT(EPOCH FROM NOW()) * 1000000 (microsecond precision)
        //
        // PROBLEMS:
        // 1. Rapid succession replacements can collide (microseconds don't guarantee uniqueness)
        // 2. Database clock skew across replicas
        // 3. Not safe in distributed/high-throughput scenarios
        //
        // RECOMMENDED FIX: Database migration to add BIGSERIAL or use UUID
        //
        // Short-term: This is acceptable because model replacements are rare manual operations
        // (typically < 1 per hour) and not called concurrently.
        //
        // TODO: Create migration to change model_replacement_audit.id to BIGSERIAL
        // See: https://github.com/psd401/aistudio/issues/TBD
        await tx.insert(modelReplacementAudit).values({
          id: sql`(EXTRACT(EPOCH FROM NOW()) * 1000000)::bigint`,
          originalModelId: targetModelId,
          originalModelName: targetModel.name,
          replacementModelId: replacementModelId,
          replacementModelName: replacementModel.name,
          replacedBy: userId,
          chainPromptsUpdated: counts.chainPromptsCount,
          nexusMessagesUpdated: counts.nexusMessagesCount,
          nexusConversationsUpdated: counts.nexusConversationsCount,
          modelComparisonsUpdated: counts.modelComparisonsCount,
        });

        // Delete the original model
        await tx.delete(aiModels).where(eq(aiModels.id, targetModelId));

        return {
          success: true,
          targetModel: { id: targetModelId, name: targetModel.name },
          replacementModel: {
            id: replacementModelId,
            name: replacementModel.name,
          },
          recordsUpdated: {
            chainPrompts: counts.chainPromptsCount,
            nexusMessages: counts.nexusMessagesCount,
            nexusConversations: counts.nexusConversationsCount,
            modelComparisons: counts.modelComparisonsCount,
          },
          totalUpdated:
            counts.chainPromptsCount +
            counts.nexusMessagesCount +
            counts.nexusConversationsCount +
            counts.modelComparisonsCount,
        };
      },
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
  active?: boolean;
  nexusEnabled?: boolean;
  architectEnabled?: boolean;
  allowedRoles?: string[] | null;
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
      async (tx) => {
        // Get all existing models by modelId for upsert logic
        // NOTE: Sequential execution within transaction for RDS Data API safety
        const existingModels = await tx.select().from(aiModels);
        const existingByModelId = new Map(
          existingModels.map((m) => [m.modelId, m])
        );

        for (let i = 0; i < models.length; i++) {
          const model = models[i];
          const existing = existingByModelId.get(model.modelId);

          // Serialize capabilities to JSON string if provided as array
          const capabilitiesJson = model.capabilities
            ? JSON.stringify(model.capabilities)
            : null;

          if (existing) {
            // Update existing model
            await tx
              .update(aiModels)
              .set({
                name: model.name,
                provider: model.provider,
                description: model.description ?? existing.description,
                capabilities: capabilitiesJson ?? existing.capabilities,
                maxTokens: model.maxTokens ?? existing.maxTokens,
                active: model.active ?? existing.active,
                nexusEnabled: model.nexusEnabled ?? existing.nexusEnabled,
                architectEnabled: model.architectEnabled ?? existing.architectEnabled,
                allowedRoles: model.allowedRoles ?? existing.allowedRoles,
                inputCostPer1kTokens:
                  model.inputCostPer1kTokens ?? existing.inputCostPer1kTokens,
                outputCostPer1kTokens:
                  model.outputCostPer1kTokens ?? existing.outputCostPer1kTokens,
                cachedInputCostPer1kTokens:
                  model.cachedInputCostPer1kTokens ?? existing.cachedInputCostPer1kTokens,
                updatedAt: new Date(),
              })
              .where(eq(aiModels.id, existing.id));
            result.updated++;
          } else {
            // Create new model
            await tx.insert(aiModels).values({
              name: model.name,
              modelId: model.modelId,
              provider: model.provider,
              description: model.description,
              capabilities: capabilitiesJson,
              maxTokens: model.maxTokens,
              active: model.active ?? true,
              nexusEnabled: model.nexusEnabled ?? true,
              architectEnabled: model.architectEnabled ?? true,
              allowedRoles: model.allowedRoles,
              inputCostPer1kTokens: model.inputCostPer1kTokens,
              outputCostPer1kTokens: model.outputCostPer1kTokens,
              cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens,
            });
            result.created++;
          }
        }
      },
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
