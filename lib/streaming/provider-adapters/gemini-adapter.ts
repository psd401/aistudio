import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ToolSet } from 'ai';
import { createLogger } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';
import { BaseProviderAdapter } from './base-adapter';
import type { StreamingCallbacks } from '../types';
import type { ProviderCapabilities, StreamRequest } from '../types';

const log = createLogger({ module: 'gemini-adapter' });

/**
 * Google Gemini provider adapter with support for:
 * - Gemini 2.5 with extended reasoning capabilities
 * - Gemini 1.5 Pro/Flash models
 * - Extended context windows and multimodal capabilities
 */
export class GeminiAdapter extends BaseProviderAdapter {
  protected providerName = 'google';
  private googleClient?: ReturnType<typeof createGoogleGenerativeAI>;

  async createModel(modelId: string) {
    try {
      const apiKey = await Settings.getGoogleAI();
      if (!apiKey) {
        log.error('Google API key not configured');
        throw ErrorFactories.sysConfigurationError('Google API key not configured');
      }

      log.debug(`Creating Gemini model: ${modelId}`, { modelId });

      // Create and store client instance with API key
      this.googleClient = createGoogleGenerativeAI({ apiKey });
      this.providerClient = this.googleClient;

      // Return model from configured client
      return this.googleClient(modelId);
      
    } catch (error) {
      log.error('Failed to create Gemini model', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Create provider-native tools from stored Google client instance
   * Includes universal tools from base class
   */
  async createTools(enabledTools: string[]): Promise<ToolSet> {
    // Get universal tools from base class (show_chart, etc.)
    const universalTools = await super.createTools(enabledTools);

    // If Google client not initialized, return just universal tools
    if (!this.googleClient) {
      log.warn('Google client not initialized, returning only universal tools');
      return universalTools;
    }

    const providerTools: Record<string, unknown> = {};

    try {
      // Map friendly tool names to Google SDK tool methods
      const toolCreators: Record<string, () => unknown> = {
        'webSearch': () => this.googleClient!.tools.googleSearch({}),
        'google_search': () => this.googleClient!.tools.googleSearch({}),
        // Note: Code execution is built into Gemini models, not a separate tool
        // Future Gemini-specific tools can be added here
      };

      for (const toolName of enabledTools) {
        const creator = toolCreators[toolName];
        if (creator) {
          const toolKey = toolName === 'webSearch' ? 'google_search' : toolName;
          providerTools[toolKey] = creator();
          log.debug(`Added Google tool: ${toolKey}`);
        } else if (toolName === 'codeInterpreter' || toolName === 'code_interpreter') {
          log.debug('Code execution enabled - built into Gemini models');
        }
      }

    } catch (error) {
      log.error('Failed to create Google tools', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Merge universal tools with provider-specific tools
    const allTools = { ...universalTools, ...providerTools };
    log.info('Created tools for Gemini', {
      universalToolCount: Object.keys(universalTools).length,
      providerToolCount: Object.keys(providerTools).length,
      totalToolCount: Object.keys(allTools).length,
      toolNames: Object.keys(allTools)
    });

    return allTools as ToolSet;
  }

  /**
   * Get list of tools supported by Gemini models
   */
   
  getSupportedTools(_modelId: string): string[] {
    // All Gemini models support search
    // Code execution is built-in, not a tool
    return ['webSearch'];
  }

  getCapabilities(modelId: string): ProviderCapabilities {
    // Gemini 2.5 models with enhanced reasoning
    if (this.matchesPattern(modelId, ['gemini-2.5*', 'models/gemini-2.5*'])) {
      return {
        supportsReasoning: true,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: ['code_execution'],
        typicalLatencyMs: 2500,
        maxTimeoutMs: 90000, // 1.5 minutes for reasoning models
        costPerInputToken: 0.000002, // Estimated
        costPerOutputToken: 0.000008
      };
    }
    
    // Gemini 1.5 Pro
    if (this.matchesPattern(modelId, ['gemini-1.5-pro*', 'models/gemini-1.5-pro*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: ['code_execution'],
        typicalLatencyMs: 2000,
        maxTimeoutMs: 60000, // 1 minute
        costPerInputToken: 0.00000125,
        costPerOutputToken: 0.000005
      };
    }
    
    // Gemini 1.5 Flash
    if (this.matchesPattern(modelId, ['gemini-1.5-flash*', 'models/gemini-1.5-flash*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: ['code_execution'],
        typicalLatencyMs: 1000, // Faster than Pro
        maxTimeoutMs: 30000, // 30 seconds
        costPerInputToken: 0.000000075,
        costPerOutputToken: 0.0000003
      };
    }
    
    // Gemini 1.0 Pro
    if (this.matchesPattern(modelId, ['gemini-pro*', 'gemini-1.0-pro*', 'models/gemini-pro*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 2500,
        maxTimeoutMs: 60000, // 1 minute
        costPerInputToken: 0.0000005,
        costPerOutputToken: 0.0000015
      };
    }
    
    // Default for unknown Gemini models
    return this.getDefaultCapabilities();
  }
  
  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown> {
    const baseOptions = super.getProviderOptions(modelId, options);
    
    // Add Gemini-specific options
    const geminiOptions: Record<string, unknown> = {
      ...baseOptions
    };
    
    // Configure for enhanced reasoning models
    if (this.supportsEnhancedReasoning(modelId)) {
      geminiOptions.google = {
        // Reasoning configuration for Gemini 2.5
        enhancedReasoning: true,
        reasoningDepth: options?.reasoningEffort === 'high' ? 'deep' : 
                        options?.reasoningEffort === 'low' ? 'shallow' : 'medium',
        
        // Code execution capabilities
        enableCodeExecution: options?.enableCodeInterpreter || false
      };
    }
    
    return geminiOptions;
  }
  
  supportsModel(modelId: string): boolean {
    const supportedPatterns = [
      'gemini-*',
      'models/gemini-*',
      'gemini-pro*',
      'gemini-1.0*',
      'gemini-1.5*',
      'gemini-2.0*',
      'gemini-2.5*'
    ];
    
    return this.matchesPattern(modelId, supportedPatterns);
  }
  
  /**
   * Check if model supports enhanced reasoning
   */
  private supportsEnhancedReasoning(modelId: string): boolean {
    return this.matchesPattern(modelId, ['gemini-2.5*', 'models/gemini-2.5*']);
  }
  
  protected async handleFinish(
    data: {
      text: string;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
        totalCost?: number;
      };
      finishReason: string;
      reasoning?: string;
      codeExecutionResults?: unknown;
    },
    callbacks: StreamingCallbacks
  ): Promise<void> {
    await super.handleFinish(data, callbacks);
    
    // Handle Gemini-specific reasoning content
    if (data.reasoning && callbacks.onReasoning) {
      callbacks.onReasoning(data.reasoning);
    }
    
    // Handle code execution results
    if (data.codeExecutionResults && callbacks.onProgress) {
      callbacks.onProgress({
        event: {
          type: 'tool-output-available',
          toolCallId: `gemini-code-exec-${Date.now()}`,
          output: data.codeExecutionResults
        },
        timestamp: Date.now(),
        // Legacy fields for backward compatibility
        type: 'tool_result',
        content: JSON.stringify(data.codeExecutionResults),
        metadata: { tool: 'code_execution' }
      });
    }
  }
  
  protected handleError(error: Error, callbacks: StreamingCallbacks): void {
    super.handleError(error, callbacks);
    
    // Handle Gemini-specific errors
    if (error.message.includes('SAFETY')) {
      log.warn('Gemini safety filter triggered', {
        error: error.message
      });
    }
    
    if (error.message.includes('QUOTA_EXCEEDED')) {
      log.warn('Gemini quota exceeded', {
        error: error.message
      });
    }
    
    if (error.message.includes('RECITATION')) {
      log.warn('Gemini recitation filter triggered', {
        error: error.message
      });
    }
  }
}