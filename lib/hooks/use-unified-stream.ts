"use client";

import { useChat } from '@ai-sdk/react';
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { createLogger } from '@/lib/logger';
import type { 
  UseUnifiedStreamConfig, 
  UseUnifiedStreamReturn,
  ProviderCapabilities,
  StreamRequest
} from '@/lib/streaming/types';

const log = createLogger({ module: 'use-unified-stream' });
type Toast = ReturnType<typeof useToast>["toast"];

function handleStreamFinish(
  event: unknown,
  source: UseUnifiedStreamConfig["source"],
  toast: Toast,
  setReasoning: (value: string | null) => void,
  setThinking: (value: string | null) => void
): void {
  log.debug('Stream finished', { source, messageLength: 0 });
  const reasoning = stringProperty(event, 'reasoning');
  const thinking = stringProperty(event, 'thinking');
  if (reasoning) setReasoning(reasoning);
  if (thinking) setThinking(thinking);
  toast({
    title: 'Response Complete',
    description: 'AI response generated successfully'
  });
}

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : null;
}

function streamErrorMessage(error: Error): {
  title: string;
  description: string;
} {
  if (error.message.includes('timeout')) {
    return {
      title: 'Request Timeout',
      description: 'The AI model took too long to respond. Please try again.'
    };
  }
  if (error.message.includes('quota') || error.message.includes('rate limit')) {
    return {
      title: 'Rate Limit Exceeded',
      description: 'Too many requests. Please wait a moment before trying again.'
    };
  }
  if (error.message.includes('content')) {
    return {
      title: 'Content Policy',
      description: 'The request was blocked by content policy filters.'
    };
  }
  return { title: 'AI Error', description: error.message };
}

function handleStreamError(
  error: Error,
  source: UseUnifiedStreamConfig["source"],
  toast: Toast
): void {
  log.error('Stream error', { source, error: error.message });
  toast({ ...streamErrorMessage(error), variant: 'destructive' });
}

function buildUnifiedStreamBody(
  config: UseUnifiedStreamConfig,
  requestConfig?: Partial<StreamRequest>
) {
  return {
    ...streamTarget(config, requestConfig),
    ...streamModelOptions(config, requestConfig),
    ...streamRequestContext(config, requestConfig),
    ...requestConfig
  };
}

function streamTarget(
  config: UseUnifiedStreamConfig,
  requestConfig?: Partial<StreamRequest>
) {
  return {
    source: config.source,
    modelId: config.modelId || requestConfig?.modelId,
    provider: config.provider || requestConfig?.provider,
  };
}

function streamModelOptions(
  config: UseUnifiedStreamConfig,
  requestConfig?: Partial<StreamRequest>
) {
  return {
    systemPrompt: config.systemPrompt || requestConfig?.systemPrompt,
    maxTokens: requestConfig?.maxTokens,
    temperature: requestConfig?.temperature,
    timeout: requestConfig?.timeout,
    ...streamAdvancedOptions(config.options),
  };
}

function streamAdvancedOptions(options: UseUnifiedStreamConfig["options"]) {
  return {
    reasoningEffort: options?.reasoningEffort || 'medium',
    responseMode: options?.responseMode || 'standard',
    backgroundMode: options?.backgroundMode || false,
    thinkingBudget: options?.thinkingBudget,
    enableWebSearch: options?.enableWebSearch || false,
    enableCodeInterpreter: options?.enableCodeInterpreter || false,
    enableImageGeneration: options?.enableImageGeneration || false,
  };
}

function streamRequestContext(
  config: UseUnifiedStreamConfig,
  requestConfig?: Partial<StreamRequest>
) {
  return {
    conversationId: requestConfig?.conversationId,
    executionId: requestConfig?.executionId,
    documentId: requestConfig?.documentId,
    recordInputs: config.telemetry?.recordInputs,
    recordOutputs: config.telemetry?.recordOutputs,
  };
}

function requireUnifiedStreamTarget(body: {
  modelId?: string;
  provider?: string;
}): void {
  if (!body.modelId) throw new Error('Model ID is required for unified streaming');
  if (!body.provider) throw new Error('Provider is required for unified streaming');
}

function useModelCapabilities(config: UseUnifiedStreamConfig) {
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  useEffect(() => {
    if (!config.modelId || !config.provider) return;
    let cancelled = false;
    async function fetchCapabilities() {
      try {
        const response = await fetch('/api/models/capabilities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: config.provider, modelId: config.modelId })
        });
        if (!response.ok || cancelled) return;
        const result = await response.json() as ProviderCapabilities;
        setCapabilities(result);
        log.debug('Model capabilities loaded', {
          modelId: config.modelId,
          provider: config.provider,
          supportsReasoning: result.supportsReasoning,
          supportsThinking: result.supportsThinking
        });
      } catch (error) {
        if (!cancelled) {
          log.warn('Failed to fetch model capabilities', {
            modelId: config.modelId,
            provider: config.provider,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    void fetchCapabilities();
    return () => { cancelled = true; };
  }, [config.modelId, config.provider]);
  return [capabilities, setCapabilities] as const;
}

/**
 * Unified streaming hook that provides a consistent interface
 * for all AI streaming operations across the application
 * 
 * Features:
 * - Automatic provider detection and capabilities
 * - Reasoning and thinking content extraction
 * - Adaptive timeouts based on model capabilities
 * - Comprehensive error handling
 * - Progress tracking and status updates
 */
export function useUnifiedStream(config: UseUnifiedStreamConfig): UseUnifiedStreamReturn {
  const { toast } = useToast();
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [thinking, setThinking] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useModelCapabilities(config);
  
  // Use AI SDK's useChat with unified streaming endpoint
  const {
    messages,
    setMessages,
    status,
    error: chatError,
    sendMessage: baseSendMessage,
    stop
  } = useChat({
    onFinish: (message) =>
      handleStreamFinish(message, config.source, toast, setReasoning, setThinking),
    onError: (error) => handleStreamError(error, config.source, toast)
  });
  
  /**
   * Enhanced send message function with unified streaming support
   */
  const sendMessage = useCallback(async (
    message: Parameters<typeof baseSendMessage>[0],
    requestConfig?: Partial<StreamRequest>
  ) => {
    try {
      log.debug('Sending message via unified stream', {
        source: config.source,
        modelId: config.modelId,
        provider: config.provider,
        hasConfig: !!requestConfig
      });
      
      // Clear previous reasoning/thinking content
      setReasoning(null);
      setThinking(null);
      
      const body = buildUnifiedStreamBody(config, requestConfig);
      requireUnifiedStreamTarget(body);
      await baseSendMessage(message, { body });
      
    } catch (error) {
      log.error('Failed to send message', {
        source: config.source,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }, [config, baseSendMessage]);
  
  /**
   * Clear all messages and state
   */
  const clear = useCallback(() => {
    setMessages([]);
    setReasoning(null);
    setThinking(null);
    setCapabilities(null);
  }, [setMessages]);
  
  return {
    messages,
    status: status as UseUnifiedStreamReturn['status'],
    error: chatError || null,
    reasoning,
    thinking,
    sendMessage,
    stop,
    clear,
    capabilities
  };
}

/**
 * Hook for chat-specific streaming with sensible defaults
 */
export function useChatStream(config?: Partial<UseUnifiedStreamConfig>) {
  return useUnifiedStream({
    source: 'chat',
    ...config
  });
}

/**
 * Hook for model comparison streaming
 */
export function useCompareStream(config: {
  model1?: { provider: string; modelId: string };
  model2?: { provider: string; modelId: string };
} & Partial<UseUnifiedStreamConfig>) {
  // For comparison, we'll manage two separate streams
  const stream1 = useUnifiedStream({
    source: 'compare',
    provider: config.model1?.provider,
    modelId: config.model1?.modelId,
    ...config
  });
  
  const stream2 = useUnifiedStream({
    source: 'compare',
    provider: config.model2?.provider,
    modelId: config.model2?.modelId,
    ...config
  });
  
  return { stream1, stream2 };
}

/**
 * Hook for assistant execution streaming
 */
export function useAssistantStream(config: {
  executionId?: number;
} & Partial<UseUnifiedStreamConfig>) {
  return useUnifiedStream({
    source: 'assistant_execution',
    ...config
  });
}
