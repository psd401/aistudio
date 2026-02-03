import { createLogger } from '@/lib/logger';
import { executeSQL, type DatabaseRow } from './db-helpers';
import { hasCapability, hasAnyCapability } from '@/lib/ai/capability-utils';

const log = createLogger({ module: 'cost-optimizer' });

// Database row interfaces for cost optimization queries (camelCase)
interface CostModelRow extends DatabaseRow {
  inputCostPer1kTokens: number | null;
  outputCostPer1kTokens: number | null;
}

interface UsageMetricsRow extends DatabaseRow {
  provider: string;
  modelId: string;
  totalCost: number | null;
  totalTokens: number | null;
  requestCount: number;
  usageDate: string;
}

// Transform model data with proper typing
interface TransformedModel extends DatabaseRow {
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
  allowedRoles?: string[];
}

export interface CostOptimizationRequest {
  userId: string;
  conversationId?: string;
  provider: string;
  modelId: string;
  estimatedTokens: number;
  priority: 'cost' | 'quality' | 'speed';
  budget?: number;
}

export interface CostOptimizationResult {
  recommendedProvider: string;
  recommendedModel: string;
  estimatedCost: number;
  savingsAmount: number;
  savingsPercent: number;
  reasoning: string;
  alternatives: Array<{
    provider: string;
    modelId: string;
    cost: number;
    tradeoffs: string;
  }>;
}

/**
 * Cost optimizer for intelligent provider/model selection
 */
export class CostOptimizer {
  private modelCache = new Map<string, TransformedModel>();
  private cacheExpiry = 5 * 60 * 1000; // 5 minutes
  private lastCacheRefresh = 0;
  
  /**
   * Optimize provider/model selection based on cost and requirements
   */
  async optimize(request: CostOptimizationRequest): Promise<CostOptimizationResult> {
    log.info('Optimizing cost for request', {
      provider: request.provider,
      modelId: request.modelId,
      tokens: request.estimatedTokens,
      priority: request.priority,
      budget: request.budget
    });
    
    try {
      // Get all available models with pricing
      const models = await this.getModelsWithPricing();
      
      // Get current model cost
      const currentCost = await this.calculateCost(
        request.provider, 
        request.modelId, 
        request.estimatedTokens
      );
      
      // Filter models based on requirements
      const eligibleModels = await this.filterEligibleModels(models, request);
      
      // Rank models by optimization criteria
      const rankedModels = this.rankModels(eligibleModels, request);
      
      // Select best alternative
      const recommended = rankedModels[0];
      
      if (!recommended) {
        // No better alternative found
        return {
          recommendedProvider: request.provider,
          recommendedModel: request.modelId,
          estimatedCost: currentCost,
          savingsAmount: 0,
          savingsPercent: 0,
          reasoning: 'Current model is already optimal for your requirements',
          alternatives: []
        };
      }
      
      const recommendedCost = await this.calculateCost(
        recommended.provider,
        recommended.modelId,
        request.estimatedTokens
      );
      
      const savingsAmount = currentCost - recommendedCost;
      const savingsPercent = currentCost > 0 ? (savingsAmount / currentCost) * 100 : 0;
      
      // Get top alternatives
      const alternatives = rankedModels.slice(1, 4).map(model => ({
        provider: model.provider,
        modelId: model.modelId,
        cost: this.calculateCostForModel(model, request.estimatedTokens),
        tradeoffs: this.describeTradeoffs(model, recommended)
      }));
      
      return {
        recommendedProvider: recommended.provider,
        recommendedModel: recommended.modelId,
        estimatedCost: recommendedCost,
        savingsAmount: Math.max(0, savingsAmount),
        savingsPercent: Math.max(0, savingsPercent),
        reasoning: this.generateReasoning(recommended, request),
        alternatives
      };
      
    } catch (error) {
      log.error('Cost optimization failed', {
        error: error instanceof Error ? error.message : String(error),
        request
      });
      
      // Return current model on error
      return {
        recommendedProvider: request.provider,
        recommendedModel: request.modelId,
        estimatedCost: 0,
        savingsAmount: 0,
        savingsPercent: 0,
        reasoning: 'Cost optimization unavailable',
        alternatives: []
      };
    }
  }
  
  /**
   * Get usage patterns for cost analysis
   */
  async analyzeUsagePatterns(userId: string, days: number = 30): Promise<{
    totalCost: number;
    avgCostPerDay: number;
    topModels: Array<{ provider: string; modelId: string; cost: number; usage: number }>;
    costTrend: 'increasing' | 'decreasing' | 'stable';
    savingsOpportunity: number;
  }> {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      // Get usage metrics (with camelCase aliases)
      const usageResult = await executeSQL<UsageMetricsRow>(`
        SELECT
          provider,
          model_id AS "modelId",
          SUM(cost_usd) AS "totalCost",
          SUM(prompt_tokens + completion_tokens) AS "totalTokens",
          COUNT(*) AS "requestCount",
          DATE(created_at) AS "usageDate"
        FROM nexus_provider_metrics npm
        JOIN nexus_conversations nc ON npm.conversation_id = nc.id
        WHERE nc.user_id = $1
          AND npm.created_at >= $2
        GROUP BY provider, model_id, DATE(created_at)
        ORDER BY "totalCost" DESC
      `, [userId, startDate.toISOString()]);
      
      // Calculate metrics
      const totalCost = usageResult.reduce((sum, row) => sum + (row.totalCost || 0), 0);
      const avgCostPerDay = totalCost / days;

      // Get top models by cost
      const modelCosts = new Map<string, { cost: number; tokens: number }>();
      for (const row of usageResult) {
        const key = `${row.provider}:${row.modelId}`;
        const existing = modelCosts.get(key) || { cost: 0, tokens: 0 };
        modelCosts.set(key, {
          cost: existing.cost + (row.totalCost || 0),
          tokens: existing.tokens + (row.totalTokens || 0)
        });
      }
      
      const topModels = Array.from(modelCosts.entries())
        .map(([key, data]) => {
          const [provider, modelId] = key.split(':');
          return {
            provider,
            modelId,
            cost: data.cost,
            usage: data.tokens
          };
        })
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 5);
      
      // Calculate cost trend
      const recentCost = usageResult
        .filter((row) => {
          const rowDate = new Date(row.usageDate);
          const daysAgo = (Date.now() - rowDate.getTime()) / (1000 * 60 * 60 * 24);
          return daysAgo <= 7;
        })
        .reduce((sum, row) => sum + (row.totalCost || 0), 0);

      const olderCost = usageResult
        .filter((row) => {
          const rowDate = new Date(row.usageDate);
          const daysAgo = (Date.now() - rowDate.getTime()) / (1000 * 60 * 60 * 24);
          return daysAgo > 7 && daysAgo <= 14;
        })
        .reduce((sum, row) => sum + (row.totalCost || 0), 0);
      
      let costTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
      if (recentCost > olderCost * 1.1) {
        costTrend = 'increasing';
      } else if (recentCost < olderCost * 0.9) {
        costTrend = 'decreasing';
      }
      
      // Calculate savings opportunity
      const savingsOpportunity = await this.calculateSavingsOpportunity(topModels);
      
      return {
        totalCost,
        avgCostPerDay,
        topModels,
        costTrend,
        savingsOpportunity
      };
      
    } catch (error) {
      log.error('Failed to analyze usage patterns', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        totalCost: 0,
        avgCostPerDay: 0,
        topModels: [],
        costTrend: 'stable',
        savingsOpportunity: 0
      };
    }
  }
  
  // Private helper methods
  
  private async getModelsWithPricing(): Promise<TransformedModel[]> {
    // Check cache
    if (this.modelCache.size > 0 && Date.now() - this.lastCacheRefresh < this.cacheExpiry) {
      return Array.from(this.modelCache.values());
    }
    
    try {
      const result = await executeSQL<TransformedModel>(`
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
          provider_metadata as "providerMetadata",
          allowed_roles as "allowedRoles"
        FROM ai_models
        WHERE active = true AND nexus_enabled = true
        ORDER BY provider, name
      `);

      const models = result;
      
      // Update cache
      this.modelCache.clear();
      for (const model of models) {
        this.modelCache.set(`${model.provider}:${model.modelId}`, model);
      }
      this.lastCacheRefresh = Date.now();
      
      return models;
      
    } catch (error) {
      log.error('Failed to get models with pricing', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
  
  private async calculateCost(provider: string, modelId: string, tokens: number): Promise<number> {
    const model = this.modelCache.get(`${provider}:${modelId}`);
    
    if (!model) {
      // Try to fetch from database (with camelCase aliases)
      const result = await executeSQL<CostModelRow>(`
        SELECT
          input_cost_per_1k_tokens AS "inputCostPer1kTokens",
          output_cost_per_1k_tokens AS "outputCostPer1kTokens"
        FROM ai_models
        WHERE provider = $1 AND model_id = $2
        LIMIT 1
      `, [provider, modelId]);
      
      if (result.length > 0) {
        const inputCost = result[0].inputCostPer1kTokens || 0;
        const outputCost = result[0].outputCostPer1kTokens || 0;
        // Rough estimate: 60% input, 40% output
        return (tokens / 1000) * (inputCost * 0.6 + outputCost * 0.4);
      }
      
      return 0;
    }
    
    return this.calculateCostForModel(model, tokens);
  }
  
  private calculateCostForModel(model: TransformedModel, tokens: number): number {
    const inputCost = model.inputCostPer1kTokens || 0;
    const outputCost = model.outputCostPer1kTokens || 0;
    // Rough estimate: 60% input, 40% output
    return (tokens / 1000) * (inputCost * 0.6 + outputCost * 0.4);
  }
  
  private async filterEligibleModels(
    models: TransformedModel[], 
    request: CostOptimizationRequest
  ): Promise<TransformedModel[]> {
    return models.filter(model => {
      // Check budget constraint
      if (request.budget) {
        const cost = this.calculateCostForModel(model, request.estimatedTokens);
        if (cost > request.budget) {
          return false;
        }
      }
      
      // Check role access
      if (model.allowedRoles && model.allowedRoles.length > 0) {
        // Would need to check user roles here
        // For now, skip restricted models
        return false;
      }
      
      // Filter based on priority
      if (request.priority === 'speed' && (model.averageLatencyMs || 0) > 2000) {
        return false;
      }
      
      if (request.priority === 'quality') {
        // Prefer models with advanced capabilities
        if (!hasAnyCapability(model.capabilities, ['reasoning', 'thinking', 'artifacts'])) {
          return false;
        }
      }
      
      return true;
    });
  }
  
  private rankModels(models: TransformedModel[], request: CostOptimizationRequest): TransformedModel[] {
    return models.sort((a, b) => {
      switch (request.priority) {
        case 'cost':
          return this.calculateCostForModel(a, request.estimatedTokens) - 
                 this.calculateCostForModel(b, request.estimatedTokens);
                 
        case 'speed':
          return (a.averageLatencyMs || 1000) - (b.averageLatencyMs || 1000);
          
        case 'quality': {
          const aScore = this.calculateQualityScore(a);
          const bScore = this.calculateQualityScore(b);
          return bScore - aScore;
        }

        default: {
          // Balanced scoring
          const aCost = this.calculateCostForModel(a, request.estimatedTokens);
          const bCost = this.calculateCostForModel(b, request.estimatedTokens);
          const aSpeed = a.averageLatencyMs || 1000;
          const bSpeed = b.averageLatencyMs || 1000;
          const aQuality = this.calculateQualityScore(a);
          const bQuality = this.calculateQualityScore(b);

          // Normalize and weight: 40% cost, 30% speed, 30% quality
          const aTotal = (aCost / 0.01) * 0.4 + (aSpeed / 1000) * 0.3 + (100 - aQuality) * 0.3;
          const bTotal = (bCost / 0.01) * 0.4 + (bSpeed / 1000) * 0.3 + (100 - bQuality) * 0.3;

          return aTotal - bTotal;
        }
      }
    });
  }
  
  private calculateQualityScore(model: TransformedModel): number {
    let score = 50; // Base score

    if (hasCapability(model.capabilities, 'reasoning')) score += 20;
    if (hasCapability(model.capabilities, 'thinking')) score += 15;
    if (hasCapability(model.capabilities, 'artifacts')) score += 10;
    if (hasCapability(model.capabilities, 'webSearch')) score += 5;
    if (hasCapability(model.capabilities, 'codeInterpreter')) score += 5;
    if (hasCapability(model.capabilities, 'codeExecution')) score += 5;

    // Bonus for larger context windows
    if ((model.maxTokens || 0) > 100000) score += 10;
    if ((model.maxTokens || 0) > 500000) score += 10;

    return Math.min(100, score);
  }
  
  private describeTradeoffs(model: TransformedModel, recommended: TransformedModel): string {
    const tradeoffs: string[] = [];
    
    const modelCost = model.inputCostPer1kTokens || 0;
    const recommendedCost = recommended.inputCostPer1kTokens || 0;
    
    if (modelCost > recommendedCost) {
      tradeoffs.push(`${((modelCost / recommendedCost - 1) * 100).toFixed(0)}% more expensive`);
    } else if (modelCost < recommendedCost) {
      tradeoffs.push(`${((1 - modelCost / recommendedCost) * 100).toFixed(0)}% cheaper`);
    }
    
    const modelLatency = model.averageLatencyMs || 1000;
    const recommendedLatency = recommended.averageLatencyMs || 1000;
    
    if (modelLatency > recommendedLatency) {
      tradeoffs.push(`${((modelLatency / recommendedLatency - 1) * 100).toFixed(0)}% slower`);
    } else if (modelLatency < recommendedLatency) {
      tradeoffs.push(`${((1 - modelLatency / recommendedLatency) * 100).toFixed(0)}% faster`);
    }
    
    return tradeoffs.join(', ') || 'Similar performance';
  }
  
  private generateReasoning(model: TransformedModel, request: CostOptimizationRequest): string {
    const reasons: string[] = [];
    
    switch (request.priority) {
      case 'cost':
        reasons.push(`Most cost-effective option at $${(model.inputCostPer1kTokens || 0).toFixed(4)}/1K tokens`);
        break;
      case 'speed':
        reasons.push(`Fast response time of ${model.averageLatencyMs || 1000}ms`);
        break;
      case 'quality': {
        const features: string[] = [];
        if (hasCapability(model.capabilities, 'reasoning')) features.push('advanced reasoning');
        if (hasCapability(model.capabilities, 'thinking')) features.push('thinking display');
        if (hasCapability(model.capabilities, 'artifacts')) features.push('artifact creation');
        if (features.length > 0) {
          reasons.push(`High quality with ${features.join(', ')}`);
        }
        break;
      }
    }
    
    if (request.budget) {
      reasons.push(`Fits within budget of $${request.budget.toFixed(2)}`);
    }
    
    if ((model.maxTokens || 0) > 100000) {
      reasons.push(`Large context window (${((model.maxTokens || 0) / 1000).toFixed(0)}K tokens)`);
    }
    
    return reasons.join('. ') || 'Optimal for your requirements';
  }
  
  private async calculateSavingsOpportunity(
    topModels: Array<{ provider: string; modelId: string; cost: number; usage: number }>
  ): Promise<number> {
    let potentialSavings = 0;
    
    for (const model of topModels) {
      // Find cheaper alternatives
      const models = await this.getModelsWithPricing();
      const cheaper = models.filter(m => {
        const mCost = this.calculateCostForModel(m, model.usage);
        const currentCost = model.cost;
        return mCost < currentCost * 0.8; // At least 20% cheaper
      });
      
      if (cheaper.length > 0) {
        const cheapest = cheaper[0];
        const cheapestCost = this.calculateCostForModel(cheapest, model.usage);
        potentialSavings += model.cost - cheapestCost;
      }
    }
    
    return potentialSavings;
  }
}