import { LanguageModel } from "ai";
import { createProviderModelWithCapabilities } from "@/lib/ai/provider-factory";
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
} from "@/lib/logger";
import { executeSQL, type DatabaseRow } from "./db-helpers";
import type { ProviderCapabilities } from "@/lib/streaming/types";
import { hasCapability } from "@/lib/ai/capability-utils";

const log = createLogger({ module: "nexus-provider-factory" });

// Database model info interface
interface DatabaseModelInfo extends DatabaseRow {
  provider: string;
  modelId: string;
  name: string;
  description?: string;
  maxTokens?: number;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  cachedInputCostPer1kTokens?: number;
  averageLatencyMs?: number;
  maxConcurrency?: number;
  supportsBatching?: boolean;
  capabilities?: string | string[] | null;
  providerMetadata?: Record<string, unknown>;
}

export interface NexusModelOptions {
  conversationId?: string;
  enableCaching?: boolean;
  enableOptimizations?: boolean;
  routingStrategy?: "cost" | "latency" | "quality" | "intelligent";
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  responseMode?: "standard" | "flex" | "priority";
  backgroundMode?: boolean;
  thinkingBudget?: number;
  useResponsesAPI?: boolean;
  enablePromptCache?: boolean;
  enableContextCache?: boolean;
}

export interface NexusModelCapabilities {
  // Base capabilities from provider
  supportsReasoning: boolean;
  supportsThinking: boolean;
  supportsToolCalls: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  maxTimeoutMs: number;
  maxTokens?: number;

  // Enhanced capabilities for Nexus features
  responsesAPI?: boolean;
  promptCaching?: boolean;
  contextCaching?: boolean;
  artifacts?: boolean;
  canvas?: boolean;
  webSearch?: boolean;
  codeInterpreter?: boolean;
  grounding?: boolean;
  codeExecution?: boolean;
  computerUse?: boolean;
  workspaceTools?: boolean;
  mcpSupport?: boolean;

  // Performance characteristics
  costPerToken?: number;
  averageLatency?: number;
  maxConcurrency?: number;
  supportsBatching?: boolean;
}

export interface NexusLanguageModel {
  // Enhanced model with Nexus-specific features
  model: LanguageModel;
  capabilities: NexusModelCapabilities;
  providerMetadata: {
    provider: string;
    modelId: string;
    pricing?: {
      inputCostPerToken: number;
      outputCostPerToken: number;
      cachingDiscount?: number;
    };
    limits?: {
      maxTokens: number;
      maxRequests: number;
      contextWindow: number;
    };
  };

  // Nexus-specific methods
  enableCaching?(): void;
  getCacheMetrics?(): Promise<CacheMetrics>;
  estimateCost?(tokens: number): number;
}

export interface CacheMetrics {
  hitRate: number;
  totalRequests: number;
  tokensSaved: number;
  costSaved: number;
}

function includesAny(modelId: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => modelId.includes(pattern));
}

function baseNexusCapabilities(
  base: ProviderCapabilities,
  modelInfo: DatabaseModelInfo | null,
): NexusModelCapabilities {
  return {
    supportsReasoning: base.supportsReasoning,
    supportsThinking: base.supportsThinking,
    supportsToolCalls: false,
    supportsImages: false,
    supportsAudio: false,
    maxTimeoutMs: base.maxTimeoutMs,
    maxTokens: modelInfo?.maxTokens,
    responsesAPI: false,
    promptCaching: false,
    contextCaching: false,
    artifacts: false,
    canvas: false,
    webSearch: false,
    codeInterpreter: false,
    grounding: false,
    codeExecution: false,
    computerUse: false,
    workspaceTools: false,
    mcpSupport: true,
    supportsBatching: false,
  };
}

function applyDatabaseCapabilities(
  enhanced: NexusModelCapabilities,
  modelInfo: DatabaseModelInfo,
  base: ProviderCapabilities,
): void {
  const stored = modelInfo.capabilities;
  if (stored) {
    enhanced.responsesAPI = hasCapability(stored, "responsesAPI");
    enhanced.promptCaching = hasCapability(stored, "promptCaching");
    enhanced.contextCaching = hasCapability(stored, "contextCaching");
    enhanced.artifacts = hasCapability(stored, "artifacts");
    enhanced.canvas = hasCapability(stored, "canvas");
    enhanced.webSearch = hasCapability(stored, "webSearch");
    enhanced.codeInterpreter = hasCapability(stored, "codeInterpreter");
    enhanced.grounding = hasCapability(stored, "grounding");
    enhanced.codeExecution = hasCapability(stored, "codeExecution");
    enhanced.computerUse = hasCapability(stored, "computerUse");
    enhanced.workspaceTools = hasCapability(stored, "workspaceTools");
    enhanced.supportsReasoning =
      hasCapability(stored, "reasoning") || base.supportsReasoning;
    enhanced.supportsThinking =
      hasCapability(stored, "thinking") || base.supportsThinking;
  }
  enhanced.averageLatency =
    modelInfo.averageLatencyMs || enhanced.averageLatency;
  enhanced.maxConcurrency = modelInfo.maxConcurrency || enhanced.maxConcurrency;
  enhanced.supportsBatching =
    modelInfo.supportsBatching || enhanced.supportsBatching;
  enhanced.costPerToken = modelInfo.inputCostPer1kTokens
    ? modelInfo.inputCostPer1kTokens / 1000
    : enhanced.costPerToken;
}

type ProviderEnhancer = (
  capabilities: NexusModelCapabilities,
  modelId: string,
  hasDatabaseModel: boolean,
) => void;

const PROVIDER_ENHANCERS: Record<string, ProviderEnhancer> = {
  openai(capabilities, modelId, hasDatabaseModel) {
    if (!hasDatabaseModel) {
      capabilities.responsesAPI = includesAny(modelId, [
        "gpt-5",
        "gpt-4.1",
        "gpt-4o",
      ]);
      capabilities.canvas = includesAny(modelId, ["gpt-4o", "gpt-5"]);
      capabilities.webSearch = true;
      capabilities.codeInterpreter = true;
    }
    capabilities.averageLatency = 800;
    capabilities.maxConcurrency = 50;
    capabilities.supportsBatching = false;
  },
  "amazon-bedrock"(capabilities, modelId, hasDatabaseModel) {
    if (!hasDatabaseModel) {
      capabilities.promptCaching = includesAny(modelId, [
        "claude-3",
        "claude-4",
        "claude-opus",
        "claude-sonnet",
      ]);
      capabilities.artifacts = includesAny(modelId, [
        "claude-3.5",
        "claude-4",
        "claude-opus",
        "claude-sonnet",
      ]);
      capabilities.computerUse = modelId.includes("computer-use");
    }
    capabilities.averageLatency = 1200;
    capabilities.maxConcurrency = 20;
    capabilities.supportsBatching = true;
  },
  google(capabilities, modelId, hasDatabaseModel) {
    if (!hasDatabaseModel) {
      capabilities.contextCaching = includesAny(modelId, [
        "gemini-2",
        "gemini-1.5",
      ]);
      capabilities.grounding = true;
      capabilities.codeExecution = true;
      capabilities.workspaceTools = true;
    }
    capabilities.averageLatency = 600;
    capabilities.maxConcurrency = 100;
    capabilities.supportsBatching = true;
  },
  azure(capabilities, _modelId, hasDatabaseModel) {
    if (!hasDatabaseModel) {
      capabilities.webSearch = true;
      capabilities.codeInterpreter = true;
    }
    capabilities.averageLatency = 900;
    capabilities.maxConcurrency = 30;
    capabilities.supportsBatching = false;
  },
};

function applyProviderEnhancements(
  capabilities: NexusModelCapabilities,
  provider: string,
  modelId: string,
  hasDatabaseModel: boolean,
): void {
  PROVIDER_ENHANCERS[provider.toLowerCase()]?.(
    capabilities,
    modelId,
    hasDatabaseModel,
  );
}

const FEATURE_MATCHERS: Record<
  string,
  (capabilities: NexusModelCapabilities) => boolean
> = {
  reasoning: (capabilities) => capabilities.supportsReasoning,
  thinking: (capabilities) => capabilities.supportsThinking,
  caching: (capabilities) =>
    Boolean(capabilities.promptCaching || capabilities.contextCaching),
  web: (capabilities) =>
    Boolean(capabilities.webSearch || capabilities.grounding),
  code: (capabilities) =>
    Boolean(capabilities.codeInterpreter || capabilities.codeExecution),
  artifacts: (capabilities) => Boolean(capabilities.artifacts),
  canvas: (capabilities) => Boolean(capabilities.canvas),
  computer: (capabilities) => Boolean(capabilities.computerUse),
};

type ModelEstimate = { patterns: readonly string[]; value: number };

function estimateFromPatterns(
  modelId: string,
  estimates: readonly ModelEstimate[],
  fallback: number,
): number {
  return (
    estimates.find((estimate) => includesAny(modelId, estimate.patterns))
      ?.value ?? fallback
  );
}

const COST_ESTIMATES: Record<
  string,
  { models: readonly ModelEstimate[]; fallback: number }
> = {
  openai: {
    models: [
      { patterns: ["gpt-5"], value: 0.00006 },
      { patterns: ["gpt-4.1"], value: 0.00005 },
      { patterns: ["gpt-4o"], value: 0.00003 },
      { patterns: ["gpt-4"], value: 0.00005 },
    ],
    fallback: 0.000002,
  },
  "amazon-bedrock": {
    models: [
      { patterns: ["claude-opus"], value: 0.000015 },
      {
        patterns: ["claude-3.5-sonnet", "claude-sonnet"],
        value: 0.000003,
      },
      {
        patterns: ["claude-3-haiku", "claude-haiku"],
        value: 0.00000025,
      },
      { patterns: ["deepseek"], value: 0.0000002 },
    ],
    fallback: 0.000008,
  },
  google: {
    models: [
      { patterns: ["gemini-2.5"], value: 0.0000025 },
      { patterns: ["gemini-2.0-flash"], value: 0.0000015 },
      { patterns: ["gemini-1.5-pro"], value: 0.00000125 },
      { patterns: ["gemini-1.5-flash"], value: 0.000000075 },
    ],
    fallback: 0.000001,
  },
};

function estimatedCostPerToken(provider: string, modelId: string): number {
  const normalized = provider.toLowerCase();
  if (normalized === "azure") {
    return estimatedCostPerToken("openai", modelId) * 1.1;
  }
  const estimates = COST_ESTIMATES[normalized];
  return estimates
    ? estimateFromPatterns(modelId, estimates.models, estimates.fallback)
    : 0.000001;
}

const CONTEXT_ESTIMATES: Record<
  string,
  { models: readonly ModelEstimate[]; fallback: number }
> = {
  openai: {
    models: [
      { patterns: ["gpt-5"], value: 200000 },
      { patterns: ["gpt-4.1"], value: 1000000 },
      { patterns: ["gpt-4o"], value: 128000 },
    ],
    fallback: 8000,
  },
  "amazon-bedrock": {
    models: [
      {
        patterns: ["claude-opus", "claude-sonnet", "claude-3.5", "claude-4"],
        value: 200000,
      },
      { patterns: ["deepseek"], value: 128000 },
    ],
    fallback: 100000,
  },
  google: {
    models: [
      { patterns: ["gemini-2"], value: 2000000 },
      { patterns: ["gemini-1.5"], value: 1000000 },
    ],
    fallback: 32000,
  },
};

function estimatedContextWindow(provider: string, modelId: string): number {
  const normalized =
    provider.toLowerCase() === "azure" ? "openai" : provider.toLowerCase();
  const estimates = CONTEXT_ESTIMATES[normalized];
  return estimates
    ? estimateFromPatterns(modelId, estimates.models, estimates.fallback)
    : 8000;
}

function providerPricing(
  modelInfo: DatabaseModelInfo | null,
  capabilities: NexusModelCapabilities,
  fallbackCachingDiscount: number,
): NonNullable<NexusLanguageModel["providerMetadata"]["pricing"]> {
  return {
    inputCostPerToken: modelInfo?.inputCostPer1kTokens
      ? modelInfo.inputCostPer1kTokens / 1000
      : capabilities.costPerToken || 0,
    outputCostPerToken: modelInfo?.outputCostPer1kTokens
      ? modelInfo.outputCostPer1kTokens / 1000
      : (capabilities.costPerToken || 0) * 1.5,
    cachingDiscount: modelInfo?.cachedInputCostPer1kTokens
      ? 1 -
        modelInfo.cachedInputCostPer1kTokens /
          (modelInfo.inputCostPer1kTokens || 1)
      : fallbackCachingDiscount,
  };
}

function providerLimits(
  modelInfo: DatabaseModelInfo | null,
  capabilities: NexusModelCapabilities,
  estimatedContext: number,
): NonNullable<NexusLanguageModel["providerMetadata"]["limits"]> {
  return {
    maxTokens: modelInfo?.maxTokens || capabilities.maxTokens || 4000,
    maxRequests: modelInfo?.maxConcurrency || capabilities.maxConcurrency || 10,
    contextWindow: modelInfo?.maxTokens || estimatedContext,
  };
}

/**
 * Enhanced provider factory for Nexus that extends the base provider factory
 * with advanced features like caching, optimization, and provider-specific capabilities
 */
export class NexusProviderFactory {
  private responseCache: ResponseCacheManager;
  private costOptimizer: CostOptimizer;
  private metricsCollector: MetricsCollector;

  constructor() {
    this.responseCache = new ResponseCacheManager();
    this.costOptimizer = new CostOptimizer();
    this.metricsCollector = new MetricsCollector();
  }

  /**
   * Create an enhanced Nexus model with advanced capabilities
   */
  async createNexusModel(
    provider: string,
    modelId: string,
    options: NexusModelOptions = {},
  ): Promise<NexusLanguageModel> {
    const _requestId = generateRequestId();
    const startTime = Date.now();

    log.info("Creating Nexus model", {
      requestId: _requestId,
      provider,
      modelId,
      options: sanitizeForLogging(options),
    });

    try {
      // Use existing factory for base model creation with capabilities
      const { model, capabilities } = await createProviderModelWithCapabilities(
        provider,
        modelId,
        {
          reasoningEffort: options.reasoningEffort,
          responseMode: options.responseMode,
          backgroundMode: options.backgroundMode,
          thinkingBudget: options.thinkingBudget,
        },
      );

      // Enhance capabilities with Nexus-specific features
      const nexusCapabilities = await this.enhanceCapabilities(
        provider,
        modelId,
        capabilities,
        options,
      );

      // Create enhanced model wrapper
      const nexusModel = await this.wrapWithNexusFeatures(model, {
        provider,
        modelId,
        capabilities: nexusCapabilities,
        options,
        requestId: _requestId,
      });

      // Record metrics
      await this.metricsCollector.recordModelCreation({
        provider,
        modelId,
        capabilities: nexusCapabilities,
        creationTime: Date.now() - startTime,
        requestId: _requestId,
      });

      log.info("Nexus model created successfully", {
        requestId: _requestId,
        provider,
        modelId,
        capabilities: {
          supportsReasoning: nexusCapabilities.supportsReasoning,
          supportsThinking: nexusCapabilities.supportsThinking,
          responsesAPI: nexusCapabilities.responsesAPI,
          caching:
            nexusCapabilities.promptCaching || nexusCapabilities.contextCaching,
        },
      });

      return nexusModel;
    } catch (error) {
      log.error("Failed to create Nexus model", {
        requestId: _requestId,
        provider,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Enhance base capabilities with provider-specific Nexus features
   */
  private async enhanceCapabilities(
    provider: string,
    modelId: string,
    baseCapabilities: ProviderCapabilities,
    options: NexusModelOptions,
  ): Promise<NexusModelCapabilities> {
    const modelInfo = await this.getModelInfoFromDatabase(provider, modelId);
    const enhanced = baseNexusCapabilities(baseCapabilities, modelInfo);
    if (modelInfo) {
      try {
        applyDatabaseCapabilities(enhanced, modelInfo, baseCapabilities);
      } catch (error) {
        log.warn("Failed to parse capabilities from database", {
          provider,
          modelId,
          capabilities: modelInfo?.capabilities,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    applyProviderEnhancements(enhanced, provider, modelId, Boolean(modelInfo));
    enhanced.costPerToken = await this.getModelCostFromDatabase(
      provider,
      modelId,
    );

    // Apply user preferences
    if (options.enableCaching === false) {
      enhanced.promptCaching = false;
      enhanced.contextCaching = false;
    }

    return enhanced;
  }

  /**
   * Wrap the base model with Nexus-specific features
   */
  private async providerMetadata(
    provider: string,
    modelId: string,
    capabilities: NexusModelCapabilities,
    modelInfo: DatabaseModelInfo | null,
  ): Promise<NexusLanguageModel["providerMetadata"]> {
    const estimatedContext =
      modelInfo?.maxTokens || (await this.getContextWindow(provider, modelId));
    return {
      provider,
      modelId,
      pricing: providerPricing(
        modelInfo,
        capabilities,
        this.getCachingDiscount(provider),
      ),
      limits: providerLimits(modelInfo, capabilities, estimatedContext),
    };
  }

  private attachCacheMethods(
    model: NexusLanguageModel,
    config: {
      provider: string;
      modelId: string;
      conversationId?: string;
    },
  ): void {
    model.enableCaching = () => {
      this.responseCache.enableForModel(
        config.provider,
        config.modelId,
        config.conversationId,
      );
    };
    model.getCacheMetrics = () => this.responseCache.getMetrics();
  }

  private attachCostEstimator(
    model: NexusLanguageModel,
    provider: string,
    modelId: string,
  ): void {
    model.estimateCost = (tokens: number) => {
      const inputCost = model.providerMetadata.pricing?.inputCostPerToken || 0;
      const outputCost =
        model.providerMetadata.pricing?.outputCostPerToken || 0;
      const baseCost = tokens * (inputCost * 0.6 + outputCost * 0.4);
      const discount = this.responseCache.isEnabled(provider, modelId)
        ? model.providerMetadata.pricing?.cachingDiscount || 0
        : 0;
      return baseCost * (1 - discount);
    };
  }

  private async wrapWithNexusFeatures(
    model: LanguageModel,
    config: {
      provider: string;
      modelId: string;
      capabilities: NexusModelCapabilities;
      options: NexusModelOptions;
      requestId: string;
    },
  ): Promise<NexusLanguageModel> {
    const { provider, modelId, capabilities, options } = config;

    // Get model info from database for pricing and metadata
    const modelInfo = await this.getModelInfoFromDatabase(provider, modelId);

    const providerMetadata = await this.providerMetadata(
      provider,
      modelId,
      capabilities,
      modelInfo,
    );
    const nexusModel: NexusLanguageModel = {
      model,
      capabilities,
      providerMetadata,
    };

    if (capabilities.promptCaching || capabilities.contextCaching) {
      this.attachCacheMethods(nexusModel, {
        provider,
        modelId,
        conversationId: options.conversationId,
      });
    }
    this.attachCostEstimator(nexusModel, provider, modelId);
    return nexusModel;
  }

  /**
   * Get available capabilities for a provider/model combination
   */
  async getAvailableCapabilities(
    provider: string,
    modelId: string,
  ): Promise<NexusModelCapabilities> {
    const baseCapabilities = await createProviderModelWithCapabilities(
      provider,
      modelId,
    );
    return this.enhanceCapabilities(
      provider,
      modelId,
      baseCapabilities.capabilities,
      {},
    );
  }

  /**
   * Recommend optimal provider for given requirements
   */
  async recommendProvider(requirements: {
    priority: "cost" | "speed" | "quality" | "features";
    features?: string[];
    maxCost?: number;
    maxLatency?: number;
  }): Promise<{ provider: string; modelId: string; score: number }[]> {
    const providers = ["openai", "google", "amazon-bedrock", "azure"];
    const recommendations: {
      provider: string;
      modelId: string;
      score: number;
    }[] = [];

    for (const provider of providers) {
      const models = await this.getModelsForProvider(provider);
      for (const modelId of models) {
        const capabilities = await this.getAvailableCapabilities(
          provider,
          modelId,
        );
        const score = this.calculateProviderScore(capabilities, requirements);

        if (score > 0) {
          recommendations.push({ provider, modelId, score });
        }
      }
    }

    return recommendations.sort((a, b) => b.score - a.score);
  }

  // Private database-driven helper methods

  private async loadModelsFromDatabase(): Promise<DatabaseModelInfo[]> {
    try {
      const results = await executeSQL<DatabaseModelInfo>(`
        SELECT
          provider,
          model_id as "modelId",
          name,
          description,
          max_tokens as "maxTokens",
          input_cost_per_1k_tokens as "inputCostPer1kTokens",
          output_cost_per_1k_tokens as "outputCostPer1kTokens",
          cached_input_cost_per_1k_tokens as "cachedInputCostPer1kTokens",
          average_latency_ms as "averageLatencyMs",
          max_concurrency as "maxConcurrency",
          supports_batching as "supportsBatching",
          capabilities,
          provider_metadata as "providerMetadata"
        FROM ai_models
        WHERE enabled = true
        ORDER BY provider, model_id
      `);

      return results;
    } catch (error) {
      log.error("Failed to load models from database", { error });
      return [];
    }
  }

  /**
   * Get model information from database
   */
  private async getModelInfoFromDatabase(
    provider: string,
    modelId: string,
  ): Promise<DatabaseModelInfo | null> {
    try {
      const result = await executeSQL<DatabaseModelInfo>(
        `
        SELECT
          provider,
          model_id as "modelId",
          name,
          description,
          max_tokens as "maxTokens",
          input_cost_per_1k_tokens as "inputCostPer1kTokens",
          output_cost_per_1k_tokens as "outputCostPer1kTokens",
          cached_input_cost_per_1k_tokens as "cachedInputCostPer1kTokens",
          average_latency_ms as "averageLatencyMs",
          max_concurrency as "maxConcurrency",
          supports_batching as "supportsBatching",
          capabilities,
          provider_metadata as "providerMetadata"
        FROM ai_models
        WHERE provider = $1 AND model_id = $2 AND active = true
        LIMIT 1
      `,
        [provider, modelId],
      );

      if (result.length > 0) {
        return result[0];
      }

      return null;
    } catch (error) {
      log.warn("Failed to get model info from database", {
        provider,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get model cost from database or use provider-based estimates
   */
  private async getModelCostFromDatabase(
    provider: string,
    modelId: string,
  ): Promise<number> {
    try {
      // First check if we have the model in database with structured pricing columns
      const result = await executeSQL<{
        input_cost_per_1k_tokens: number;
        output_cost_per_1k_tokens: number;
      }>(
        `
        SELECT 
          input_cost_per_1k_tokens,
          output_cost_per_1k_tokens
        FROM ai_models 
        WHERE provider = $1 AND model_id = $2 AND active = true
        LIMIT 1
      `,
        [provider, modelId],
      );

      if (result.length > 0 && result[0].input_cost_per_1k_tokens !== null) {
        // Convert from per-1k-tokens to per-token and use input cost as base estimate
        // For cost estimation purposes, we use input token cost as the primary metric
        return result[0].input_cost_per_1k_tokens / 1000;
      }

      // Fallback to provider-based estimates
      return this.estimateCostPerToken(provider, modelId);
    } catch (error) {
      log.warn("Failed to get model cost from database", {
        provider,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.estimateCostPerToken(provider, modelId);
    }
  }

  /**
   * Estimate cost per token based on provider and model patterns
   */
  private estimateCostPerToken(provider: string, modelId: string): number {
    return estimatedCostPerToken(provider, modelId);
  }

  /**
   * Get caching discount based on provider
   */
  private getCachingDiscount(provider: string): number {
    switch (provider.toLowerCase()) {
      case "anthropic":
      case "amazon-bedrock":
        return 0.9; // 90% discount with prompt caching
      case "google":
        return 0.75; // 75% discount with context caching
      default:
        return 0;
    }
  }

  /**
   * Get context window from database or estimate
   */
  private async getContextWindow(
    provider: string,
    modelId: string,
  ): Promise<number> {
    try {
      const result = await executeSQL<{ max_tokens: number }>(
        `
        SELECT max_tokens FROM ai_models 
        WHERE provider = $1 AND model_id = $2 AND active = true
        LIMIT 1
      `,
        [provider, modelId],
      );

      if (result.length > 0 && result[0].max_tokens) {
        return result[0].max_tokens;
      }
    } catch (error) {
      log.warn("Failed to get context window from database", {
        provider,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return estimatedContextWindow(provider, modelId);
  }

  /**
   * Get available models for a provider from database
   */
  private async getModelsForProvider(provider: string): Promise<string[]> {
    try {
      // Note: RDS Data API adapter transforms snake_case to camelCase
      const result = await executeSQL<{ modelId: string }>(
        `
        SELECT model_id FROM ai_models
        WHERE provider = $1 AND active = true AND nexus_enabled = true
        ORDER BY name
      `,
        [provider],
      );

      if (result.length > 0) {
        return result.map((row) => row.modelId);
      }
    } catch (error) {
      log.warn("Failed to get models from database", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Return empty array if no models found in database
    return [];
  }

  private satisfiesProviderConstraints(
    capabilities: NexusModelCapabilities,
    requirements: { maxCost?: number; maxLatency?: number },
  ): boolean {
    const cost = capabilities.costPerToken || 0;
    const latency = capabilities.averageLatency || 0;
    if (requirements.maxCost && cost > requirements.maxCost) return false;
    if (requirements.maxLatency && latency > requirements.maxLatency)
      return false;
    return true;
  }

  private priorityScore(
    capabilities: NexusModelCapabilities,
    priority: "cost" | "speed" | "quality" | "features",
    features: string[],
  ): number {
    if (priority === "cost") {
      return 100 - (capabilities.costPerToken || 0) * 100000;
    }
    if (priority === "speed") {
      return 100 - (capabilities.averageLatency || 0) / 50;
    }
    if (priority === "quality") {
      return (
        (capabilities.supportsReasoning ? 100 : 50) +
        (capabilities.supportsThinking ? 20 : 0)
      );
    }
    return this.countMatchingFeatures(capabilities, features) * 10;
  }

  private calculateProviderScore(
    capabilities: NexusModelCapabilities,
    requirements: {
      priority: "cost" | "speed" | "quality" | "features";
      features?: string[];
      maxCost?: number;
      maxLatency?: number;
    },
  ): number {
    if (!this.satisfiesProviderConstraints(capabilities, requirements))
      return 0;
    return Math.max(
      0,
      this.priorityScore(
        capabilities,
        requirements.priority,
        requirements.features || [],
      ),
    );
  }

  private countMatchingFeatures(
    capabilities: NexusModelCapabilities,
    requiredFeatures: string[],
  ): number {
    return requiredFeatures.filter((feature) =>
      FEATURE_MATCHERS[feature]?.(capabilities),
    ).length;
  }
}

// Helper classes (simplified implementations)

class ResponseCacheManager {
  private enabledModels = new Set<string>();

  enableForModel(provider: string, modelId: string, conversationId?: string) {
    this.enabledModels.add(
      `${provider}:${modelId}:${conversationId || "global"}`,
    );
  }

  isEnabled(
    provider: string,
    modelId: string,
    conversationId?: string,
  ): boolean {
    return this.enabledModels.has(
      `${provider}:${modelId}:${conversationId || "global"}`,
    );
  }

  async getMetrics(): Promise<CacheMetrics> {
    // This would query the nexus_cache_entries table
    return {
      hitRate: 0.75,
      totalRequests: 100,
      tokensSaved: 50000,
      costSaved: 2.5,
    };
  }
}

class CostOptimizer {
  // Placeholder for cost optimization logic
  // Would analyze usage patterns and recommend optimizations
}

class MetricsCollector {
  async recordModelCreation(data: {
    provider: string;
    modelId: string;
    capabilities: NexusModelCapabilities;
    creationTime: number;
    requestId: string;
  }) {
    // This would record metrics to CloudWatch or database
    log.debug("Model creation metrics recorded", data);
  }
}

// Export singleton instance
export const nexusProviderFactory = new NexusProviderFactory();
