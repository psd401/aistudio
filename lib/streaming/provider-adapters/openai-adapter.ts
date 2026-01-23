import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage, type ToolSet } from 'ai';
import { createLogger } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';
import { BaseProviderAdapter } from './base-adapter';
import { createUniversalTools } from '@/lib/tools/provider-native-tools';
import type { StreamingCallbacks, StreamConfig, ProviderCapabilities, StreamRequest } from '../types';

const log = createLogger({ module: 'openai-adapter' });

/**
 * OpenAI provider adapter with support for:
 * - GPT-5, GPT-4, GPT-3.5, o3, o4 models
 * - OpenAI Responses API for reasoning models
 * - Background mode for long-running reasoning
 * - Enhanced reasoning support and token persistence
 */
export class OpenAIAdapter extends BaseProviderAdapter {
  protected providerName = 'openai';
  private openaiClient?: ReturnType<typeof createOpenAI>;

  async createModel(modelId: string, options?: StreamRequest['options']) {
    try {
      const apiKey = await Settings.getOpenAI();
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        log.error('OpenAI API key not configured or invalid');
        throw ErrorFactories.sysConfigurationError('OpenAI API key not configured');
      }

      // Create and store client instance
      this.openaiClient = createOpenAI({ apiKey });
      this.providerClient = this.openaiClient;

      // Always use Responses API for all OpenAI models
      log.info('Using OpenAI Responses API', {
        modelId,
        reasoningEffort: options?.reasoningEffort || 'medium',
        backgroundMode: options?.backgroundMode || false
      });

      return this.openaiClient.responses(modelId);
      
    } catch (error) {
      log.error('Failed to create OpenAI model', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Create provider-native tools from stored OpenAI client instance
   * Includes universal tools (like show_chart) that work with all providers
   */
  async createTools(enabledTools: string[]): Promise<ToolSet> {
    // Start with universal tools (show_chart, etc.) that work with all providers
    const universalTools = await createUniversalTools(enabledTools);

    // If OpenAI client not initialized, return just universal tools
    if (!this.openaiClient) {
      log.warn('OpenAI client not initialized, returning only universal tools');
      return universalTools;
    }

    const providerTools: Record<string, unknown> = {};

    try {
      // Map friendly tool names to OpenAI SDK tool methods
      const toolCreators: Record<string, () => unknown> = {
        'webSearch': () => this.openaiClient!.tools.webSearchPreview({
          searchContextSize: 'high'
        }),
        'web_search_preview': () => this.openaiClient!.tools.webSearchPreview({
          searchContextSize: 'high'
        }),
        'codeInterpreter': () => this.openaiClient!.tools.codeInterpreter({}),
        'code_interpreter': () => this.openaiClient!.tools.codeInterpreter({}),
        // Future tools for GPT-5+
        // 'fileSearch': () => this.openaiClient!.tools.fileSearch(),
        // 'imageGeneration': () => this.openaiClient!.tools.imageGeneration(),
        // 'mcp': () => this.openaiClient!.tools.mcp(),
      };

      for (const toolName of enabledTools) {
        const creator = toolCreators[toolName];
        if (creator) {
          // Use provider-specific name for tool key
          const toolKey = toolName === 'webSearch' ? 'web_search_preview' :
                         toolName === 'codeInterpreter' ? 'code_interpreter' :
                         toolName;
          providerTools[toolKey] = creator();
          log.debug(`Added OpenAI tool: ${toolKey}`);
        }
      }

    } catch (error) {
      log.error('Failed to create OpenAI tools', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Merge universal tools with provider-specific tools
    const allTools = { ...universalTools, ...providerTools };
    log.info('Created tools for OpenAI', {
      universalToolCount: Object.keys(universalTools).length,
      providerToolCount: Object.keys(providerTools).length,
      totalToolCount: Object.keys(allTools).length,
      toolNames: Object.keys(allTools)
    });

    return allTools as ToolSet;
  }

  /**
   * Get list of tools supported by a specific OpenAI model
   */
  getSupportedTools(modelId: string): string[] {
    // GPT-5 models support more tools
    if (this.matchesPattern(modelId, ['gpt-5*', 'gpt-5-*'])) {
      return ['webSearch', 'codeInterpreter', 'fileSearch', 'imageGeneration', 'mcp'];
    }

    // o3/o4 reasoning models
    if (this.matchesPattern(modelId, ['o3*', 'o4*'])) {
      return ['webSearch', 'codeInterpreter'];
    }

    // GPT-4 models
    if (this.matchesPattern(modelId, ['gpt-4*'])) {
      return ['codeInterpreter'];
    }

    // Default for unknown models
    return ['codeInterpreter'];
  }

  getCapabilities(modelId: string): ProviderCapabilities {
    // GPT-5 models
    if (this.matchesPattern(modelId, ['gpt-5*', 'gpt-5-*'])) {
      return {
        supportsReasoning: true,
        supportsThinking: false,
        supportedResponseModes: ['standard', 'flex', 'priority'],
        supportsBackgroundMode: true,
        supportedTools: ['web_search', 'code_interpreter', 'image_generation'],
        typicalLatencyMs: 3000,
        maxTimeoutMs: 300000, // 5 minutes
        costPerInputToken: 0.00001, // Estimated
        costPerOutputToken: 0.00003,
        costPerReasoningToken: 0.00002
      };
    }
    
    // o3/o4 reasoning models
    if (this.matchesPattern(modelId, ['o3*', 'o4*'])) {
      return {
        supportsReasoning: true,
        supportsThinking: false,
        supportedResponseModes: ['standard', 'flex', 'priority'],
        supportsBackgroundMode: true,
        supportedTools: ['web_search', 'code_interpreter'],
        typicalLatencyMs: 10000, // Much slower for reasoning
        maxTimeoutMs: 600000, // 10 minutes for complex reasoning
        costPerInputToken: 0.00015, // Higher cost for reasoning models
        costPerOutputToken: 0.0006,
        costPerReasoningToken: 0.0003
      };
    }
    
    // GPT-4 models
    if (this.matchesPattern(modelId, ['gpt-4*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: ['code_interpreter'],
        typicalLatencyMs: 2000,
        maxTimeoutMs: 60000, // 1 minute
        costPerInputToken: 0.00003,
        costPerOutputToken: 0.00006
      };
    }
    
    // GPT-3.5 models
    if (this.matchesPattern(modelId, ['gpt-3.5*', 'gpt-35*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 1000,
        maxTimeoutMs: 30000, // 30 seconds
        costPerInputToken: 0.0000005,
        costPerOutputToken: 0.0000015
      };
    }
    
    // Default for unknown OpenAI models
    return {
      ...this.getDefaultCapabilities(),
      supportedTools: ['code_interpreter']
    };
  }
  
  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown> {
    const baseOptions = super.getProviderOptions(modelId, options);
    
    // Always configure for Responses API
    const openaiOptions: Record<string, unknown> = {
      ...baseOptions,
      openai: {
        // Reasoning configuration
        reasoningEffort: options?.reasoningEffort || 'medium',
        backgroundMode: options?.backgroundMode || false,
        includeReasoningSummaries: true,
        preserveReasoningItems: true, // For multi-turn conversations
        
        // Tool configuration
        enableWebSearch: options?.enableWebSearch || false,
        enableCodeInterpreter: options?.enableCodeInterpreter || false,
        enableImageGeneration: options?.enableImageGeneration || false
      }
    };
    
    return openaiOptions;
  }
  
  protected enhanceStreamConfig(config: StreamConfig): StreamConfig {
    const enhanced = super.enhanceStreamConfig(config);
    
    // Add provider-specific options to providerOptions
    if (config.providerOptions) {
      enhanced.providerOptions = config.providerOptions;
    }
    
    return enhanced;
  }
  
  supportsModel(modelId: string): boolean {
    const supportedPatterns = [
      'gpt-3.5*',
      'gpt-35*', 
      'gpt-4*',
      'gpt-5*',
      'o3*',
      'o4*',
      'text-davinci*',
      'text-curie*',
      'text-babbage*',
      'text-ada*'
    ];
    
    return this.matchesPattern(modelId, supportedPatterns);
  }
  
  /**
   * Override streamWithEnhancements to implement OpenAI Responses API
   */
  async streamWithEnhancements(
    config: StreamConfig,
    callbacks: StreamingCallbacks
  ): Promise<{
    toDataStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    toUIMessageStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    usage: Promise<{
      totalTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      totalCost?: number;
    }>;
  }> {
    const logger = createLogger({ 
      module: 'openai-adapter.streamWithEnhancements'
    });
    
    // All OpenAI models use Responses API
    const modelWithMetadata = config.model as typeof config.model & {
      __responsesAPI?: boolean;
      __reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
      __backgroundMode?: boolean;
    };
    const isResponsesAPI = modelWithMetadata.__responsesAPI === true;
    
    if (isResponsesAPI) {
      logger.info('Using OpenAI Responses API streaming', {
        reasoningEffort: modelWithMetadata.__reasoningEffort,
        backgroundMode: modelWithMetadata.__backgroundMode
      });
      
      // Configure for Responses API
      const enhancedConfig = {
        ...config,
        // Add Responses API specific parameters
        providerOptions: {
          ...config.providerOptions,
          openai: {
            // Reasoning configuration
            reasoning_effort: modelWithMetadata.__reasoningEffort,
            background_mode: modelWithMetadata.__backgroundMode,
            stream_reasoning_summaries: true,
            preserve_reasoning_items: true,

            // Response configuration
            response_format: {
              type: 'json_object' as const,
              schema: {
                reasoning_steps: 'array',
                thinking_content: 'string',
                final_answer: 'string'
              }
            },

            // Tool configuration for reasoning models
            parallel_tool_calls: true
          }
        }
      };
      
      // Stream with Responses API enhancements
      const result = streamText({
        model: enhancedConfig.model,
        messages: enhancedConfig.messages as ModelMessage[],
        system: enhancedConfig.system,
        tools: enhancedConfig.tools,
        toolChoice: enhancedConfig.toolChoice,
        temperature: enhancedConfig.temperature,
        onFinish: async (event) => {
          logger.info('OpenAI streamText onFinish triggered', {
            hasText: !!event.text,
            hasUsage: !!event.usage,
            finishReason: event.finishReason,
            textLength: event.text?.length || 0
          });
          
          // Define proper type for usage
          interface StreamUsage {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            reasoningTokens?: number;
          }
          
          // Transform to our expected format
          const usage = event.usage as StreamUsage;
          const transformedData = {
            text: event.text || '',
            usage: usage ? {
              promptTokens: usage.promptTokens || 0,
              completionTokens: usage.completionTokens || 0,
              totalTokens: usage.totalTokens || 0
            } : undefined,
            finishReason: event.finishReason || 'stop'
          };
          
          // Call finish callbacks
          if (callbacks.onFinish) {
            logger.info('Calling onFinish callback from OpenAI adapter', {
              hasCallback: true,
              textLength: event.text?.length || 0
            });
            await callbacks.onFinish(transformedData);
          }
        }
      });
      
      // Process reasoning content from the stream
      this.processResponsesAPIStream(result, callbacks);
      
      return {
        toDataStreamResponse: (options?: { headers?: Record<string, string> }) =>
          result.toUIMessageStreamResponse ? result.toUIMessageStreamResponse(options) : result.toTextStreamResponse(options),
        toUIMessageStreamResponse: (options?: { headers?: Record<string, string> }) =>
          result.toUIMessageStreamResponse ? result.toUIMessageStreamResponse(options) : result.toTextStreamResponse(options),
        usage: Promise.resolve(result.usage)
      };
    }

    // Fall back to base implementation for non-Responses API models
    return super.streamWithEnhancements(config, callbacks);
  }
  
  /**
   * Handle text-delta with potential reasoning markers
   */
  private handleTextDelta(
    text: string | undefined,
    callbacks: StreamingCallbacks
  ): void {
    if (!text || !text.includes('[REASONING]')) return;

    const reasoning = text.replace('[REASONING]', '').trim();
    if (reasoning && callbacks.onReasoning) {
      callbacks.onReasoning(reasoning);
    }
  }

  /**
   * Handle reasoning-delta from stream
   */
  private handleReasoningDelta(
    text: string | undefined,
    callbacks: StreamingCallbacks
  ): void {
    if (text && callbacks.onReasoning) {
      callbacks.onReasoning(text);
    }
  }

  /**
   * Process a single stream part
   */
  private processStreamPart(
    typedPart: { type?: string; text?: string; toolName?: string; toolCallId?: string; totalUsage?: { reasoningTokens?: number; totalTokens?: number } },
    callbacks: StreamingCallbacks,
    logger: ReturnType<typeof createLogger>
  ): void {
    switch (typedPart.type) {
      case 'text-delta':
        this.handleTextDelta(typedPart.text, callbacks);
        break;
      case 'reasoning-delta':
        this.handleReasoningDelta(typedPart.text, callbacks);
        break;
      case 'tool-call':
        logger.debug('Tool call in reasoning model', { toolName: typedPart.toolName, toolCallId: typedPart.toolCallId });
        break;
      case 'finish':
        if (typedPart.totalUsage?.reasoningTokens) {
          logger.info('Reasoning tokens used', { reasoningTokens: typedPart.totalUsage.reasoningTokens, totalTokens: typedPart.totalUsage.totalTokens });
        }
        break;
    }
  }

  /**
   * Process Responses API stream to extract reasoning content
   */
  private async processResponsesAPIStream(
    result: { fullStream?: AsyncIterable<unknown> },
    callbacks: StreamingCallbacks
  ): Promise<void> {
    const logger = createLogger({ module: 'openai-adapter.processResponsesAPIStream' });

    try {
      if (!result.fullStream) return;

      for await (const part of result.fullStream) {
        const typedPart = part as { type?: string; text?: string; toolName?: string; toolCallId?: string; totalUsage?: { reasoningTokens?: number; totalTokens?: number } };
        this.processStreamPart(typedPart, callbacks, logger);
      }
    } catch (error) {
      logger.error('Error processing Responses API stream', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
      backgroundJobId?: string;
      backgroundJobStatus?: string;
      model?: string;
    },
    callbacks: StreamingCallbacks
  ): Promise<void> {
    await super.handleFinish(data, callbacks);
    
    // Handle OpenAI-specific reasoning content
    if (data.reasoning && callbacks.onReasoning) {
      callbacks.onReasoning(data.reasoning);
    }
    
    // Handle background job completion
    if (data.backgroundJobId && data.backgroundJobStatus === 'completed') {
      log.info('Background reasoning job completed', {
        jobId: data.backgroundJobId,
        model: data.model
      });
    }
  }
}