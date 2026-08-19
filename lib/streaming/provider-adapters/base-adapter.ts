import {
  streamText,
  stepCountIs,
  createUIMessageStreamResponse,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessageChunk
} from 'ai';
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
 * Hard ceiling for any single streaming run, regardless of per-step budget and
 * step count. Bounds a wedged model/tool loop that keeps producing step
 * boundaries; the route/platform ceiling (`maxDuration`) is the backstop above it.
 */
const ABSOLUTE_STREAM_CEILING_MS = 600_000; // 10 minutes

/**
 * A step-aware wall-clock budget for one streaming run.
 *
 * A plain `AbortSignal.timeout()` bounds the ENTIRE `streamText` call — every
 * model call AND every tool execution — against one fixed clock. With multi-step
 * tool use that is actively wrong: a retrieval tool that takes 7s silently steals
 * 7s from the model's budget to write the answer. In prod this aborted a Nexus
 * attachment turn at exactly 30s with `textLength: 0` — the tool returned at +7s
 * and the model never got enough clock to produce a token.
 *
 * This grants each step its own `stepBudgetMs`, pushed forward at every step
 * boundary, while an absolute ceiling still bounds a runaway loop.
 */
export interface StreamDeadline {
  /** Abort signal for `streamText`; undefined when no budget is configured. */
  readonly signal?: AbortSignal;
  /** Push the per-step clock forward. Call at each step boundary. */
  extend(): void;
  /** True once THIS deadline aborted the run (vs. a caller-initiated abort). */
  timedOut(): boolean;
  /** Release the timer. Safe to call more than once. */
  dispose(): void;
}

/** Shared handle for "no timeout configured" — nothing to arm or release. */
const NO_STREAM_DEADLINE: StreamDeadline = {
  signal: undefined,
  extend: () => {},
  timedOut: () => false,
  dispose: () => {},
};

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
 * Usage shape reported by streamText's onFinish. AI SDK v6 reports
 * `inputTokens`/`outputTokens` (LanguageModelUsage); the legacy
 * `promptTokens`/`completionTokens` names are kept as fallbacks for provider
 * adapters that still emit them. Reading only the legacy names silently zeroed
 * the persisted prompt/completion split (epic #922 completion audit) — the
 * cost-cap predicate already reads the v6 names.
 */
interface StreamFinishUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** Normalize onFinish usage to the internal prompt/completion shape. */
export function transformFinishUsage(
  rawUsage: unknown
): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  if (!rawUsage) return undefined;
  const usage = rawUsage as StreamFinishUsage;
  const promptTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const completionTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    // Derive the total when the provider omits it (or reports a bogus 0 while
    // the components are non-zero) so downstream token accounting never sees a
    // zero total for a real completion. (PR #1129 review.)
    totalTokens: usage.totalTokens || promptTokens + completionTokens,
  };
}

/** One normalized step of a multi-step tool-use run (Issue #977). */
type TransformedStep = {
  text: string;
  toolCalls: AccumulatedToolCall[];
  finishReason: string;
};

/** Validate + normalize a step's raw toolCalls array (drops malformed items). */
function extractStepToolCalls(rawCalls: unknown): AccumulatedToolCall[] {
  const stepToolCalls: AccumulatedToolCall[] = [];
  if (!Array.isArray(rawCalls)) return stepToolCalls;
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
  return stepToolCalls;
}

/** Match a step's raw toolResults back onto its (already extracted) toolCalls. */
function attachStepToolResults(
  stepToolCalls: AccumulatedToolCall[],
  rawResults: unknown
): void {
  if (!Array.isArray(rawResults)) return;
  for (const tr of rawResults) {
    if (typeof tr !== 'object' || tr === null) continue;
    const trTyped = tr as { toolCallId?: string; output?: unknown };
    if (typeof trTyped.toolCallId !== 'string') continue;
    const match = stepToolCalls.find(tc => tc.toolCallId === trTyped.toolCallId);
    if (match) match.result = trTyped.output;
  }
}

/**
 * Normalize one raw onFinish step: validate its toolCalls, then match each
 * step-local toolResult back to its call so callers can persist steps as
 * separate messages and preserve multi-turn structure on replay (Issue #977).
 */
function transformFinishStep(rawStep: unknown): TransformedStep {
  if (typeof rawStep !== 'object' || rawStep === null) {
    return { text: '', toolCalls: [], finishReason: 'stop' };
  }
  const s = rawStep as Record<string, unknown>;
  const stepToolCalls = extractStepToolCalls(s.toolCalls);
  attachStepToolResults(stepToolCalls, s.toolResults);
  return {
    text: typeof s.text === 'string' ? s.text : '',
    toolCalls: stepToolCalls,
    finishReason: typeof s.finishReason === 'string' ? s.finishReason : 'stop',
  };
}

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
    
    // Hoisted so a synchronous streamText failure still releases the timer.
    let deadline: StreamDeadline = NO_STREAM_DEADLINE;

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
      deadline = this.buildStreamDeadline( // #926
        enhancedConfig.timeout,
        enhancedConfig.maxSteps,
        logger
      );
      const abortSignal = deadline.signal;

      // Set when the run is cut short (budget exhausted or caller abort) so
      // onFinish can tell a completed answer from a truncated one. AI SDK v6
      // still fires onFinish after an abort, carrying only the steps that had
      // already completed — persisting that as-is is what wrote empty assistant
      // messages to prod conversations.
      let streamAborted = false;

      // Start streaming with AI SDK
      const result = streamText({
        model: enhancedConfig.model,
        messages: enhancedConfig.messages as ModelMessage[],
        system: enhancedConfig.system,
        tools: enhancedConfig.tools,
        toolChoice: enhancedConfig.toolChoice,
        temperature: enhancedConfig.temperature,
        maxOutputTokens: enhancedConfig.maxTokens,
        ...(abortSignal && { abortSignal }),
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
          // Reaching a step boundary buys the next step a fresh budget, so the
          // time a tool spent executing is not deducted from the model's time to
          // write the answer.
          deadline.extend();

          logger.info('onStepFinish called', {
            provider: this.providerName,
            hasToolCalls: !!event.toolCalls,
            toolCallCount: event.toolCalls?.length || 0,
            hasToolResults: !!(event as { toolResults?: unknown[] }).toolResults,
            toolResultCount: ((event as { toolResults?: unknown[] }).toolResults)?.length || 0,
            finishReason: event.finishReason
          });

          // Capture tool calls
          this.captureStepToolCalls(event.toolCalls, accumulatedToolCalls, logger);

          // NOTE: Tool results are NOT available in onStepFinish — AI SDK v4+ fires this
          // callback when the LLM call finishes, before tool execution completes.
          // Tool results are extracted from event.steps in onFinish instead.
          // See: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text#on-step-finish
        },
        onFinish: async (event) => {
          deadline.dispose();
          const aborted = streamAborted || deadline.timedOut();

          logger.info('streamText onFinish triggered', {
            provider: this.providerName,
            hasText: !!event.text,
            hasUsage: !!event.usage,
            finishReason: event.finishReason,
            textLength: event.text?.length || 0,
            toolCallCount: accumulatedToolCalls.length,
            toolNames: accumulatedToolCalls.map(tc => tc.toolName),
            aborted
          });

          // Extract tool results from event.steps (shared method handles runtime validation)
          this.extractToolResultsFromSteps(event, accumulatedToolCalls, logger);

          const transformedData = this.buildFinishPayload(
            event,
            accumulatedToolCalls,
            aborted
          );

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
        // An aborted run reaches NEITHER onError NOR onFinish's error path in AI
        // SDK v6 — without this handler a wall-clock abort was silent server-side:
        // no log, no metric, no onError, and onFinish then persisted the partial
        // (often empty) result as if the turn had succeeded.
        //
        // NOTE (verified against ai@6.0.208): the SDK enqueues an `abort` UI part
        // and sets its internal isAborted flag, but does NOT raise a client-side
        // error, so the browser still just sees the stream stop. Making the cut-off
        // visible in the UI needs a separate client-side change; this handler only
        // guarantees the SERVER notices, records, and refuses to persist it.
        onAbort: ({ steps }) => {
          streamAborted = true;
          this.reportStreamAbort({
            deadline,
            completedSteps: steps.length,
            toolCallCount: accumulatedToolCalls.length,
            callbacks,
            logger
          });
        },
        onError: (event) => {
          deadline.dispose();
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
      
      const buildResponse = (options?: { headers?: Record<string, string> }) =>
        this.buildAbortAwareResponse(
          result,
          () => streamAborted || deadline.timedOut(),
          () => deadline.timedOut(),
          options
        );

      return {
        toDataStreamResponse: buildResponse,
        toUIMessageStreamResponse: buildResponse,
        usage: Promise.resolve(result.usage)
      };

    } catch (error) {
      deadline.dispose();
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
      // Preserve the per-run wall-clock timeout (#926) so the abortSignal is
      // applied after enhancement (otherwise the timeout would be silently lost).
      timeout: config.timeout,
      temperature: config.temperature,
      tools: config.tools,
      toolChoice: config.toolChoice,
      experimental_telemetry: config.experimental_telemetry
    };
  }

  /**
   * Accumulate a step's tool calls. AI SDK v6 names tool arguments `input`;
   * `args` is the pre-v6 name, kept as a fallback.
   */
  protected captureStepToolCalls(
    toolCalls: unknown,
    accumulatedToolCalls: AccumulatedToolCall[],
    logger: ReturnType<typeof createLogger>
  ): void {
    if (!Array.isArray(toolCalls)) {
      return;
    }
    for (const tc of toolCalls) {
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

  /**
   * Shape the AI SDK finish event into the callback payload used across adapters.
   *
   * Per-step breakdown feeds multi-step tool-use persistence (transformFinishStep,
   * Issue #977). AI SDK v6's TypeScript types don't declare `steps` on the finish
   * event, but the runtime value carries it for multi-step flows — hence the cast,
   * which can go once the SDK's types catch up.
   */
  protected buildFinishPayload(
    event: { text?: string; usage?: unknown; finishReason?: string },
    accumulatedToolCalls: AccumulatedToolCall[],
    aborted: boolean
  ) {
    const rawSteps = (event as Record<string, unknown>).steps;
    const steps = Array.isArray(rawSteps) ? rawSteps.map(transformFinishStep) : undefined;

    return {
      text: event.text || '',
      usage: transformFinishUsage(event.usage as Parameters<typeof transformFinishUsage>[0]),
      finishReason: event.finishReason || 'stop',
      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
      // Pass steps whenever any exist (not only > 1): a single-step agentic run
      // that calls one tool still needs its step data so onFinish can count tool
      // calls. `> 1` dropped single-step tool data. (Correctness review.)
      steps: steps && steps.length > 0 ? steps : undefined,
      // Truncated run — callers must not persist this as a completed turn.
      aborted,
    };
  }

  /**
   * User-facing text for a run that ended early. Shared by the server-side error
   * (`reportStreamAbort`) and the terminal chunk sent to the browser, so the log
   * and the thread say the same thing.
   */
  protected static abortNotice(timedOut: boolean): string {
    return timedOut
      ? 'The response was cut off before it finished — the model ran out of time. Try asking again, or break the request into smaller parts.'
      : 'The response was interrupted before it finished. Please try again.';
  }

  /**
   * Build the HTTP response, appending a terminal `error` chunk when the run was
   * cut short.
   *
   * Verified against ai@6.0.208: an abort enqueues an `abort` UI chunk and sets an
   * internal flag, but raises NO client-side error — the browser simply sees the
   * stream stop, which is exactly the "it just died mid-response" symptom users
   * reported. An `error` chunk DOES reach the client (`onError(new
   * Error(chunk.errorText))`), and the Thread renders it through
   * `MessagePrimitive.Error`. Appending one on flush turns a silent truncation
   * into a visible, explained one.
   *
   * The chunk is appended at end-of-stream, so it neither reorders nor rewrites
   * any content the model already produced.
   */
  protected buildAbortAwareResponse(
    result: {
      toUIMessageStream?: () => ReadableStream<UIMessageChunk>;
      toUIMessageStreamResponse?: (options?: { headers?: Record<string, string> }) => Response;
      toTextStreamResponse: (options?: { headers?: Record<string, string> }) => Response;
    },
    wasAborted: () => boolean,
    didTimeOut: () => boolean,
    options?: { headers?: Record<string, string> }
  ): Response {
    // Providers without the UI-message stream (plain text responses) keep the
    // previous behaviour — there is no chunk protocol to append to.
    if (typeof result.toUIMessageStream !== 'function') {
      return result.toUIMessageStreamResponse
        ? result.toUIMessageStreamResponse(options)
        : result.toTextStreamResponse(options);
    }

    // Track whether the turn produced anything the user can actually see. A
    // tool-only turn still renders (the thread shows tool output), so only a
    // stream with neither text nor tool activity is genuinely blank.
    let producedVisibleOutput = false;

    const stream = result.toUIMessageStream().pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          const type = (chunk as { type?: string }).type ?? '';
          if (type === 'text-delta' || type.startsWith('tool-') || type === 'reasoning-delta') {
            producedVisibleOutput = true;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (wasAborted()) {
            controller.enqueue({
              type: 'error',
              errorText: BaseProviderAdapter.abortNotice(didTimeOut()),
            });
            return;
          }
          // A run that ended cleanly having emitted nothing at all is still a
          // dead end for the user: the route now refuses to persist it, so
          // without this the stream would simply stop and reload as if the turn
          // never happened. Say so instead. (PR #1686 review.)
          if (!producedVisibleOutput) {
            controller.enqueue({
              type: 'error',
              errorText:
                'The model returned an empty response. Please try again, or rephrase your request.',
            });
          }
        },
      })
    );

    return createUIMessageStreamResponse({
      stream,
      ...(options?.headers ? { headers: options.headers } : {}),
    });
  }

  /**
   * Surface an aborted run: release the timer, log it, and raise a real error to
   * the caller. Shared by every adapter so no path can abort silently again.
   */
  protected reportStreamAbort(input: {
    deadline: StreamDeadline;
    completedSteps: number;
    toolCallCount: number;
    callbacks: StreamingCallbacks;
    logger: ReturnType<typeof createLogger>;
  }): void {
    const { deadline, completedSteps, toolCallCount, callbacks, logger } = input;
    deadline.dispose();
    const timedOut = deadline.timedOut();

    const error = new Error(BaseProviderAdapter.abortNotice(timedOut));
    logger.error('Stream aborted before completion', {
      provider: this.providerName,
      timedOut,
      completedSteps,
      toolCallCount
    });

    this.handleError(error, callbacks);
    if (callbacks.onError) {
      callbacks.onError(error);
    }
  }

  /**
   * Build the wall-clock budget for the per-run timeout (#926). Without it the
   * configured `timeout` was inert: a hung model/tool loop ran until the
   * route/platform ceiling (up to 900s).
   *
   * `timeoutMs` is the budget for a SINGLE step, not for the whole run: the clock
   * is pushed forward each time a step boundary is reached (see `StreamDeadline`),
   * so tool-execution time no longer eats the model's time to answer. The total
   * run is still bounded by `timeoutMs × maxSteps`, capped at
   * `ABSOLUTE_STREAM_CEILING_MS`. Single-step runs (no `maxSteps`) keep exactly
   * the previous semantics.
   *
   * Returns a no-op handle when no positive, finite timeout is configured. Shared
   * by all adapters (base + provider overrides) so every path enforces it.
   */
  protected buildStreamDeadline(
    timeoutMs: number | undefined,
    maxSteps: number | undefined,
    logger: ReturnType<typeof createLogger>
  ): StreamDeadline {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return NO_STREAM_DEADLINE;
    }

    const steps =
      typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps > 0
        ? Math.floor(maxSteps)
        : 1;
    const ceilingMs = Math.min(timeoutMs * steps, ABSOLUTE_STREAM_CEILING_MS);
    const controller = new AbortController();
    const startedAt = Date.now();
    const hardStopAt = startedAt + ceilingMs;
    let deadlineAt = startedAt + timeoutMs;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    logger.debug('Applying stream wall-clock budget', {
      provider: this.providerName,
      stepBudgetMs: timeoutMs,
      maxSteps: steps,
      ceilingMs,
    });

    const clear = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const arm = () => {
      clear();
      const firesAt = Math.min(deadlineAt, hardStopAt);
      timer = setTimeout(() => {
        timer = undefined;
        // `deadlineAt` may have moved while this timer was pending (a step
        // finished). Re-arm for the remainder rather than aborting early.
        if (Date.now() < Math.min(deadlineAt, hardStopAt)) {
          arm();
          return;
        }
        expired = true;
        logger.warn('Stream wall-clock budget exhausted — aborting run', {
          provider: this.providerName,
          stepBudgetMs: timeoutMs,
          ceilingMs,
          elapsedMs: Date.now() - startedAt,
        });
        controller.abort(
          new Error(
            `Stream exceeded its wall-clock budget (${Math.round(ceilingMs / 1000)}s)`
          )
        );
      }, Math.max(0, firesAt - Date.now()));
    };

    arm();

    return {
      signal: controller.signal,
      extend: () => {
        if (expired) {
          return;
        }
        deadlineAt = Date.now() + timeoutMs;
        arm();
      },
      timedOut: () => expired,
      dispose: clear,
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
      // Deliberately generous. Reaching this default means the model is NEWER
      // than its provider's pattern table, not smaller — new models are the ones
      // most likely to be slow, capable, and used for long answers. The old 30s
      // here silently truncated every Claude 4.x / Gemini 3 / Nova response in
      // Nexus. Pattern tables will always lag the model catalogue, so the
      // fallback must fail safe.
      maxTimeoutMs: 120000
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
