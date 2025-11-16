import { createLogger, generateRequestId } from '@/lib/logger';
import { executeSQL, type DatabaseRow, type ParameterValue } from './db-helpers';
import { createHash } from 'node:crypto';

const log = createLogger({ module: 'response-cache-service' });

// Database interfaces for cache queries
interface NexusCacheRow extends DatabaseRow {
  cache_key: string;
  provider: string;
  conversation_id: string | null;
  s3_url: string;
  token_savings: number | null;
  cost_savings_usd: number | null;
  hit_count: number;
  expires_at: string;
}

interface CacheStatsRow extends DatabaseRow {
  total_entries: number;
  total_hits: number;
  tokens_saved: number | null;
  cost_saved: number | null;
  cache_size: number | null;
}

interface ProviderStatsRow extends DatabaseRow {
  provider: string;
  entries: number;
  savings: number;
}

export interface CacheCheckRequest {
  provider: string;
  modelId: string;
  messages: Array<{ role: string; content: string | Record<string, unknown> }>;
  conversationId?: string;
  userId: string;
}

export interface CacheResult {
  hit: boolean;
  key?: string;
  response?: { text: string; usage?: { totalTokens: number } };
  tokensSaved?: number;
  costSaved?: number;
  provider?: string;
  capabilities?: Record<string, unknown>;
}

export interface CacheStoreRequest {
  provider: string;
  modelId: string;
  messages: Array<{ role: string; content: string | Record<string, unknown> }>;
  response: { text: string; usage?: { totalTokens: number } };
  conversationId?: string;
  userId: string;
  cost: number;
}

/**
 * Advanced response caching service with provider-specific optimizations
 */
export class ResponseCacheService {
  private readonly CACHE_TTL_SECONDS: Record<string, number> = {
    'openai': 300,      // 5 minutes for OpenAI (Responses API)
    'anthropic': 300,    // 5 minutes for Claude (prompt caching)
    'google': 3600,     // 1 hour for Gemini (context caching) 
    'azure': 300,       // 5 minutes for Azure
    'default': 300      // Default 5 minutes
  };
  
  private readonly MIN_TOKENS_FOR_CACHE = 50;
  private readonly MAX_CACHE_SIZE_MB = 100;
  
  /**
   * Check if a cached response exists for the request
   */
  async checkCache(request: CacheCheckRequest): Promise<CacheResult> {
    const requestId = generateRequestId();
    
    log.debug('Checking response cache', {
      requestId,
      provider: request.provider,
      modelId: request.modelId,
      conversationId: request.conversationId,
      messageCount: request.messages.length
    });
    
    try {
      // Generate cache key
      const cacheKey = this.generateCacheKey(request);
      
      // Check database cache
      const cacheResult = await this.checkDatabaseCache(cacheKey, request.provider);
      
      if (cacheResult.hit) {
        log.info('Cache hit found', {
          requestId,
          cacheKey,
          provider: request.provider,
          tokensSaved: cacheResult.tokensSaved
        });
        
        // Update hit count
        await this.updateCacheHitCount(cacheKey);
        
        return cacheResult;
      }
      
      // Check provider-specific caches
      const providerCacheResult = await this.checkProviderSpecificCache(request);
      
      if (providerCacheResult.hit) {
        log.info('Provider cache hit found', {
          requestId,
          provider: request.provider,
          cacheType: this.getProviderCacheType(request.provider)
        });
        
        return providerCacheResult;
      }
      
      log.debug('No cache hit found', {
        requestId,
        cacheKey,
        provider: request.provider
      });
      
      return { hit: false };
      
    } catch (error) {
      log.error('Cache check failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        provider: request.provider
      });
      
      // Return cache miss on error
      return { hit: false };
    }
  }
  
  /**
   * Cache a response for future use
   */
  async cacheResponse(request: CacheStoreRequest): Promise<void> {
    const requestId = generateRequestId();
    
    log.debug('Caching response', {
      requestId,
      provider: request.provider,
      modelId: request.modelId,
      conversationId: request.conversationId,
      responseTokens: request.response.usage?.totalTokens
    });
    
    try {
      // Don't cache responses that are too small
      const responseTokens = request.response.usage?.totalTokens || 0;
      if (responseTokens < this.MIN_TOKENS_FOR_CACHE) {
        log.debug('Response too small to cache', {
          requestId,
          tokens: responseTokens,
          minTokens: this.MIN_TOKENS_FOR_CACHE
        });
        return;
      }
      
      // Generate cache key
      const cacheKey = this.generateCacheKey({
        provider: request.provider,
        modelId: request.modelId,
        messages: request.messages,
        conversationId: request.conversationId,
        userId: request.userId
      });
      
      // Calculate TTL
      const ttl = this.CACHE_TTL_SECONDS[request.provider] || this.CACHE_TTL_SECONDS.default;
      const expiresAt = new Date(Date.now() + (ttl * 1000));
      
      // Estimate cache size
      const responseSize = this.estimateResponseSize(request.response);
      
      if (responseSize > this.MAX_CACHE_SIZE_MB * 1024 * 1024) {
        log.warn('Response too large to cache', {
          requestId,
          sizeMB: responseSize / (1024 * 1024),
          maxSizeMB: this.MAX_CACHE_SIZE_MB
        });
        return;
      }
      
      // Store in database cache
      await this.storeDatabaseCache(cacheKey, request, expiresAt, responseSize);
      
      // Store in provider-specific cache if supported
      await this.storeProviderSpecificCache(request, cacheKey, ttl);
      
      log.info('Response cached successfully', {
        requestId,
        cacheKey,
        provider: request.provider,
        sizeMB: responseSize / (1024 * 1024),
        ttl
      });
      
    } catch (error) {
      log.error('Failed to cache response', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        provider: request.provider
      });
    }
  }
  
  /**
   * Invalidate cache entries
   */
  async invalidateCache(options: {
    conversationId?: string;
    userId?: string;
    provider?: string;
    cacheKey?: string;
  }): Promise<number> {
    try {
      let whereClause = 'WHERE 1=1';
      const params: ParameterValue[] = [];
      let paramIndex = 1;
      
      if (options.cacheKey) {
        whereClause += ` AND cache_key = $${paramIndex}`;
        params.push(options.cacheKey);
        paramIndex++;
      }
      
      if (options.provider) {
        whereClause += ` AND provider = $${paramIndex}`;
        params.push(options.provider);
        paramIndex++;
      }
      
      if (options.conversationId) {
        whereClause += ` AND conversation_id = $${paramIndex}`;
        params.push(options.conversationId);
        paramIndex++;
      }
      
      // Delete expired entries and matching entries
      const result = await executeSQL(`
        DELETE FROM nexus_response_cache 
        ${whereClause} OR expires_at < CURRENT_TIMESTAMP
      `, params);
      
      const deletedCount = result.length; // Simplified - would get actual count
      
      log.info('Cache invalidated', {
        deletedCount,
        options
      });
      
      return deletedCount;
      
    } catch (error) {
      log.error('Failed to invalidate cache', {
        error: error instanceof Error ? error.message : String(error),
        options
      });
      return 0;
    }
  }
  
  /**
   * Get cache statistics
   */
  async getCacheStats(options: {
    userId?: string;
    provider?: string;
    timeframe?: 'hour' | 'day' | 'week' | 'month';
  } = {}): Promise<{
    totalEntries: number;
    hitRate: number;
    tokensSaved: number;
    costSaved: number;
    cacheSize: number;
    topProviders: Array<{ provider: string; entries: number; savings: number }>;
  }> {
    try {
      let whereClause = 'WHERE expires_at > CURRENT_TIMESTAMP';
      const params: ParameterValue[] = [];
      let paramIndex = 1;
      
      if (options.userId) {
        // Would need to join with conversations table
        whereClause += ` AND conversation_id IN (
          SELECT id FROM nexus_conversations WHERE user_id = $${paramIndex}
        )`;
        params.push(options.userId);
        paramIndex++;
      }
      
      if (options.provider) {
        whereClause += ` AND provider = $${paramIndex}`;
        params.push(options.provider);
        paramIndex++;
      }
      
      // Get basic stats
      const statsResult = await executeSQL<CacheStatsRow>(`
        SELECT 
          COUNT(*) as total_entries,
          SUM(hit_count) as total_hits,
          SUM(token_savings) as tokens_saved,
          SUM(cost_savings_usd) as cost_saved,
          SUM(byte_size) as cache_size
        FROM nexus_response_cache
        ${whereClause}
      `, params);
      
      // Get provider breakdown
      const providersResult = await executeSQL<ProviderStatsRow>(`
        SELECT 
          provider,
          COUNT(*) as entries,
          SUM(cost_savings_usd) as savings
        FROM nexus_response_cache
        ${whereClause}
        GROUP BY provider
        ORDER BY savings DESC
        LIMIT 10
      `, params);
      
      const stats = statsResult[0] || {};
      const totalRequests = (stats.total_hits || 0) + (stats.total_entries || 0);
      const hitRate = totalRequests > 0 ? (stats.total_hits || 0) / totalRequests : 0;
      
      return {
        totalEntries: stats.total_entries || 0,
        hitRate,
        tokensSaved: stats.tokens_saved || 0,
        costSaved: stats.cost_saved || 0,
        cacheSize: stats.cache_size || 0,
        topProviders: providersResult.map((row) => ({
          provider: row.provider,
          entries: row.entries,
          savings: row.savings
        }))
      };
      
    } catch (error) {
      log.error('Failed to get cache stats', {
        error: error instanceof Error ? error.message : String(error),
        options
      });
      
      return {
        totalEntries: 0,
        hitRate: 0,
        tokensSaved: 0,
        costSaved: 0,
        cacheSize: 0,
        topProviders: []
      };
    }
  }
  
  // Private helper methods
  
  private generateCacheKey(request: CacheCheckRequest): string {
    // Create a hash of the request parameters that affect the response
    const keyData = {
      provider: request.provider,
      modelId: request.modelId,
      // Use last 3 messages to create context-aware cache key
      messages: request.messages.slice(-3).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.substring(0, 500) : 'complex'
      })),
      // Include conversation context for personalized caching
      conversationContext: request.conversationId ? 'conversation' : 'standalone'
    };
    
    const keyString = JSON.stringify(keyData);
    return createHash('sha256').update(keyString).digest('hex').substring(0, 32);
  }
  
  private async checkDatabaseCache(cacheKey: string, provider: string): Promise<CacheResult> {
    const result = await executeSQL<NexusCacheRow>(`
      SELECT 
        cache_key,
        provider,
        conversation_id,
        s3_url,
        token_savings,
        cost_savings_usd,
        hit_count,
        expires_at
      FROM nexus_response_cache
      WHERE cache_key = $1 
        AND provider = $2 
        AND expires_at > CURRENT_TIMESTAMP
      LIMIT 1
    `, [cacheKey, provider]);
    
    if (result.length === 0) {
      return { hit: false };
    }
    
    const row = result[0];
    
    // In a real implementation, would fetch response from S3
    const cachedResponse = {
      text: 'Cached response placeholder',
      usage: {
        totalTokens: row.token_savings || 0
      }
    };
    
    return {
      hit: true,
      key: row.cache_key,
      response: cachedResponse,
      tokensSaved: row.token_savings || 0,
      costSaved: row.cost_savings_usd || 0,
      provider: row.provider
    };
  }
  
  private async checkProviderSpecificCache(
    request: CacheCheckRequest
  ): Promise<CacheResult> {
    // Provider-specific cache checking logic
    switch (request.provider.toLowerCase()) {
      case 'openai':
        return await this.checkOpenAIResponsesCache();
      case 'anthropic':
      case 'amazon-bedrock':
        return await this.checkAnthropicPromptCache();
      case 'google':
        return await this.checkGeminiContextCache();
      default:
        return { hit: false };
    }
  }
  
  private async checkOpenAIResponsesCache(): Promise<CacheResult> {
    // OpenAI Responses API cache checking
    // Would implement server-side conversation state checking
    return { hit: false };
  }
  
  private async checkAnthropicPromptCache(): Promise<CacheResult> {
    // Anthropic prompt caching logic
    // Would check for system prompt reuse
    return { hit: false };
  }
  
  private async checkGeminiContextCache(): Promise<CacheResult> {
    // Gemini context caching logic
    // Would check for conversation context reuse
    return { hit: false };
  }
  
  private async storeDatabaseCache(
    cacheKey: string,
    request: CacheStoreRequest,
    expiresAt: Date,
    responseSize: number
  ): Promise<void> {
    const tokenSavings = request.response.usage?.totalTokens || 0;
    const costSavings = request.cost * 0.9; // Assume 90% cost reduction from caching
    
    await executeSQL(`
      INSERT INTO nexus_cache_entries (
        cache_key,
        provider,
        conversation_id,
        cache_type,
        s3_url,
        token_savings,
        cost_savings_usd,
        expires_at,
        byte_size
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (cache_key) DO UPDATE SET
        hit_count = nexus_response_cache.hit_count + 1,
        expires_at = $8
    `, [
      cacheKey,
      request.provider,
      request.conversationId,
      this.getProviderCacheType(request.provider),
      'placeholder-s3-url', // Would upload to S3
      tokenSavings,
      costSavings,
      expiresAt,
      responseSize
    ]);
  }
  
  private async storeProviderSpecificCache(
    request: CacheStoreRequest,
    cacheKey: string,
    ttl: number
  ): Promise<void> {
    // Provider-specific caching logic
    switch (request.provider.toLowerCase()) {
      case 'openai':
        await this.storeOpenAIResponsesCache(request, cacheKey, ttl);
        break;
      case 'anthropic':
      case 'amazon-bedrock':
        await this.storeAnthropicPromptCache(request, cacheKey, ttl);
        break;
      case 'google':
        await this.storeGeminiContextCache(request, cacheKey, ttl);
        break;
    }
  }
  
  private async storeOpenAIResponsesCache(
    request: CacheStoreRequest,
    cacheKey: string,
    ttl: number
  ): Promise<void> {
    // OpenAI Responses API caching
    log.debug('Storing OpenAI responses cache', { cacheKey, ttl });
  }
  
  private async storeAnthropicPromptCache(
    request: CacheStoreRequest,
    cacheKey: string,
    ttl: number
  ): Promise<void> {
    // Anthropic prompt caching
    log.debug('Storing Anthropic prompt cache', { cacheKey, ttl });
  }
  
  private async storeGeminiContextCache(
    request: CacheStoreRequest,
    cacheKey: string,
    ttl: number
  ): Promise<void> {
    // Gemini context caching
    log.debug('Storing Gemini context cache', { cacheKey, ttl });
  }
  
  private async updateCacheHitCount(cacheKey: string): Promise<void> {
    await executeSQL(`
      UPDATE nexus_response_cache 
      SET hit_count = hit_count + 1
      WHERE cache_key = $1
    `, [cacheKey]);
  }
  
  private getProviderCacheType(provider: string): string {
    switch (provider.toLowerCase()) {
      case 'openai':
        return 'responses_api';
      case 'anthropic':
      case 'amazon-bedrock':
        return 'prompt_cache';
      case 'google':
        return 'context_cache';
      default:
        return 'standard';
    }
  }
  
  private estimateResponseSize(response: { text: string; usage?: { totalTokens: number } }): number {
    // Simple size estimation
    return JSON.stringify(response).length * 2; // Rough estimate including overhead
  }
}