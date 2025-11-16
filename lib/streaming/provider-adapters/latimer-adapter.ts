import { type LanguageModel } from 'ai';
import {
  LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2StreamPart,
  type LanguageModelV2Prompt,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Content,
  type LanguageModelV2Usage,
  type LanguageModelV2Message,
  type LanguageModelV2CallWarning
} from '@ai-sdk/provider';
import { createLogger } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';
import { BaseProviderAdapter } from './base-adapter';
import type { ProviderCapabilities, StreamRequest } from '../types';

const log = createLogger({ module: 'latimer-adapter' });

/**
 * LanguageModelV2 implementation for Latimer AI
 * Wraps Latimer's custom API in AI SDK's standard interface
 */
class LatimerLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'latimer';
  readonly modelId: string;
  readonly supportedUrls = Promise.resolve({});

  constructor(modelId: string, private apiKey: string) {
    this.modelId = modelId;
  }

  /**
   * Stream implementation - calls Latimer API and emits proper stream parts
   */
  async doStream(
    options: LanguageModelV2CallOptions
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
    rawCall?: { rawPrompt?: unknown; rawSettings?: unknown };
    rawResponse?: { headers?: Record<string, string> };
    warnings?: LanguageModelV2CallWarning[];
  }> {
    // Log raw prompt for debugging
    log.info('Raw prompt from AI SDK', {
      promptLength: (options.prompt as LanguageModelV2Prompt).length,
      prompt: JSON.stringify(options.prompt)
    });

    // Convert AI SDK prompt format to Latimer format
    const messages = (options.prompt as LanguageModelV2Prompt).map((msg: LanguageModelV2Message) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }
      if (Array.isArray(msg.content)) {
        const textContent = msg.content
          .filter((part) =>
            typeof part === 'object' && part !== null && 'type' in part && part.type === 'text'
          )
          .map((part) => ('text' in part ? (part as { text: string }).text : ''))
          .join('');
        return { role: msg.role, content: textContent };
      }
      return { role: msg.role, content: '' };
    });

    const lastMessage = messages[messages.length - 1];
    // Filter out system messages and empty content (Latimer only supports user/assistant roles)
    const additionalMessages = messages.slice(0, -1)
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .filter(msg => msg.content && msg.content.trim() !== '');

    log.info('Latimer message conversion', {
      totalMessages: messages.length,
      additionalMessagesCount: additionalMessages.length,
      lastMessagePreview: lastMessage?.content?.substring(0, 50),
      allMessagesRoles: messages.map(m => `${m.role}:${m.content?.length || 0}chars`)
    });

    // Build payload - only include additionalMessages if not empty (Latimer requirement)
    const payload: {
      apiKey: string;
      message: string;
      model: string;
      additionalMessages?: Array<{ role: string; content: string }>;
      modelTemperature: number;
    } = {
      apiKey: this.apiKey,
      message: lastMessage?.content || '',
      model: this.modelId,
      modelTemperature: options.temperature ?? 0.7
    };

    if (additionalMessages.length > 0) {
      payload.additionalMessages = additionalMessages;
    }

    log.debug('Latimer API request', {
      model: payload.model,
      messageCount: additionalMessages.length + 1
    });

    // Create ReadableStream that emits proper LanguageModelV2StreamPart objects
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        try {
          const response = await fetch('https://api.latimer.ai/getCompletion', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: options.abortSignal
          });

          if (!response.ok) {
            const errorText = await response.text();
            log.error('Latimer API error', {
              status: response.status,
              statusText: response.statusText,
              error: errorText
            });
            throw new Error(`Latimer API error: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();

          log.info('Latimer API response received', {
            chatId: data.chatId,
            totalUsage: data.totalUsage,
            billedAmount: data.billedAmount
          });

          const fullText = data.message?.content || '';

          // Emit stream parts in correct order:
          // 1. Stream start
          controller.enqueue({
            type: 'stream-start',
            warnings: []
          });

          // 2. Text start (required before text-delta)
          if (fullText) {
            controller.enqueue({
              type: 'text-start',
              id: 'latimer-text'
            });

            // 3. Text delta (full response since Latimer doesn't support streaming)
            controller.enqueue({
              type: 'text-delta',
              delta: fullText,
              id: 'latimer-text'
            });
          }

          // 3. Finish with usage
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: data.inputUsage || 0,
              outputTokens: data.completionUsage || 0,
              totalTokens: data.totalUsage || 0
            }
          });

          controller.close();
        } catch (error) {
          log.error('Latimer streaming failed', {
            error: error instanceof Error ? error.message : String(error)
          });
          controller.error(error);
        }
      }
    });

    return {
      stream,
      rawCall: {
        rawPrompt: payload,
        rawSettings: {
          temperature: payload.modelTemperature
        }
      }
    };
  }

  /**
   * Generate implementation for non-streaming use cases
   */
  async doGenerate(
    options: LanguageModelV2CallOptions
  ): Promise<{
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    content: LanguageModelV2Content[];
    rawCall?: { rawPrompt?: unknown; rawSettings?: unknown };
    rawResponse?: { headers?: Record<string, string> };
    warnings: LanguageModelV2CallWarning[];
  }> {
    // Convert AI SDK prompt format to Latimer format (same as doStream)
    const messages = (options.prompt as LanguageModelV2Prompt).map((msg: LanguageModelV2Message) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }
      if (Array.isArray(msg.content)) {
        const textContent = msg.content
          .filter((part) =>
            typeof part === 'object' && part !== null && 'type' in part && part.type === 'text'
          )
          .map((part) => ('text' in part ? (part as { text: string }).text : ''))
          .join('');
        return { role: msg.role, content: textContent };
      }
      return { role: msg.role, content: '' };
    });

    const lastMessage = messages[messages.length - 1];
    // Filter out system messages and empty content (Latimer only supports user/assistant roles)
    const additionalMessages = messages.slice(0, -1)
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .filter(msg => msg.content && msg.content.trim() !== '');

    const payload: {
      apiKey: string;
      message: string;
      model: string;
      additionalMessages?: Array<{ role: string; content: string }>;
      modelTemperature: number;
    } = {
      apiKey: this.apiKey,
      message: lastMessage?.content || '',
      model: this.modelId,
      modelTemperature: options.temperature ?? 0.7
    };

    if (additionalMessages.length > 0) {
      payload.additionalMessages = additionalMessages;
    }

    const response = await fetch('https://api.latimer.ai/getCompletion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: options.abortSignal
    });

    if (!response.ok) {
      throw new Error(`Latimer API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return {
      finishReason: 'stop' as LanguageModelV2FinishReason,
      usage: {
        inputTokens: data.inputUsage || 0,
        outputTokens: data.completionUsage || 0,
        totalTokens: data.totalUsage || 0
      },
      content: [
        {
          type: 'text',
          text: data.message?.content || ''
        }
      ] as LanguageModelV2Content[],
      rawCall: {
        rawPrompt: payload,
        rawSettings: {
          temperature: payload.modelTemperature
        }
      },
      warnings: []
    };
  }
}

/**
 * Latimer AI provider adapter
 * Uses custom Latimer API (NOT OpenAI-compatible)
 * API: POST https://api.latimer.ai/getCompletion
 */
export class LatimerAdapter extends BaseProviderAdapter {
  protected providerName = 'latimer';

  async createModel(modelId: string, options?: StreamRequest['options']): Promise<LanguageModel> {
    try {
      const apiKey = await Settings.getLatimer();
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        log.error('Latimer API key not configured or invalid');
        throw ErrorFactories.sysConfigurationError('Latimer API key not configured');
      }

      log.info('Creating Latimer model', {
        modelId,
        hasOptions: !!options
      });

      // Return proper LanguageModelV2 instance
      return new LatimerLanguageModel(modelId, apiKey);

    } catch (error) {
      log.error('Failed to create Latimer model', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  // No streamWithEnhancements override - base adapter handles it via streamText()!

  getCapabilities(modelId: string): ProviderCapabilities {
    log.debug('Getting capabilities for Latimer model', { modelId });

    // Latimer uses custom API without native streaming/reasoning support
    return {
      supportsReasoning: false,
      supportsThinking: false,
      supportedResponseModes: ['standard'],
      supportsBackgroundMode: false,
      supportedTools: [],
      typicalLatencyMs: 2000,
      maxTimeoutMs: 60000 // 1 minute
    };
  }

  getSupportedTools(modelId: string): string[] {
    log.debug('Getting supported tools for Latimer model', { modelId });

    // Latimer currently doesn't support native tools
    return [];
  }

  supportsModel(modelId: string): boolean {
    log.debug('Checking model support', { modelId, provider: 'latimer' });

    // Basic validation before API-level validation
    if (!modelId || typeof modelId !== 'string' || modelId.trim() === '') {
      log.warn('Invalid model ID format', { modelId });
      return false;
    }

    // Support latimer-prefixed models
    if (!modelId.startsWith('latimer-')) {
      log.warn('Model ID does not match Latimer pattern', { modelId });
      return false;
    }

    return true;
  }
}
