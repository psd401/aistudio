import { createLogger } from '@/lib/logger';
import { executeSQL, type DatabaseRow } from './db-helpers';
import type { NexusModelCapabilities } from './nexus-provider-factory';

const log = createLogger({ module: 'conversation-state-manager' });

// Database row interfaces for typed queries
interface NexusConversationRow extends DatabaseRow {
  conversation_id: string;
  provider: string;
  model_id: string;
  message_count: number | null;
  total_tokens: number | null;
  last_message_at: string;
  metadata: Record<string, unknown> | null;
}

interface NexusProviderMetricsRow extends DatabaseRow {
  request_count: number;
  total_tokens: number | null;
  avg_cost: number | null;
  avg_response_time: number | null;
  cached_tokens_total: number | null;
}

interface NexusConversationEventRow extends DatabaseRow {
  event_data: Record<string, unknown>;
  created_at: string;
}

interface NexusSwitchCountRow extends DatabaseRow {
  switch_count: number;
}

interface NexusProviderUsageRow extends DatabaseRow {
  provider: string;
  usage_count: number;
  avg_tokens: number;
}

interface NexusCostMetricsRow extends DatabaseRow {
  avg_cost: number | null;
  cache_savings: number | null;
}

interface NexusCapabilityEventRow extends DatabaseRow {
  capabilities: Record<string, unknown> | null;
}

export interface ConversationState {
  conversationId: string;
  provider: string;
  modelId: string;
  messageCount: number;
  totalTokens: number;
  lastMessageAt: Date;
  metadata: {
    capabilities: NexusModelCapabilities;
    costTotal: number;
    providerSwitches: number;
    cacheHitRate: number;
    avgResponseTime: number;
  };
}

export interface ConversationUpdateRequest {
  conversationId: string;
  provider: string;
  modelId: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    totalCost?: number;
  };
  capabilities: NexusModelCapabilities;
  requestId: string;
}

/**
 * Manages conversation state and provider switching history
 */
export class ConversationStateManager {
  
  /**
   * Update conversation state after a successful stream
   */
  async updateConversation(request: ConversationUpdateRequest): Promise<void> {
    const { conversationId, provider, modelId, usage, capabilities, requestId } = request;
    
    log.info('Updating conversation state', {
      requestId,
      conversationId,
      provider,
      modelId,
      tokens: usage?.totalTokens
    });
    
    try {
      // Update main conversation record
      await this.updateConversationRecord(conversationId, provider, modelId, usage);
      
      // Record provider usage metrics
      await this.recordProviderMetrics(conversationId, provider, modelId, usage, capabilities);
      
      // Update conversation metadata
      await this.updateConversationMetadata(conversationId, provider, capabilities);
      
      log.debug('Conversation state updated successfully', {
        requestId,
        conversationId,
        provider
      });
      
    } catch (error) {
      log.error('Failed to update conversation state', {
        requestId,
        conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
      // Don't throw - this is not critical for user experience
    }
  }
  
  /**
   * Get conversation history and provider usage
   */
  async getConversationState(conversationId: string): Promise<ConversationState | null> {
    try {
      const result = await executeSQL<NexusConversationRow>(`
        SELECT 
          id as conversation_id,
          provider,
          model_used as model_id,
          message_count,
          total_tokens,
          last_message_at,
          metadata
        FROM nexus_conversations 
        WHERE id = $1
      `, [conversationId]);
      
      if (result.length === 0) {
        return null;
      }
      
      const row = result[0];
      
      // Get provider metrics
      const metricsResult = await executeSQL<NexusProviderMetricsRow>(`
        SELECT 
          COUNT(*) as request_count,
          SUM(prompt_tokens + completion_tokens) as total_tokens,
          AVG(cost_usd) as avg_cost,
          AVG(response_time_ms) as avg_response_time,
          SUM(cached_tokens) as cached_tokens_total
        FROM nexus_provider_metrics 
        WHERE conversation_id = $1
      `, [conversationId]);
      
      const metrics = metricsResult[0] || {
        request_count: 0,
        total_tokens: null,
        avg_cost: null,
        avg_response_time: null,
        cached_tokens_total: null
      };
      const cacheHitRate = (metrics.cached_tokens_total || 0) > 0 && (metrics.total_tokens || 0) > 0
        ? (metrics.cached_tokens_total || 0) / (metrics.total_tokens || 1)
        : 0;
      
      return {
        conversationId: row.conversation_id,
        provider: row.provider,
        modelId: row.model_id,
        messageCount: row.message_count || 0,
        totalTokens: row.total_tokens || 0,
        lastMessageAt: new Date(row.last_message_at),
        metadata: {
          capabilities: (row.metadata?.capabilities as NexusModelCapabilities) || {
            supportsReasoning: false,
            supportsThinking: false,
            supportsToolCalls: false,
            supportsImages: false,
            supportsAudio: false,
            maxTimeoutMs: 30000
          },
          costTotal: ((metrics.avg_cost || 0) * (metrics.request_count || 0)) || 0,
          providerSwitches: await this.countProviderSwitches(conversationId),
          cacheHitRate,
          avgResponseTime: metrics.avg_response_time || 0
        }
      };
      
    } catch (error) {
      log.error('Failed to get conversation state', {
        conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
  
  /**
   * Track provider switching patterns
   */
  async trackProviderSwitch(
    conversationId: string,
    fromProvider: string,
    toProvider: string,
    reason: string,
    requestId: string
  ): Promise<void> {
    log.info('Tracking provider switch', {
      requestId,
      conversationId,
      fromProvider,
      toProvider,
      reason
    });
    
    try {
      // Record the switch event
      await executeSQL(`
        INSERT INTO nexus_conversation_events (
          conversation_id, 
          event_type, 
          event_data
        ) VALUES ($1, $2, $3)
      `, [
        conversationId,
        'provider_switch',
        JSON.stringify({
          from_provider: fromProvider,
          to_provider: toProvider,
          reason,
          request_id: requestId,
          timestamp: new Date().toISOString()
        })
      ]);
      
      // Update conversation provider if this is the new primary
      await executeSQL(`
        UPDATE nexus_conversations 
        SET 
          provider = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [toProvider, conversationId]);
      
    } catch (error) {
      log.error('Failed to track provider switch', {
        requestId,
        conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  /**
   * Get provider switching history for analysis
   */
  async getProviderSwitchHistory(conversationId: string): Promise<Array<{
    timestamp: Date;
    fromProvider: string;
    toProvider: string;
    reason: string;
  }>> {
    try {
      const result = await executeSQL<NexusConversationEventRow>(`
        SELECT event_data, created_at
        FROM nexus_conversation_events
        WHERE conversation_id = $1 
          AND event_type = 'provider_switch'
        ORDER BY created_at ASC
      `, [conversationId]);
      
      return result.map((row) => ({
        timestamp: new Date(row.created_at),
        fromProvider: (row.event_data as Record<string, string>).from_provider,
        toProvider: (row.event_data as Record<string, string>).to_provider,
        reason: (row.event_data as Record<string, string>).reason
      }));
      
    } catch (error) {
      log.error('Failed to get provider switch history', {
        conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
  
  /**
   * Analyze conversation patterns for optimization
   */
  async analyzeConversationPatterns(userId: string): Promise<{
    preferredProviders: Array<{ provider: string; usage: number }>;
    avgCostPerConversation: number;
    avgTokensPerConversation: number;
    mostUsedCapabilities: string[];
    costSavingsFromCaching: number;
  }> {
    try {
      // Get provider preferences
      const providerResult = await executeSQL<NexusProviderUsageRow>(`
        SELECT 
          provider,
          COUNT(*) as usage_count,
          AVG(total_tokens) as avg_tokens
        FROM nexus_conversations 
        WHERE user_id = $1
        GROUP BY provider
        ORDER BY usage_count DESC
      `, [userId]);
      
      // Get cost metrics
      const costResult = await executeSQL<NexusCostMetricsRow>(`
        SELECT 
          AVG(cost_usd) as avg_cost,
          SUM(cached_tokens * 0.00001) as cache_savings
        FROM nexus_provider_metrics npm
        JOIN nexus_conversations nc ON npm.conversation_id = nc.id
        WHERE nc.user_id = $1
      `, [userId]);
      
      // Get capability usage
      const capabilityResult = await executeSQL<NexusCapabilityEventRow>(`
        SELECT 
          event_data->'capabilities' as capabilities
        FROM nexus_conversation_events nce
        JOIN nexus_conversations nc ON nce.conversation_id = nc.id
        WHERE nc.user_id = $1 
          AND nce.event_type = 'capability_used'
      `, [userId]);
      
      // Process capability usage
      const capabilityCount = new Map<string, number>();
      for (const row of capabilityResult) {
        const capabilities = (row.capabilities as Record<string, boolean>) || {};
        for (const cap of Object.keys(capabilities)) {
          if (capabilities[cap]) {
            capabilityCount.set(cap, (capabilityCount.get(cap) || 0) + 1);
          }
        }
      }
      
      const mostUsedCapabilities = Array.from(capabilityCount.entries())
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([cap]) => cap);
      
      return {
        preferredProviders: providerResult.map((row) => ({
          provider: row.provider,
          usage: row.usage_count
        })),
        avgCostPerConversation: costResult[0]?.avg_cost || 0,
        avgTokensPerConversation: providerResult.reduce((sum, row) => sum + (row.avg_tokens || 0), 0) / providerResult.length || 0,
        mostUsedCapabilities,
        costSavingsFromCaching: costResult[0]?.cache_savings || 0
      };
      
    } catch (error) {
      log.error('Failed to analyze conversation patterns', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Return empty analysis on error
      return {
        preferredProviders: [],
        avgCostPerConversation: 0,
        avgTokensPerConversation: 0,
        mostUsedCapabilities: [],
        costSavingsFromCaching: 0
      };
    }
  }
  
  // Private helper methods
  
  private async updateConversationRecord(
    conversationId: string,
    provider: string,
    modelId: string,
    usage?: ConversationUpdateRequest['usage']
  ): Promise<void> {
    await executeSQL(`
      UPDATE nexus_conversations 
      SET 
        provider = $1,
        model_used = $2,
        total_tokens = COALESCE(total_tokens, 0) + $3,
        last_message_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [
      provider,
      modelId,
      usage?.totalTokens || 0,
      conversationId
    ]);
  }
  
  private async recordProviderMetrics(
    conversationId: string,
    provider: string,
    modelId: string,
    usage: ConversationUpdateRequest['usage'],
    capabilities: NexusModelCapabilities
  ): Promise<void> {
    if (!usage) return;
    
    const cost = (usage.totalTokens || 0) * (capabilities.costPerToken || 0);
    const responseTime = capabilities.averageLatency || 1000;
    
    await executeSQL(`
      INSERT INTO nexus_provider_metrics (
        conversation_id,
        provider,
        model_id,
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        response_time_ms,
        cost_usd
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      conversationId,
      provider,
      modelId,
      usage.promptTokens || 0,
      usage.completionTokens || 0,
      0, // cached tokens would be calculated separately
      responseTime,
      cost
    ]);
  }
  
  private async updateConversationMetadata(
    conversationId: string,
    provider: string,
    capabilities: NexusModelCapabilities
  ): Promise<void> {
    const metadata = {
      last_provider: provider,
      capabilities: {
        reasoning: capabilities.supportsReasoning,
        thinking: capabilities.supportsThinking,
        artifacts: capabilities.artifacts,
        webSearch: capabilities.webSearch,
        codeExecution: capabilities.codeExecution
      },
      last_updated: new Date().toISOString()
    };
    
    await executeSQL(`
      UPDATE nexus_conversations 
      SET metadata = COALESCE(metadata, '{}') || $1
      WHERE id = $2
    `, [
      JSON.stringify(metadata),
      conversationId
    ]);
  }
  
  private async countProviderSwitches(conversationId: string): Promise<number> {
    const result = await executeSQL<NexusSwitchCountRow>(`
      SELECT COUNT(*) as switch_count
      FROM nexus_conversation_events
      WHERE conversation_id = $1 
        AND event_type = 'provider_switch'
    `, [conversationId]);
    
    return result[0]?.switch_count || 0;
  }
}