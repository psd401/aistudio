# Adding AI Providers Guide

## Overview

This guide provides step-by-step instructions for adding new AI providers to the Universal Polling Architecture. The system uses a provider adapter pattern that makes it easy to integrate new AI services while maintaining consistent behavior across all providers.

## Provider Adapter Architecture

### Base Adapter Interface

All providers must extend the `BaseProviderAdapter` abstract class:

```typescript
// lib/streaming/provider-adapters/base-adapter.ts (abridged)
export abstract class BaseProviderAdapter implements ProviderAdapter {
  protected abstract providerName: string;
  protected providerClient?: unknown;

  // Required
  abstract createModel(modelId: string, options?: StreamRequest['options']): Promise<LanguageModel>;
  abstract getCapabilities(modelId: string): ProviderCapabilities;
  abstract getSupportedTools(modelId: string): string[];
  abstract supportsModel(modelId: string): boolean;

  // Optional overrides
  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown>;
  async createTools(enabledTools: string[]): Promise<ToolSet>;
}
```

### Provider Capabilities

Define what features each provider/model combination supports:

```typescript
interface ProviderCapabilities {
  supportsReasoning: boolean;        // Advanced reasoning like GPT-o1
  supportsThinking: boolean;         // Thinking process like Claude
  maxThinkingTokens?: number;        // Token limit for thinking
  supportedResponseModes: string[];  // 'standard', 'priority', 'flex'
  supportsBackgroundMode: boolean;   // Background processing
  supportedTools: string[];          // Available tool types
  typicalLatencyMs: number;          // Expected response time
  maxTimeoutMs: number;              // Maximum timeout needed
  costPerInputToken?: number;        // Pricing information
  costPerOutputToken?: number;
}
```

## Step-by-Step Implementation

### Step 1: Create Provider Adapter

Create a new adapter file in `/lib/streaming/provider-adapters/`:

Follow the existing adapters (for example `azure-adapter.ts`): read credentials through `Settings`, keep option types as `StreamRequest['options']`, and implement every abstract member of `BaseProviderAdapter` (`createModel`, `getCapabilities`, `getSupportedTools`, `supportsModel`).

```typescript
// Example: mistral-adapter.ts
import { createMistral } from '@ai-sdk/mistral';
import { createLogger } from '@/lib/logger';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';
import { BaseProviderAdapter } from './base-adapter';
import type { ProviderCapabilities, StreamRequest } from '../types';

const log = createLogger({ module: 'mistral-adapter' });

export class MistralAdapter extends BaseProviderAdapter {
  protected providerName = 'mistral';

  async createModel(modelId: string) {
    // Database-first with env fallback (see Step 5)
    const apiKey = await Settings.getMistral();
    if (!apiKey) {
      log.error('Mistral API key not configured');
      throw ErrorFactories.sysConfigurationError('Mistral API key not configured');
    }

    const client = createMistral({ apiKey });
    this.providerClient = client;
    return client(modelId);
  }

  getSupportedTools(_modelId: string): string[] {
    return [];
  }

  getCapabilities(modelId: string): ProviderCapabilities {
    const isLargeModel = this.matchesPattern(modelId, ['mistral-large*']);

    return {
      supportsReasoning: false,
      supportsThinking: false,
      supportedResponseModes: ['standard'],
      supportsBackgroundMode: false,
      supportedTools: this.getSupportedTools(modelId),
      typicalLatencyMs: isLargeModel ? 4000 : 2000,
      maxTimeoutMs: 60000,
      costPerInputToken: isLargeModel ? 0.000002 : 0.000001,
      costPerOutputToken: isLargeModel ? 0.000006 : 0.000003
    };
  }

  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown> {
    // Start from the base options, then add provider-specific ones
    return {
      ...super.getProviderOptions(modelId, options),
      safePrompt: true
    };
  }

  supportsModel(modelId: string): boolean {
    return this.matchesPattern(modelId, ['mistral-*', 'codestral*', 'mixtral-*']);
  }
}
```

### Step 2: Add Required Dependencies

Add the AI SDK provider package to the root `package.json`:

```bash
bun add @ai-sdk/mistral
```

### Step 3: Register Provider in the Adapter Registry

Add the adapter to the `adapters` map in `/lib/streaming/provider-adapters/index.ts`:

```typescript
import { MistralAdapter } from './mistral-adapter';

const adapters = new Map<string, ProviderAdapter>([
  ['openai', new OpenAIAdapter()],
  ['amazon-bedrock', new ClaudeAdapter()],
  ['google', new GeminiAdapter()],
  ['azure', new AzureAdapter()],
  ['latimer', new LatimerAdapter()],
  ['mistral', new MistralAdapter()]
]);
```

`getProviderAdapter()` and `getSupportedProviders()` in this file read from the map.

The central model factory, `/lib/ai/provider-factory.ts`, keeps its own provider list. Callers of `createProviderModel()` (for example `app/api/compare/route.ts`) reject any provider missing from it. Register the provider there too:

```typescript
// 1. Add a case to the switch in createProviderModel()
case 'mistral':
  return await createMistralModel(modelId);

// 2. Add a creator that delegates to the adapter (same pattern as createLatimerModel)
async function createMistralModel(modelId: string): Promise<LanguageModel> {
  try {
    log.debug(`Creating Mistral model: ${modelId}`);
    const adapter = await getProviderAdapter('mistral');
    return await adapter.createModel(modelId);
  } catch (error) {
    log.error('Failed to create Mistral model', { modelId, error });
    throw error;
  }
}

// 3. Add 'mistral' to the arrays in isSupportedProvider() and getSupportedProviders()
```

### Step 4: Add Database Configuration

Update the AI models table to include the new provider:

```sql
-- Add new models to the ai_models table
-- Note: capabilities are stored as JSON array in TEXT field
INSERT INTO ai_models (
  provider,
  model_id,
  name,
  description,
  input_cost_per_1k_tokens,
  output_cost_per_1k_tokens,
  max_tokens,
  active,
  nexus_enabled,
  architect_enabled,
  capabilities
) VALUES
(
  'mistral',
  'mistral-large-latest',
  'Mistral Large',
  'Mistral''s most capable model for complex reasoning',
  0.002,
  0.006,
  8192,
  true,
  true,
  true,
  '["chat"]'
),
(
  'mistral',
  'codestral-latest',
  'Codestral',
  'Mistral''s specialized code generation model',
  0.001,
  0.003,
  8192,
  true,
  true,
  true,
  '["chat","code_interpreter","code_execution"]'
);
```

### Step 5: Add Settings Management

Add a getter to the `Settings` object in `/lib/settings-manager.ts`. `getSetting()` reads the database first and falls back to the environment variable of the same name:

```typescript
export const Settings = {
  // ...existing getters

  async getMistral() {
    return getSetting('MISTRAL_API_KEY')
  },
}
```

### Step 6: Verify

Run the standard checks from the repository root:

```bash
bun run typecheck
bun run lint
bun run test:ci
```

## Advanced Provider Features

### Custom Message Processing

For providers with unique message format requirements:

```typescript
export class CustomAdapter extends BaseProviderAdapter {
  // Override message preprocessing if needed
  protected preprocessMessages(messages: any[]): any[] {
    return messages.map(msg => {
      // Custom message transformation
      if (msg.role === 'system') {
        return {
          role: 'assistant',  // Some providers don't support system role
          content: `Instructions: ${msg.content}`
        };
      }
      
      return msg;
    });
  }
  
  async streamWithEnhancements(config: StreamConfig, callbacks: StreamingCallbacks = {}): Promise<any> {
    // Custom preprocessing
    const processedMessages = this.preprocessMessages(config.messages);
    
    // Call parent implementation with processed messages
    return super.streamWithEnhancements({
      ...config,
      messages: processedMessages
    }, callbacks);
  }
}
```

### Reasoning and Thinking Support

For providers that support advanced features:

```typescript
export class ReasoningAdapter extends BaseProviderAdapter {
  getCapabilities(modelId: string): ProviderCapabilities {
    const supportsReasoning = modelId.includes('reasoning');
    
    return {
      supportsReasoning,
      supportsThinking: false,
      supportedResponseModes: supportsReasoning ? ['standard', 'priority'] : ['standard'],
      supportsBackgroundMode: true,
      supportedTools: ['function_calling'],
      typicalLatencyMs: supportsReasoning ? 15000 : 3000,
      maxTimeoutMs: supportsReasoning ? 300000 : 60000
    };
  }
  
  getProviderOptions(modelId: string, options?: any): Record<string, any> {
    const capabilities = this.getCapabilities(modelId);
    
    const providerOptions: Record<string, any> = {
      temperature: options?.temperature
    };
    
    // Add reasoning-specific options
    if (capabilities.supportsReasoning && options?.reasoningEffort) {
      providerOptions.reasoning_effort = options.reasoningEffort;
    }
    
    return providerOptions;
  }
}
```

### Custom Authentication

For providers with special authentication requirements:

```typescript
export class OAuth2Adapter extends BaseProviderAdapter {
  private async getAccessToken(): Promise<string> {
    // Implement OAuth2 token refresh logic
    const refreshToken = await this.settingsManager?.getSetting('PROVIDER_REFRESH_TOKEN');
    
    const response = await fetch('https://provider.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.PROVIDER_CLIENT_ID!,
        client_secret: process.env.PROVIDER_CLIENT_SECRET!
      })
    });
    
    const { access_token } = await response.json();
    return access_token;
  }
  
  async createModel(modelId: string, options?: any): Promise<any> {
    const accessToken = await this.getAccessToken();
    
    return customProvider(modelId, {
      authorization: `Bearer ${accessToken}`,
      ...options
    });
  }
}
```

## Testing New Providers

### Unit Tests

Create comprehensive tests for your provider:

```typescript
// tests/provider-adapters/mistral-adapter.test.ts
import { MistralAdapter } from '../../src/provider-adapters/mistral-adapter';
import { createMockSettingsManager } from '../helpers/mock-settings-manager';

describe('MistralAdapter', () => {
  let adapter: MistralAdapter;
  let mockSettings: any;
  
  beforeEach(() => {
    mockSettings = createMockSettingsManager({
      'MISTRAL_API_KEY': 'test-key'
    });
    adapter = new MistralAdapter(mockSettings);
  });
  
  describe('createModel', () => {
    it('should create model with correct configuration', async () => {
      const model = await adapter.createModel('mistral-large-latest');
      
      expect(model).toBeDefined();
      expect(mockSettings.getApiKey).toHaveBeenCalledWith('mistral');
    });
    
    it('should throw error when API key is missing', async () => {
      mockSettings.getApiKey.mockResolvedValue(null);
      
      await expect(adapter.createModel('mistral-large-latest'))
        .rejects.toThrow('Mistral API key not configured');
    });
  });
  
  describe('getCapabilities', () => {
    it('should return correct capabilities for large models', () => {
      const capabilities = adapter.getCapabilities('mistral-large-latest');
      
      expect(capabilities).toEqual({
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: ['function_calling'],
        typicalLatencyMs: 4000,
        maxTimeoutMs: 60000,
        costPerInputToken: 0.000002,
        costPerOutputToken: 0.000006
      });
    });
    
    it('should return correct capabilities for code models', () => {
      const capabilities = adapter.getCapabilities('codestral-latest');
      
      expect(capabilities.supportedTools).toContain('code_interpreter');
    });
  });
  
  describe('supportsModel', () => {
    it('should support mistral models', () => {
      expect(adapter.supportsModel('mistral-large-latest')).toBe(true);
      expect(adapter.supportsModel('codestral-latest')).toBe(true);
      expect(adapter.supportsModel('gpt-4')).toBe(false);
    });
  });
});
```

### Integration Tests

Test with real provider APIs:

```typescript
// tests/integration/mistral-integration.test.ts
import { MistralAdapter } from '../../src/provider-adapters/mistral-adapter';
import { UnifiedStreamingService } from '../../src/unified-streaming-service';

describe('Mistral Integration', () => {
  let adapter: MistralAdapter;
  let streamingService: UnifiedStreamingService;
  
  beforeEach(() => {
    adapter = new MistralAdapter();
    streamingService = new UnifiedStreamingService();
  });
  
  it('should successfully stream response from Mistral', async () => {
    const response = await streamingService.stream({
      messages: [{ role: 'user', content: 'Hello, world!' }],
      modelId: 'mistral-large-latest',
      provider: 'mistral',
      userId: 'test-user',
      sessionId: 'test-session',
      conversationId: 'test-conversation',
      source: 'test'
    });
    
    expect(response.result).toBeDefined();
    expect(response.capabilities.supportedTools).toContain('function_calling');
  }, 30000); // 30 second timeout for real API calls
});
```

## Deployment Checklist

Before deploying a new provider to production:

### Pre-Deployment

- [ ] Unit tests pass with 100% coverage
- [ ] Integration tests pass with real API
- [ ] TypeScript compilation succeeds
- [ ] ESLint passes without warnings
- [ ] Provider adapter follows naming conventions
- [ ] Database models added with correct pricing
- [ ] API keys configured in Secrets Manager
- [ ] Documentation updated

### Staging Deployment

- [ ] Deploy to staging environment
- [ ] Test complete job lifecycle
- [ ] Verify error handling
- [ ] Test timeout behavior
- [ ] Confirm monitoring and logging work
- [ ] Load test with realistic workload

### Production Deployment

- [ ] Database migration applied
- [ ] Lambda functions redeployed
- [ ] Frontend updated to show new provider
- [ ] Monitoring dashboards updated
- [ ] Team notified of new provider

## Troubleshooting Common Issues

### API Key Issues

```typescript
// Debug API key retrieval
const debugApiKey = async (provider: string) => {
  const settingsManager = createSettingsManager(executeSQL);
  
  try {
    const apiKey = await settingsManager.getApiKey(provider);
    console.log(`API key found: ${apiKey ? 'Yes' : 'No'}`);
    console.log(`Key length: ${apiKey?.length || 0}`);
    console.log(`Key prefix: ${apiKey?.substring(0, 8) || 'None'}...`);
  } catch (error) {
    console.error('API key error:', error);
  }
};
```

### Model Creation Failures

```typescript
// Test model creation in isolation
const testModelCreation = async () => {
  const adapter = new MistralAdapter();
  
  try {
    const model = await adapter.createModel('mistral-large-latest');
    console.log('Model created successfully:', !!model);
  } catch (error) {
    console.error('Model creation failed:', error.message);
    
    // Check common issues
    if (error.message.includes('API key')) {
      console.log('Issue: API key not configured');
    } else if (error.message.includes('model')) {
      console.log('Issue: Model ID not supported');
    }
  }
};
```

### Timeout Configuration

```typescript
// Verify timeout settings
const verifyTimeouts = (modelId: string) => {
  const adapter = new MistralAdapter();
  const capabilities = adapter.getCapabilities(modelId);
  
  console.log(`Typical latency: ${capabilities.typicalLatencyMs}ms`);
  console.log(`Max timeout: ${capabilities.maxTimeoutMs}ms`);
  
  // Ensure timeout is reasonable for model
  if (capabilities.maxTimeoutMs < capabilities.typicalLatencyMs * 2) {
    console.warn('Timeout may be too short for this model');
  }
};
```

This comprehensive guide provides everything needed to successfully add new AI providers to the Universal Polling Architecture while maintaining system reliability and consistency.