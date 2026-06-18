import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { createLogger } from '@/lib/logger';
import { createUniversalTools } from '@/lib/tools/provider-native-tools';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  StreamConfig,
  StreamingCallbacks,
  StreamRequest
} from '../types';

const log = createLogger({ module: 'base-provider-adapter' });

/**
 * A cost-cap stop predicate (#926): receives the completed steps (with token
 * usage) and returns true to stop the multi-step loop. Typed locally because the
 * AI SDK `stopWhen` accepts a heterogeneous array of step-count guards and custom
 * predicates.
 */
type CostStopPredicate = (opts: {
  steps: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number } }>;
}) => boolean;

/** A single AI SDK `stopWhen` condition: a step-count guard or a cost predicate. */
type StopCondition = ReturnType<typeof stepCountIs> | CostStopPredicate;

/**
 * Standalone transient error classifier used by both the streaming adapters
 * and the dual-stream merger to ensure consistent behavior across all paths.
 *
 * Transient errors are recoverable conditions that don't indicate a systemic
 * issue: network timeouts, connection resets, temporary provider outages.
 */
export function isTransientStreamError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('no output generated') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    // OpenAI Responses API stale previous_response_id: "No item with id X was found"
    message.includes('no item with id') ||
    // Rate limits are transient — the request can succeed after backoff.
    // Use precise patterns to avoid false positives on unrelated numeric strings.
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    // Match HTTP 429 status codes ("http 429", "status 429", "error 429") but not
    // strings like "id 42991a" or port ":4299" that happen to contain "429".
    /\bhttp\s*429\b/.test(message) ||
    /\bstatus\s*429\b/.test(message) ||
    /\berror\s*429\b/.test(message)
  );
}

/** Tool call accumulated across streaming steps */
export type AccumulatedToolCall = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

/**
 * Base class for all provider adapters
 * Provides common functionality and interface implementation
 */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  protected abstract providerName: string;
  protected providerClient?: unknown; // Store provider client instance

  /**
   * Create a model instance for this provider
   * Must be implemented by each provider
   */
  abstract createModel(modelId: string, options?: StreamRequest['options']): Promise<LanguageModel>;
  
  /**
   * Get capabilities for a specific model
   * Must be implemented by each provider
   */
  abstract getCapabilities(modelId: string): ProviderCapabilities;
  
  /**
   * Get provider-specific options for streaming
   * Can be overridden by specific providers
   */
  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown> {
    const baseOptions: Record<string, unknown> = {};

    // Add common options
    if (options?.reasoningEffort) {
      baseOptions.reasoningEffort = options.reasoningEffort;
    }

    if (options?.responseMode) {
      baseOptions.responseMode = options.responseMode;
    }

    if (options?.backgroundMode) {
      baseOptions.backgroundMode = options.backgroundMode;
    }

    return baseOptions;
  }

  /**
   * Create provider-native tools from stored client instance
   * Base implementation returns universal tools (show_chart, etc.)
   * Override in subclasses to add provider-specific tools
   */
  async createTools(enabledTools: string[]): Promise<ToolSet> {
    // Base implementation returns universal tools that work with all providers
    const universalTools = await createUniversalTools(enabledTools);
    log.debug(`Created universal tools for ${this.providerName}`, {
      enabledTools,
      toolCount: Object.keys(universalTools).length,
      toolNames: Object.keys(universalTools)
    });
    return universalTools;
  }

  /**
   * Get list of tools supported by a specific model.
   * Return [] to indicate the model supports no provider-native tools (all tool requests
   * will be filtered out). Abstract to enforce a deliberate implementation in every adapter —
   * a missing override would silently drop all tools, which is hard to debug.
   */
  abstract getSupportedTools(modelId: string): string[];

  /**
   * Get stored provider client instance (for debugging/testing)
   */
  getProviderClient(): unknown {
    return this.providerClient;
  }

  /**
   * Stream with provider-specific enhancements
   * Base implementation using AI SDK streamText
   * Can be overridden for provider-specific features
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
      module: `${this.providerName}-adapter`,
      requestId: config.experimental_telemetry?.metadata?.['request.id'] as string | undefined
    });
    
    logger.debug('Starting stream with enhancements', {
      provider: this.providerName,
      hasModel: !!config.model,
      messageCount: config.messages.length,
      hasSystem: !!config.system,
      hasTelemetry: !!config.experimental_telemetry?.isEnabled,
      maxSteps: config.maxSteps || 'not set'
    });
    
    try {
      // Create enhanced configuration
      const enhancedConfig = this.enhanceStreamConfig(config);

      // Accumulate tool calls from steps (captured via onStepFinish)
      // Includes result field for persistence (required for assistant-ui to render completed tool calls)
      const accumulatedToolCalls: AccumulatedToolCall[] = [];

      // Build the multi-step stop conditions. The step-count guard is the primary
      // runaway bound; the cost guard (#926) additionally stops the loop once
      // accumulated usage cost reaches the per-run cap. AI SDK `stopWhen` accepts
      // an array — ANY condition stops the loop.
      const stopConditions = this.buildStopConditions(enhancedConfig, logger);

      // Start streaming with AI SDK
      const result = streamText({
        model: enhancedConfig.model,
        messages: enhancedConfig.messages as ModelMessage[],
        system: enhancedConfig.system,
        tools: enhancedConfig.tools,
        toolChoice: enhancedConfig.toolChoice,
        temperature: enhancedConfig.temperature,
        ...(stopConditions.length > 0 && { stopWhen: stopConditions }),
        ...(enhancedConfig.experimental_telemetry && enhancedConfig.experimental_telemetry.isEnabled && {
          experimental_telemetry: {
            isEnabled: enhancedConfig.experimental_telemetry.isEnabled,
            functionId: enhancedConfig.experimental_telemetry.functionId,
            metadata: enhancedConfig.experimental_telemetry.metadata
          }
        }),
        // Capture tool calls as each step finishes (AI SDK v6)
        onStepFinish: (event) => {
          logger.info('onStepFinish called', {
            provider: this.providerName,
            hasToolCalls: !!event.toolCalls,
            toolCallCount: event.toolCalls?.length || 0,
            hasToolResults: !!(event as { toolResults?: unknown[] }).toolResults,
            toolResultCount: ((event as { toolResults?: unknown[] }).toolResults)?.length || 0,
            finishReason: event.finishReason
          });

          // Capture tool calls
          if (event.toolCalls && Array.isArray(event.toolCalls)) {
            for (const tc of event.toolCalls) {
              // AI SDK v6 uses "input" for tool arguments, not "args"
              const toolCall = tc as { toolCallId: string; toolName: string; args?: unknown; input?: unknown };
              const toolArgs = (toolCall.input || toolCall.args || {}) as Record<string, unknown>;

              accumulatedToolCalls.push({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                args: toolArgs
              });
              logger.debug('Tool call captured from step', {
                provider: this.providerName,
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                hasArgs: Object.keys(toolArgs).length > 0
              });
            }
          }

          // NOTE: Tool results are NOT available in onStepFinish — AI SDK v4+ fires this
          // callback when the LLM call finishes, before tool execution completes.
          // Tool results are extracted from event.steps in onFinish instead.
          // See: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text#on-step-finish
        },
        onFinish: async (event) => {
          logger.info('streamText onFinish triggered', {
            provider: this.providerName,
            hasText: !!event.text,
            hasUsage: !!event.usage,
            finishReason: event.finishReason,
            textLength: event.text?.length || 0,
            toolCallCount: accumulatedToolCalls.length,
            toolNames: accumulatedToolCalls.map(tc => tc.toolName)
          });

          // Define proper type for usage
          interface StreamUsage {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            reasoningTokens?: number;
          }

          // Extract tool results from event.steps (shared method handles runtime validation)
          this.extractToolResultsFromSteps(event, accumulatedToolCalls, logger);

          // Transform to our expected format
          const usage = event.usage as StreamUsage;

          // Build per-step breakdown for multi-step tool-use persistence.
          // Each step's toolResults are matched to its toolCalls so the caller
          // can persist them as separate messages and preserve the correct
          // multi-turn structure on conversation replay. (Issue #977)
          // AI SDK v6 TypeScript types don't declare `steps` on the onFinish event
          // object, but the runtime value includes it for multi-step tool-use flows.
          // Cast to access the field until the SDK's types are updated.
          const rawSteps = (event as Record<string, unknown>).steps;
          const steps = Array.isArray(rawSteps)
            ? rawSteps.map((rawStep: unknown) => {
                if (typeof rawStep !== 'object' || rawStep === null) {
                  return { text: '', toolCalls: [], finishReason: 'stop' };
                }
                const s = rawStep as Record<string, unknown>;

                const stepToolCalls: AccumulatedToolCall[] = [];
                const rawCalls = s.toolCalls;
                if (Array.isArray(rawCalls)) {
                  for (const tc of rawCalls) {
                    if (typeof tc !== 'object' || tc === null) continue;
                    const tcTyped = tc as { toolCallId?: string; toolName?: string; args?: unknown; input?: unknown };
                    if (typeof tcTyped.toolCallId !== 'string' || typeof tcTyped.toolName !== 'string') continue;
                    stepToolCalls.push({
                      toolCallId: tcTyped.toolCallId,
                      toolName: tcTyped.toolName,
                      args: ((tcTyped.input ?? tcTyped.args) as Record<string, unknown>) || {},
                    });
                  }
                }

                const rawResults = s.toolResults;
                if (Array.isArray(rawResults)) {
                  for (const tr of rawResults) {
                    if (typeof tr !== 'object' || tr === null) continue;
                    const trTyped = tr as { toolCallId?: string; output?: unknown };
                    if (typeof trTyped.toolCallId !== 'string') continue;
                    const match = stepToolCalls.find(tc => tc.toolCallId === trTyped.toolCallId);
                    if (match) match.result = trTyped.output;
                  }
                }

                return {
                  text: typeof s.text === 'string' ? s.text : '',
                  toolCalls: stepToolCalls,
                  finishReason: typeof s.finishReason === 'string' ? s.finishReason : 'stop',
                };
              })
            : undefined;

          const transformedData = {
            text: event.text || '',
            usage: usage ? {
              promptTokens: usage.promptTokens || 0,
              completionTokens: usage.completionTokens || 0,
              totalTokens: usage.totalTokens || 0
            } : undefined,
            finishReason: event.finishReason || 'stop',
            toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
            steps: steps && steps.length > 1 ? steps : undefined,
          };

          // Call provider-specific finish handler
          await this.handleFinish(transformedData, callbacks);

          // Call user's finish callback
          if (callbacks.onFinish) {
            logger.info('Calling user onFinish callback from streamText', {
              hasCallback: true,
              textLength: event.text?.length || 0,
              toolCallCount: accumulatedToolCalls.length
            });
            await callbacks.onFinish(transformedData);
          }
        },
        onError: (event) => {
          const error = event.error instanceof Error ? event.error : new Error(String(event.error));
          
          logger.error('Stream error', {
            provider: this.providerName,
            error: error.message
          });
          
          // Call provider-specific error handler
          this.handleError(error, callbacks);
          
          // Call user's error callback
          if (callbacks.onError) {
            callbacks.onError(error);
          }
        }
      });
      
      // Handle streaming chunks for progress tracking
      this.handleStreamProgress(result, callbacks);
      
      return {
        toDataStreamResponse: (options?: { headers?: Record<string, string> }) =>
          result.toUIMessageStreamResponse ? result.toUIMessageStreamResponse(options) : result.toTextStreamResponse(options),
        toUIMessageStreamResponse: (options?: { headers?: Record<string, string> }) =>
          result.toUIMessageStreamResponse ? result.toUIMessageStreamResponse(options) : result.toTextStreamResponse(options),
        usage: Promise.resolve(result.usage)
      };
      
    } catch (error) {
      logger.error('Failed to start stream', {
        provider: this.providerName,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  
  /**
   * Validate if this adapter supports the given model
   * Must be implemented by each provider
   */
  abstract supportsModel(modelId: string): boolean;
  
  /**
   * Enhance the stream configuration with provider-specific options
   * Can be overridden by specific providers
   */
  protected enhanceStreamConfig(config: StreamConfig): StreamConfig {
    return {
      model: config.model,
      messages: config.messages,
      system: config.system,
      maxTokens: config.maxTokens,
      maxSteps: config.maxSteps,
      // Preserve the cost-cap inputs (#926) so the agentic loop's stop condition
      // survives provider-specific config enhancement.
      costCapCents: config.costCapCents,
      costRates: config.costRates,
      temperature: config.temperature,
      tools: config.tools,
      toolChoice: config.toolChoice,
      experimental_telemetry: config.experimental_telemetry
    };
  }

  /**
   * Build the multi-step `stopWhen` conditions (Issue #926). Always includes the
   * step-count bound when `maxSteps` is set. Adds a cost-cap condition when both a
   * cap and per-token rates are provided: it sums each completed step's token
   * usage × rates and stops once the estimated cost (in cents) reaches the cap.
   * Token usage (not dollars) is what the AI SDK exposes per step, so cost is
   * derived from the caller-supplied rates.
   */
  protected buildStopConditions(
    config: StreamConfig,
    logger: ReturnType<typeof createLogger>
  ): StopCondition[] {
    const conditions: StopCondition[] = [];
    if (config.maxSteps) {
      conditions.push(stepCountIs(config.maxSteps));
    }
    const cap = config.costCapCents;
    const rates = config.costRates;
    if (typeof cap === 'number' && cap > 0 && rates) {
      const capDollars = cap / 100;
      const costStop: CostStopPredicate = ({ steps }) => {
        let costDollars = 0;
        for (const step of steps) {
          const inTok = step.usage?.inputTokens ?? 0;
          const outTok = step.usage?.outputTokens ?? 0;
          costDollars += inTok * rates.inputPerToken + outTok * rates.outputPerToken;
        }
        const exceeded = costDollars >= capDollars;
        if (exceeded) {
          logger.warn('Agentic run hit cost cap; stopping loop', {
            provider: this.providerName,
            capCents: cap,
            estimatedCents: Math.round(costDollars * 100),
            steps: steps.length,
          });
        }
        return exceeded;
      };
      conditions.push(costStop);
    }
    return conditions;
  }
  
  /**
   * Handle streaming progress for callbacks
   * Can be overridden by specific providers for custom progress handling
   */
  protected handleStreamProgress(result: unknown, callbacks: StreamingCallbacks): void {
    // Base implementation - providers can override for custom progress tracking
    if (callbacks.onProgress) {
      // This would need to be implemented based on AI SDK streaming capabilities
      // For now, this is a placeholder for the interface
    }
  }
  
  /**
   * Handle stream finish event
   * Can be overridden by specific providers
   */
  protected async handleFinish(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    callbacks: StreamingCallbacks
  ): Promise<void> {
    // Provider-specific handlers can override this to extract special content
    // For example, Claude might extract thinking content
  }
  
  /**
   * Handle stream error event
   * Can be overridden by specific providers
   */
  protected handleError(
    error: Error,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    callbacks: StreamingCallbacks
  ): void {
    const isTransient = this.isTransientError(error);
    if (isTransient) {
      log.warn(`${this.providerName} adapter transient error`, {
        error: error.message,
        provider: this.providerName,
      });
    } else {
      log.error(`${this.providerName} adapter error`, {
        error: error.message,
        provider: this.providerName,
      });
    }
  }

  /**
   * Check if an error is transient (recoverable) vs permanent.
   * Transient errors are logged at warn level since they don't indicate
   * a systemic issue.
   *
   * Subclasses may override this to add provider-specific transient patterns.
   * Call `super.isTransientError(error)` to include the base patterns.
   * Do not call the module-level `isTransientStreamError()` directly from
   * subclass overrides — always go through `super` so the chain is extensible.
   */
  protected isTransientError(error: Error): boolean {
    return isTransientStreamError(error);
  }
  
  /**
   * Extract tool results from AI SDK v6 onFinish event.steps and match them
   * to accumulated tool calls. AI SDK v6's onStepFinish fires before tool
   * execution completes (toolResults is always []), so results must be read
   * from the complete steps array available in onFinish.
   *
   * Uses runtime type checks instead of unsafe `as unknown as` casts.
   */
  protected extractToolResultsFromSteps(
    event: unknown,
    accumulatedToolCalls: AccumulatedToolCall[],
    logger: ReturnType<typeof createLogger>
  ): void {
    if (typeof event !== 'object' || event === null) return;

    const steps = (event as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) return;

    for (const step of steps) {
      if (typeof step !== 'object' || step === null) continue;
      const toolResults = (step as Record<string, unknown>).toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (typeof tr !== 'object' || tr === null) continue;
        const { toolCallId, output } = tr as { toolCallId?: string; output?: unknown };
        if (typeof toolCallId !== 'string') continue;

        const match = accumulatedToolCalls.find(tc => tc.toolCallId === toolCallId);
        if (match) {
          match.result = output;
          logger.debug('Tool result matched from steps', {
            toolCallId,
            hasOutput: output !== undefined
          });
        }
      }
    }

    // Log extraction summary
    const withResults = accumulatedToolCalls.filter(tc => tc.result !== undefined).length;
    if (accumulatedToolCalls.length > 0) {
      logger.info('Tool result extraction complete', {
        totalToolCalls: accumulatedToolCalls.length,
        withResults,
        withoutResults: accumulatedToolCalls.length - withResults
      });
    }
  }

  /**
   * Get default capabilities for unknown models
   * Used as fallback when specific model capabilities are unknown
   */
  protected getDefaultCapabilities(): ProviderCapabilities {
    return {
      supportsReasoning: false,
      supportsThinking: false,
      supportedResponseModes: ['standard'],
      supportsBackgroundMode: false,
      supportedTools: [],
      typicalLatencyMs: 2000,
      maxTimeoutMs: 30000
    };
  }
  
  /**
   * Check if a model ID matches a pattern
   */
  protected matchesPattern(modelId: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      if (pattern.includes('*')) {
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern from admin config, not user input
        const regex = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
        return regex.test(modelId);
      }
      return modelId.toLowerCase().includes(pattern.toLowerCase());
    });
  }
}