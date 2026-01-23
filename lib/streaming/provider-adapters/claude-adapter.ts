import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { ToolSet } from 'ai';
import { createLogger } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { BaseProviderAdapter } from './base-adapter';
import type { StreamingCallbacks } from '../types';
import type { ProviderCapabilities, StreamRequest, StreamConfig } from '../types';

const log = createLogger({ module: 'claude-adapter' });

/**
 * Claude provider adapter (via Amazon Bedrock) with support for:
 * - Claude 4 Opus/Sonnet with thinking capabilities
 * - Extended thinking budgets (1024-6553 tokens)
 * - Enhanced reasoning and chain-of-thought
 */
export class ClaudeAdapter extends BaseProviderAdapter {
  protected providerName = 'amazon-bedrock';
  private bedrockClient?: ReturnType<typeof createAmazonBedrock>;

  async createModel(modelId: string, options?: StreamRequest['options']) {
    try {
      const config = await Settings.getBedrock();
      const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
      
      log.debug(`Creating Claude model: ${modelId}`, {
        modelId,
        hasAccessKey: !!config.accessKeyId,
        hasSecretKey: !!config.secretAccessKey,
        region: config.region || 'us-east-1',
        isLambda,
        thinkingBudget: options?.thinkingBudget
      });
      
      const bedrockOptions: Parameters<typeof createAmazonBedrock>[0] = {
        region: config.region || 'us-east-1'
      };
      
      // Use explicit credentials for local development only
      if (!isLambda && config.accessKeyId && config.secretAccessKey) {
        log.debug('Using explicit credentials for local development');
        bedrockOptions.accessKeyId = config.accessKeyId;
        bedrockOptions.secretAccessKey = config.secretAccessKey;
      }

      // Create and store client instance
      this.bedrockClient = createAmazonBedrock(bedrockOptions);
      this.providerClient = this.bedrockClient;

      return this.bedrockClient(modelId);
      
    } catch (error) {
      log.error('Failed to create Claude model', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Create provider-native tools for Claude via Bedrock
   * Includes universal tools from base class
   */
  async createTools(enabledTools: string[]): Promise<ToolSet> {
    // Get universal tools from base class (show_chart, etc.)
    const universalTools = await super.createTools(enabledTools);

    // TODO: Add Bedrock-specific tools when needed
    // For now, return just universal tools
    log.info('Created tools for Claude/Bedrock', {
      enabledTools,
      toolCount: Object.keys(universalTools).length,
      toolNames: Object.keys(universalTools)
    });

    return universalTools;
  }

  /**
   * Get list of tools supported by Claude models on Bedrock
   */
   
  getSupportedTools(_modelId: string): string[] {
    // Claude models on Bedrock will support tools in future
    // For now, return empty
    return [];
  }

  getCapabilities(modelId: string): ProviderCapabilities {
    // Claude 4 models with thinking capabilities
    if (this.matchesPattern(modelId, ['claude-4*', 'anthropic.claude-4*'])) {
      return {
        supportsReasoning: true,
        supportsThinking: true,
        maxThinkingTokens: 6553, // Maximum thinking budget for Claude 4
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false, // Claude doesn't support background mode yet
        supportedTools: [],
        typicalLatencyMs: 3000,
        maxTimeoutMs: 120000, // 2 minutes for thinking models
        costPerInputToken: 0.000015,
        costPerOutputToken: 0.000075
      };
    }
    
    // Claude 3.5 Sonnet
    if (this.matchesPattern(modelId, ['claude-3-5*', 'anthropic.claude-3-5*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 2000,
        maxTimeoutMs: 60000, // 1 minute
        costPerInputToken: 0.000003,
        costPerOutputToken: 0.000015
      };
    }
    
    // Claude 3 models (Opus, Sonnet, Haiku)
    if (this.matchesPattern(modelId, ['claude-3*', 'anthropic.claude-3*'])) {
      const isOpus = this.matchesPattern(modelId, ['*opus*']);
      const isHaiku = this.matchesPattern(modelId, ['*haiku*']);
      
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: isHaiku ? 1000 : isOpus ? 3000 : 2000,
        maxTimeoutMs: 60000, // 1 minute
        costPerInputToken: isOpus ? 0.000015 : isHaiku ? 0.00000025 : 0.000003,
        costPerOutputToken: isOpus ? 0.000075 : isHaiku ? 0.00000125 : 0.000015
      };
    }
    
    // Claude 2 models
    if (this.matchesPattern(modelId, ['claude-2*', 'anthropic.claude-2*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 2500,
        maxTimeoutMs: 60000, // 1 minute
        costPerInputToken: 0.000008,
        costPerOutputToken: 0.000024
      };
    }
    
    // Default for unknown Claude models
    return this.getDefaultCapabilities();
  }
  
  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown> {
    const baseOptions = super.getProviderOptions(modelId, options);
    
    // Add Claude-specific options
    const claudeOptions: Record<string, unknown> = {
      ...baseOptions
    };
    
    // Configure thinking budget for Claude 4 models
    if (this.supportsThinking(modelId)) {
      claudeOptions.anthropic = {
        // Thinking configuration
        thinkingBudget: this.getThinkingBudget(options?.thinkingBudget),
        enableThinking: true,
        streamThinking: true // Stream thinking content for transparency
      };
    }
    
    return claudeOptions;
  }
  
  protected enhanceStreamConfig(config: StreamConfig): StreamConfig {
    const enhanced = super.enhanceStreamConfig(config);
    
    // Add Claude-specific enhancements
    if (config.providerOptions?.anthropic) {
      enhanced.providerOptions = config.providerOptions;
    }
    
    return enhanced;
  }
  
  supportsModel(modelId: string): boolean {
    const supportedPatterns = [
      'claude-*',
      'anthropic.claude-*'
    ];
    
    return this.matchesPattern(modelId, supportedPatterns);
  }
  
  /**
   * Check if model supports thinking capabilities
   */
  private supportsThinking(modelId: string): boolean {
    return this.matchesPattern(modelId, ['claude-4*', 'anthropic.claude-4*']);
  }
  
  /**
   * Get appropriate thinking budget based on user preference and model limits
   */
  private getThinkingBudget(requestedBudget?: number): number {
    // Default to medium thinking budget
    const defaultBudget = 3000;
    
    if (!requestedBudget) {
      return defaultBudget;
    }
    
    // Clamp to Claude 4 limits (1024-6553 tokens)
    return Math.max(1024, Math.min(6553, requestedBudget));
  }
  
  protected async handleFinish(
    data: {
      text: string;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
        thinkingTokens?: number;
        totalCost?: number;
      };
      finishReason: string;
      thinking?: string;
      model?: string;
    },
    callbacks: StreamingCallbacks
  ): Promise<void> {
    await super.handleFinish(data, callbacks);
    
    // Handle Claude-specific thinking content
    if (data.thinking && callbacks.onThinking) {
      callbacks.onThinking(data.thinking);
    }
    
    // Log thinking token usage for cost tracking
    if (data.usage?.thinkingTokens) {
      log.debug('Claude thinking tokens used', {
        thinkingTokens: data.usage.thinkingTokens,
        totalTokens: data.usage.totalTokens,
        model: data.model
      });
    }
  }
  
  protected handleError(error: Error, callbacks: StreamingCallbacks): void {
    super.handleError(error, callbacks);
    
    // Handle Claude-specific errors
    if (error.message.includes('thinking_budget_exceeded')) {
      log.warn('Claude thinking budget exceeded', {
        error: error.message
      });
    }
    
    if (error.message.includes('content_policy_violation')) {
      log.warn('Claude content policy violation', {
        error: error.message
      });
    }
  }
}