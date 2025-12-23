/**
 * Drizzle AI Models Operations
 *
 * AI model CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #532 - Migrate AI Models & Configuration queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, sql, or } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
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
 */
export async function getChatEnabledModels() {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(aiModels)
        .where(and(eq(aiModels.active, true), eq(aiModels.chatEnabled, true)))
        .orderBy(aiModels.provider, aiModels.name),
    "getChatEnabledModels"
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
 * Queries JSONB nexus_capabilities field for capability flags
 */
export async function getModelsWithCapabilities(
  capabilities: Partial<NexusCapabilities>
) {
  return executeQuery(
    (db) => {
      // Build base query with common filters
      return db
        .select()
        .from(aiModels)
        .where(and(eq(aiModels.active, true), eq(aiModels.chatEnabled, true)))
        .orderBy(aiModels.provider, aiModels.name);
    },
    "getModelsWithCapabilities"
  ).then((models) => {
    // Filter models by requested capabilities
    return models.filter((model) => {
      if (!model.nexusCapabilities) return false;
      return Object.entries(capabilities).every(([key, value]) => {
        if (value === true) {
          return (model.nexusCapabilities as NexusCapabilities)[key] === true;
        }
        return true;
      });
    });
  });
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

  // Execute all count queries in parallel
  const [chainPromptsResult, nexusMessagesResult, nexusConversationsResult, modelComparisonsResult] =
    await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(chainPrompts)
            .where(eq(chainPrompts.modelId, modelId)),
        "countChainPrompts"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(nexusMessages)
            .where(eq(nexusMessages.modelId, modelId)),
        "countNexusMessages"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(nexusConversations)
            .where(
              sql`${nexusConversations.modelUsed} = (SELECT model_id FROM ai_models WHERE id = ${modelId})`
            ),
        "countNexusConversations"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(*)::int` })
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

  return {
    chainPromptsCount: chainPromptsResult[0]?.count ?? 0,
    nexusMessagesCount: nexusMessagesResult[0]?.count ?? 0,
    nexusConversationsCount: nexusConversationsResult[0]?.count ?? 0,
    modelComparisonsCount: modelComparisonsResult[0]?.count ?? 0,
  };
}

/**
 * Validate if a model can be used as a replacement for another
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
    // First validate the replacement
    const validation = await validateModelReplacement(
      targetModelId,
      replacementModelId
    );

    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    // Get current counts for audit
    const counts = await getModelReferenceCounts(targetModelId);

    // Get model ID strings for nexus_conversations update
    const [targetModel, replacementModel] = await Promise.all([
      getAIModelById(targetModelId),
      getAIModelById(replacementModelId),
    ]);

    if (!targetModel || !replacementModel) {
      throw ErrorFactories.dbRecordNotFound("ai_models", targetModelId);
    }

    // Execute all updates using transactions
    const result = await executeQuery(
      async (db) => {
        // Update chain_prompts
        if (counts.chainPromptsCount > 0) {
          await db
            .update(chainPrompts)
            .set({ modelId: replacementModelId, updatedAt: new Date() })
            .where(eq(chainPrompts.modelId, targetModelId));
        }

        // Update nexus_messages
        if (counts.nexusMessagesCount > 0) {
          await db
            .update(nexusMessages)
            .set({ modelId: replacementModelId, updatedAt: new Date() })
            .where(eq(nexusMessages.modelId, targetModelId));
        }

        // Update nexus_conversations (uses model_id string, not FK)
        if (counts.nexusConversationsCount > 0) {
          await db
            .update(nexusConversations)
            .set({
              modelUsed: replacementModel.modelId,
              updatedAt: new Date(),
            })
            .where(eq(nexusConversations.modelUsed, targetModel.modelId));
        }

        // Update model_comparisons (both columns)
        if (counts.modelComparisonsCount > 0) {
          await db
            .update(modelComparisons)
            .set({ model1Id: replacementModelId, updatedAt: new Date() })
            .where(eq(modelComparisons.model1Id, targetModelId));

          await db
            .update(modelComparisons)
            .set({ model2Id: replacementModelId, updatedAt: new Date() })
            .where(eq(modelComparisons.model2Id, targetModelId));
        }

        // Record in audit table
        await db.insert(modelReplacementAudit).values({
          id: Date.now(), // Use timestamp as bigint ID
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
        await db.delete(aiModels).where(eq(aiModels.id, targetModelId));

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
