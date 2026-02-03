# Adding AI Providers Guide

## Overview

This guide provides step-by-step instructions for adding new AI providers to the Universal Polling Architecture. The system uses a provider adapter pattern that makes it easy to integrate new AI services while maintaining consistent behavior across all providers.

## Provider Adapter Architecture

### Base Adapter Interface

All providers must extend the `BaseProviderAdapter` abstract class:

```typescript
export abstract class BaseProviderAdapter {
  abstract providerName: string;
  abstract createModel(modelId: string, options?: any): Promise<any>;
  abstract getCapabilities(modelId: string): ProviderCapabilities;
  
  // Optional overrides
  getProviderOptions(modelId: string, options?: any): Record<string, any>;
  supportsModel(modelId: string): boolean;
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

Create a new adapter file in `/packages/ai-streaming-core/src/provider-adapters/`:

```typescript
// Example: mistral-adapter.ts
import { mistral } from '@ai-sdk/mistral';
import { BaseProviderAdapter } from './base-adapter';
import type { ProviderCapabilities } from '../types';

export class MistralAdapter extends BaseProviderAdapter {
  providerName = 'mistral';
  
  async createModel(modelId: string, options?: any): Promise<any> {
    // Get API key from settings manager or environment
    const apiKey = await this.settingsManager?.getApiKey('mistral') || 
                   process.env.MISTRAL_API_KEY;
    
    if (!apiKey) {
      throw new Error('Mistral API key not configured');
    }
    
    // Create model instance using AI SDK provider
    return mistral(modelId, {
      apiKey,
      baseURL: options?.baseURL,
      // Other provider-specific options
    });
  }
  
  getCapabilities(modelId: string): ProviderCapabilities {
    // Define capabilities based on model
    const isLargeModel = this.matchesPattern(modelId, ['mistral-large*']);
    const isCodeModel = this.matchesPattern(modelId, ['*-code*', 'codestral*']);
    
    return {
      supportsReasoning: false,
      supportsThinking: false,
      supportedResponseModes: ['standard'],
      supportsBackgroundMode: false,
      supportedTools: isCodeModel ? ['function_calling', 'code_interpreter'] : ['function_calling'],
      typicalLatencyMs: isLargeModel ? 4000 : 2000,
      maxTimeoutMs: 60000,
      costPerInputToken: isLargeModel ? 0.000002 : 0.000001,
      costPerOutputToken: isLargeModel ? 0.000006 : 0.000003
    };
  }
  
  getProviderOptions(modelId: string, options?: any): Record<string, any> {
    // Provider-specific configuration
    return {
      temperature: options?.temperature || 0.7,
      maxTokens: options?.maxTokens,
      // Mistral-specific options
      safePrompt: options?.safePrompt ?? true
    };
  }
  
  supportsModel(modelId: string): boolean {
    // Define which models this adapter supports
    const supportedPatterns = [
      'mistral-*',
      'codestral*',
      'mixtral-*'
    ];
    
    return this.matchesPattern(modelId, supportedPatterns);
  }
}
```

### Step 2: Add Required Dependencies

Update the package dependencies in `/packages/ai-streaming-core/package.json`:

```json
{
  "dependencies": {
    "ai": "^5.0.23",
    "@ai-sdk/openai": "^2.0.20",
    "@ai-sdk/google": "^2.0.8", 
    "@ai-sdk/amazon-bedrock": "^3.0.10",
    "@ai-sdk/azure": "^2.0.20",
    "@ai-sdk/mistral": "^2.0.8"
  }
}
```

### Step 3: Register Provider in Factory

Update `/packages/ai-streaming-core/src/provider-factory.ts`:

```typescript
import { OpenAIAdapter } from './provider-adapters/openai-adapter';
import { ClaudeAdapter } from './provider-adapters/claude-adapter';
import { GeminiAdapter } from './provider-adapters/gemini-adapter';
import { AzureAdapter } from './provider-adapters/azure-adapter';
import { MistralAdapter } from './provider-adapters/mistral-adapter';
import type { BaseProviderAdapter } from './provider-adapters/base-adapter';
import type { SettingsManager } from './utils/settings-manager';

export function createProviderAdapter(provider: string, settingsManager?: SettingsManager): BaseProviderAdapter {
  const normalizedProvider = provider.toLowerCase();
  
  switch (normalizedProvider) {
    case 'openai':
      return new OpenAIAdapter(settingsManager);
      
    case 'amazon-bedrock':
    case 'bedrock':
    case 'claude':
    case 'anthropic':
      return new ClaudeAdapter(settingsManager);
      
    case 'google':
    case 'gemini':
      return new GeminiAdapter(settingsManager);
      
    case 'azure':
    case 'azure-openai':
      return new AzureAdapter(settingsManager);
      
    case 'mistral':
      return new MistralAdapter(settingsManager);
      
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function getSupportedProviders(): string[] {
  return ['openai', 'amazon-bedrock', 'google', 'azure', 'mistral'];
}

export function isProviderSupported(provider: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  return getSupportedProviders().some(p => 
    normalizedProvider === p || 
    normalizedProvider === p.replace('-', '') ||
    (p === 'amazon-bedrock' && ['bedrock', 'claude', 'anthropic'].includes(normalizedProvider)) ||
    (p === 'google' && normalizedProvider === 'gemini') ||
    (p === 'azure' && normalizedProvider === 'azure-openai')
  );
}
```

### Step 4: Export from Package Index

Update `/packages/ai-streaming-core/src/index.ts`:

```typescript
// Provider Adapters
export { BaseProviderAdapter } from './provider-adapters/base-adapter';
export { OpenAIAdapter } from './provider-adapters/openai-adapter';
export { ClaudeAdapter } from './provider-adapters/claude-adapter';
export { GeminiAdapter } from './provider-adapters/gemini-adapter';
export { AzureAdapter } from './provider-adapters/azure-adapter';
export { MistralAdapter } from './provider-adapters/mistral-adapter';

// Rest of exports...
```

### Step 5: Add Database Configuration

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

### Step 6: Add Settings Management

Add API key configuration support:

```typescript
// Update SettingsManager to handle new provider
export class SettingsManager {
  async getApiKey(provider: string): Promise<string> {
    const keyMap = {
      'openai': 'OPENAI_API_KEY',
      'google': 'GOOGLE_API_KEY',
      'azure': 'AZURE_OPENAI_KEY',
      'amazon-bedrock': 'AWS_SECRET_ACCESS_KEY',
      'mistral': 'MISTRAL_API_KEY'
    };
    
    const keyName = keyMap[provider];
    if (!keyName) {
      throw new Error(`No API key configuration for provider: ${provider}`);
    }
    
    return await this.getSetting(keyName);
  }
}
```

### Step 7: Build and Test

Build the package and run tests:

```bash
cd packages/ai-streaming-core

# Build the package
npm run build

# Run type checking
npm run typecheck

# Run linting
npm run lint

# Test the new provider
npm test -- --grep "MistralAdapter"
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
- [ ] Shared package version updated
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