# Streaming Layer (`/lib/streaming`)

Unified streaming service for AI provider integration with Server-Sent Events (SSE).

## Files

```
/lib/streaming
├── unified-streaming-service.ts  # Main streaming orchestrator
├── provider-adapters/            # Provider-specific implementations
│   ├── openai-adapter.ts
│   ├── claude-adapter.ts
│   ├── gemini-adapter.ts
│   └── bedrock-adapter.ts
├── circuit-breaker.ts            # Reliability pattern
├── sse-event-types.ts            # Type guards for SSE events
├── telemetry-service.ts          # OpenTelemetry integration
├── types.ts                      # TypeScript interfaces
└── README.md
```

## Architecture

See [Streaming Architecture Diagram](/docs/diagrams/09-streaming-architecture.md) for complete flow.

## Unified Streaming Service

### Basic Usage

```typescript
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';

const response = await unifiedStreamingService.stream({
  provider: 'openai',
  modelId: 'gpt-5-turbo',
  messages: [{ role: 'user', content: 'Hello!' }],
  source: 'nexus-chat',
  userId: session.user.id,
  sessionId: session.id,
  conversationId: conversation.id,
  systemPrompt: 'You are a helpful assistant.',
  maxTokens: 2000,
  temperature: 0.7
});

// Stream is iterable async
for await (const part of response.stream) {
  if (isTextDeltaEvent(part)) {
    yield part.textDelta;
  } else if (isFinishEvent(part)) {
    console.log('Tokens used:', part.usage.totalTokens);
  }
}
```

### Request Configuration

```typescript
interface StreamRequest {
  // Provider configuration
  provider: 'openai' | 'anthropic' | 'google' | 'bedrock';
  modelId: string;

  // Messages (AI SDK format)
  messages: UIMessage[];

  // Optional parameters
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: Record<string, any>;
  enabledTools?: string[];

  // Context
  source: 'nexus-chat' | 'model-compare' | 'assistant-architect';
  userId: number;
  sessionId?: string;
  conversationId?: string;

  // Options
  options?: ProviderOptions;
  telemetry?: TelemetryConfig;
}
```

## Provider Adapters

Each provider has specific adapter implementing `ProviderAdapter` interface:

```typescript
interface ProviderAdapter {
  getCapabilities(modelId: string): ProviderCapabilities;
  createModel(modelId: string, options?: ProviderOptions): Promise<LanguageModel>;
  createTools(toolNames: string[]): Promise<Record<string, CoreTool>>;
  getProviderOptions(modelId: string, options?: ProviderOptions): Record<string, any>;
}
```

### OpenAI Adapter

```typescript
import { getProviderAdapter } from './provider-adapters';

const adapter = await getProviderAdapter('openai');
const capabilities = adapter.getCapabilities('gpt-5-turbo');

console.log(capabilities);
// {
//   supportsToolCalling: true,
//   supportsReasoning: false,  // true for o1 models
//   supportsStreaming: true,
//   maxTokens: 16384,
//   supportedTools: ['web_search', 'code_interpreter']
// }
```

**OpenAI-specific features:**
- Responses API for GPT-5
- Reasoning tokens for o1 models
- Parallel function calling

### Claude Adapter

```typescript
const adapter = await getProviderAdapter('anthropic');
const model = await adapter.createModel('claude-opus-4');

// Claude-specific options
const options = adapter.getProviderOptions('claude-opus-4', {
  thinking: {
    type: 'enabled',
    budget_tokens: 10000
  },
  cache_control: {
    type: 'ephemeral'
  }
});
```

**Claude-specific features:**
- Extended thinking mode
- Prompt caching
- Vision capabilities

### Gemini Adapter

```typescript
const adapter = await getProviderAdapter('google');
const model = await adapter.createModel('gemini-2.0-flash-exp');
```

**Gemini-specific features:**
- Grounding with Google Search
- Safety settings
- Function calling

### Bedrock Adapter

```typescript
const adapter = await getProviderAdapter('bedrock');
const model = await adapter.createModel('anthropic.claude-3-5-sonnet-20241022-v2:0');
```

**Bedrock-specific features:**
- IAM authentication (no API keys)
- Cross-region inference
- Guardrails

## Circuit Breaker

Prevents cascading failures when AI provider is unavailable:

```typescript
import { CircuitBreaker } from './circuit-breaker';

const breaker = new CircuitBreaker();

// Record failures
breaker.recordFailure();
breaker.recordFailure();
// ... (after 5 failures in 60s window)

// Circuit opens
if (breaker.isOpen()) {
  throw new CircuitBreakerOpenError('openai', breaker.getState());
}

// After 30 seconds, auto-transitions to half-open
// One success closes circuit
breaker.recordSuccess();
```

### States

- **Closed**: Normal operation, requests allowed
- **Open**: Too many failures, block all requests
- **Half-Open**: After timeout, allow 1 test request

### Configuration

```typescript
const config = {
  failureThreshold: 5,      // Open after 5 failures
  resetTimeout: 30000,      // 30 seconds
  monitoringWindow: 60000   // 1 minute
};
```

## SSE Event Types

### Event Type Guards

```typescript
import {
  isTextDeltaEvent,
  isToolCallEvent,
  isReasoningDeltaEvent,
  isFinishEvent,
  isErrorEvent
} from './sse-event-types';

for await (const part of stream) {
  if (isTextDeltaEvent(part)) {
    console.log('Text:', part.textDelta);
  }
  else if (isToolCallEvent(part)) {
    console.log('Tool:', part.toolName, part.args);
  }
  else if (isReasoningDeltaEvent(part)) {
    console.log('Thinking:', part.reasoningDelta);
  }
  else if (isFinishEvent(part)) {
    console.log('Done:', part.finishReason, part.usage);
  }
  else if (isErrorEvent(part)) {
    console.error('Error:', part.error);
  }
}
```

### Event Types

```typescript
type StreamEvent =
  | { type: 'text-start'; content: string }
  | { type: 'text-delta'; content: string }
  | { type: 'text-end'; content: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; result: unknown }
  | { type: 'reasoning-start' }
  | { type: 'reasoning-delta'; content: string }
  | { type: 'reasoning-end'; content: string }
  | { type: 'finish'; finishReason: string; usage: TokenUsage }
  | { type: 'error'; error: string };
```

## Telemetry

### OpenTelemetry Integration

```typescript
import { getTelemetryConfig } from './telemetry-service';

const telemetryConfig = await getTelemetryConfig({
  functionId: 'nexus-chat.stream',
  userId: user.id,
  sessionId: session.id,
  modelId: 'gpt-5-turbo',
  provider: 'openai',
  source: 'nexus-chat',
  recordInputs: false,  // Don't log prompts (privacy)
  recordOutputs: false  // Don't log responses (privacy)
});

// Used by AI SDK automatically
const config = {
  experimental_telemetry: telemetryConfig.isEnabled ? {
    isEnabled: true,
    functionId: telemetryConfig.functionId,
    metadata: telemetryConfig.metadata
  } : undefined
};
```

### Metrics Tracked

- **Latency**: Time to first token, total duration
- **Throughput**: Tokens per second
- **Errors**: By provider and error type
- **Circuit breaker**: State changes

## Adaptive Timeouts

Timeouts adjust based on model capabilities:

```typescript
function getAdaptiveTimeout(
  capabilities: ProviderCapabilities,
  request: StreamRequest
): number {
  let timeout = 30000;  // Base 30s

  if (capabilities.supportsToolCalling && request.tools) {
    timeout += 30000;  // +30s for tools
  }

  if (capabilities.supportsReasoning) {
    timeout += 60000;  // +60s for reasoning models
  }

  if (request.maxTokens && request.maxTokens > 4000) {
    timeout += 30000;  // +30s for long outputs
  }

  return Math.min(timeout, 900000);  // Cap at 15 minutes
}
```

## Error Handling

### Retry Logic

```typescript
// Built into AI SDK with exponential backoff
const config = {
  maxRetries: 3,
  retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000)
};
```

### Error Types

```typescript
// Provider errors
class CircuitBreakerOpenError extends Error {
  constructor(provider: string, state: CircuitBreakerState) {
    super(`Circuit breaker is open for provider ${provider}`);
  }
}

// Timeout errors
class StreamTimeoutError extends Error {
  constructor(duration: number) {
    super(`Stream timeout after ${duration}ms`);
  }
}

// Rate limit errors
class RateLimitError extends Error {
  constructor(provider: string, retryAfter: number) {
    super(`Rate limited by ${provider}, retry after ${retryAfter}s`);
  }
}
```

## Testing

### Mock Provider

```typescript
// For testing, use mock adapter
const mockAdapter: ProviderAdapter = {
  getCapabilities: () => ({
    supportsStreaming: true,
    supportsToolCalling: true,
    maxTokens: 4096
  }),
  createModel: async () => mockModel,
  createTools: async () => ({}),
  getProviderOptions: () => ({})
};
```

### Integration Tests

```typescript
describe('UnifiedStreamingService', () => {
  it('should stream AI response', async () => {
    const response = await unifiedStreamingService.stream({
      provider: 'openai',
      modelId: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      source: 'test',
      userId: 1
    });

    const chunks: string[] = [];
    for await (const part of response.stream) {
      if (isTextDeltaEvent(part)) {
        chunks.push(part.textDelta);
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
  });
});
```

## Best Practices

1. **Always use type guards** - Don't assume event types
2. **Handle all event types** - Especially errors
3. **Close streams** - Prevent resource leaks
4. **Monitor circuit breaker** - Track provider health
5. **Configure timeouts** - Match model capabilities

## Related Documentation

- [Streaming Architecture](/docs/diagrams/09-streaming-architecture.md)
- [API Reference](/docs/API_REFERENCE.md#streaming)
- [Error Reference](/docs/ERROR_REFERENCE.md#streaming-errors)

---

**Last Updated**: November 2025
**Protocol**: Server-Sent Events (SSE)
**Providers**: OpenAI, Anthropic (Claude), Google (Gemini), AWS Bedrock
**Max Duration**: 15 minutes (Next.js route limit)
