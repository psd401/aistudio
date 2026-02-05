# AI SDK Patterns Guide

Comprehensive guide for implementing AI features using Vercel AI SDK v6 and provider integrations in AI Studio.

## Overview

AI Studio uses Vercel AI SDK v6 with a modular provider factory pattern supporting:
- OpenAI (GPT-5, GPT-4, GPT-3.5)
- Google AI (Gemini models)
- Amazon Bedrock (Claude, Llama, etc.)
- Azure OpenAI

## Core Dependencies

```json
{
  "ai": "~6.0.0",
  "@ai-sdk/react": "^3.0.71",
  "@ai-sdk/openai": "^3.0.7",
  "@ai-sdk/google": "^3.0.20",
  "@ai-sdk/amazon-bedrock": "^4.0.48",
  "@ai-sdk/azure": "^3.0.26"
}
```

## Provider Factory Pattern

### Architecture

The provider factory (`/app/api/chat/lib/provider-factory.ts`) provides a unified interface for creating models across different providers:

```typescript
import { createProviderModel } from '@/app/api/chat/lib/provider-factory'

// Create any provider model with consistent interface
const model = await createProviderModel('openai', 'gpt-4-turbo')
const model = await createProviderModel('google', 'gemini-1.5-pro')
const model = await createProviderModel('amazon-bedrock', 'anthropic.claude-3-sonnet')
```

### Provider Configuration

Each provider uses settings from the database with environment variable fallback:

```typescript
// OpenAI
const apiKey = await Settings.getOpenAI()  // Checks DB then env

// Google
process.env.GOOGLE_GENERATIVE_AI_API_KEY = await Settings.getGoogleAI()

// Amazon Bedrock (supports IAM roles in Lambda)
const config = await Settings.getBedrock()
// Uses IAM roles in Lambda, explicit credentials locally

// Azure
const config = await Settings.getAzureOpenAI()
```

## Streaming Patterns

### Chat Streaming with streamText

```typescript
import { streamText, convertToModelMessages } from 'ai'
import { createProviderModel } from '@/app/api/chat/lib/provider-factory'

export async function POST(req: Request) {
  const { messages, modelId, provider } = await req.json()
  
  // Create model using factory
  const model = await createProviderModel(provider, modelId)
  
  // Convert UI messages to model format
  const modelMessages = convertToModelMessages(messages)
  
  // Stream response
  const result = streamText({
    model,
    messages: modelMessages,
    system: "You are a helpful assistant",
    temperature: 0.7,
    maxTokens: 2000,
    
    // Track token usage
    onFinish: ({ text, usage, finishReason }) => {
      log.info("Stream completed", {
        tokens: usage.totalTokens,
        finishReason,
        responseLength: text.length
      })
    }
  })
  
  // Return as Response with proper headers
  return result.toResponse()
}
```

### Client-Side Chat with useChat

```typescript
"use client"
import { useChat } from '@ai-sdk/react'

export function ChatComponent() {
  const { 
    messages, 
    input, 
    handleInputChange, 
    handleSubmit,
    isLoading,
    error,
    append,
    reload,
    stop
  } = useChat({
    api: '/api/chat',
    
    // Custom body data sent with each request
    body: {
      modelId: selectedModel,
      provider: selectedProvider,
      conversationId: currentConversation?.id,
      documentId: attachedDocument?.id
    },
    
    // Headers
    headers: {
      'X-Source': 'chat-ui'
    },
    
    // Callbacks
    onError: (error) => {
      console.error('Chat error:', error)
      toast.error('Failed to send message')
    },
    
    onFinish: (message) => {
      // Save to database, update UI, etc.
    }
  })
  
  return (
    <form onSubmit={handleSubmit}>
      {messages.map(m => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
        </div>
      ))}
      
      <input
        value={input}
        onChange={handleInputChange}
        disabled={isLoading}
      />
      
      <button type="submit" disabled={isLoading}>
        {isLoading ? 'Sending...' : 'Send'}
      </button>
      
      {isLoading && (
        <button onClick={stop}>Stop</button>
      )}
    </form>
  )
}
```

## Text Generation Patterns

### Non-Streaming with generateText

```typescript
import { generateText } from 'ai'

async function generateSummary(content: string) {
  const model = await createProviderModel('openai', 'gpt-4-turbo')
  
  const { text, usage, finishReason } = await generateText({
    model,
    prompt: `Summarize the following content:\n\n${content}`,
    temperature: 0.3,
    maxTokens: 500
  })
  
  return {
    summary: text,
    tokensUsed: usage.totalTokens,
    finishReason
  }
}
```

### Structured Output with generateObject

```typescript
import { generateObject } from 'ai'
import { z } from 'zod'

const analysisSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  topics: z.array(z.string()),
  summary: z.string(),
  confidence: z.number().min(0).max(1)
})

async function analyzeContent(content: string) {
  const model = await createProviderModel('openai', 'gpt-4-turbo')
  
  const { object } = await generateObject({
    model,
    schema: analysisSchema,
    prompt: `Analyze this content: ${content}`
  })
  
  return object  // Typed as z.infer<typeof analysisSchema>
}
```

## Server-Sent Events (SSE) Pattern

For custom streaming implementations (like Assistant Architect):

```typescript
export async function POST(req: Request) {
  const encoder = new TextEncoder()
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send initial event
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ 
            type: 'start',
            timestamp: Date.now() 
          })}\n\n`)
        )
        
        // Stream AI response
        const model = await createProviderModel(provider, modelId)
        const result = streamText({
          model,
          messages,
          
          onChunk: ({ chunk }) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ 
                type: 'content',
                content: chunk 
              })}\n\n`)
            )
          },
          
          onFinish: ({ text, usage }) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ 
                type: 'complete',
                usage 
              })}\n\n`)
            )
            controller.close()
          }
        })
        
      } catch (error) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ 
            type: 'error',
            error: error.message 
          })}\n\n`)
        )
        controller.close()
      }
    }
  })
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  })
}
```

## Model Configuration

### Database Schema

Models are stored in the database with provider-specific configurations:

```typescript
interface Model {
  id: number
  name: string
  model_id: string  // Provider-specific ID
  provider: 'openai' | 'google' | 'amazon-bedrock' | 'azure'
  description: string
  context_window: number
  max_output_tokens: number
  input_cost_per_1k: number
  output_cost_per_1k: number
  supports_tools: boolean
  supports_vision: boolean
  is_available_for_chat: boolean
  is_available_for_assistants: boolean
}
```

### Model Selection

```typescript
import { eq } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { models } from "@/lib/db/schema"

// Get available models for chat
const chatModels = await executeQuery(
  (db) => db.select().from(models)
    .where(eq(models.isAvailableForChat, true))
    .orderBy(models.provider, models.name),
  "getChatModels"
)

// Get model configuration
async function getModelConfig(modelId: string) {
  const [model] = await executeQuery(
    (db) => db.select().from(models)
      .where(eq(models.modelId, modelId))
      .limit(1),
    "getModelConfig"
  )
  return model
}
```

## Settings Management

### Database-First Settings

```typescript
import { Settings } from '@/lib/settings-manager'

// Typed setting getters
export const Settings = {
  async getOpenAI(): Promise<string | null> {
    return getSetting('OPENAI_API_KEY')
  },
  
  async getGoogleAI(): Promise<string | null> {
    return getSetting('GOOGLE_API_KEY')
  },
  
  async getBedrock(): Promise<BedrockConfig> {
    const [accessKeyId, secretAccessKey, region] = await Promise.all([
      getSetting('BEDROCK_ACCESS_KEY_ID'),
      getSetting('BEDROCK_SECRET_ACCESS_KEY'),
      getSetting('BEDROCK_REGION')
    ])
    
    return {
      accessKeyId,
      secretAccessKey,
      region: region || 'us-east-1'
    }
  },
  
  async getAzureOpenAI(): Promise<AzureConfig> {
    const [key, resourceName] = await Promise.all([
      getSetting('AZURE_OPENAI_API_KEY'),
      getSetting('AZURE_OPENAI_RESOURCE_NAME')
    ])
    
    return { key, resourceName }
  }
}
```

### Caching Strategy

Settings are cached for 5 minutes to reduce database queries:

```typescript
const CACHE_TTL = 5 * 60 * 1000  // 5 minutes

// Cache cleared automatically after updates
await updateSettingAction('OPENAI_API_KEY', newKey)
// Cache invalidated for this key
```

## Error Handling

### Provider-Specific Errors

```typescript
try {
  const model = await createProviderModel(provider, modelId)
  const result = await streamText({ model, messages })
} catch (error) {
  if (error.code === 'INVALID_API_KEY') {
    log.error('Invalid API key', { provider })
    throw ErrorFactories.sysConfigurationError(`${provider} API key is invalid`)
  }
  
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    log.warn('Rate limit exceeded', { provider })
    throw ErrorFactories.sysRateLimitExceeded(provider)
  }
  
  if (error.code === 'MODEL_NOT_FOUND') {
    log.error('Model not found', { provider, modelId })
    throw ErrorFactories.validationFailed([
      { field: 'modelId', message: `Model ${modelId} not found` }
    ])
  }
  
  // Generic error
  log.error('AI provider error', { provider, error })
  throw ErrorFactories.sysExternalServiceError(provider, error)
}
```

## Token Tracking

### Usage Monitoring

```typescript
const result = await streamText({
  model,
  messages,
  
  onFinish: async ({ usage }) => {
    // Log token usage
    await executeQuery(
      (db) => db.insert(tokenUsage).values({
        userId,
        modelId: modelConfig.id,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cost: calculateCost(usage, modelConfig),
      }),
      "trackTokenUsage"
    )
  }
})

function calculateCost(usage: TokenUsage, model: ModelConfig): number {
  const inputCost = (usage.promptTokens / 1000) * model.input_cost_per_1k
  const outputCost = (usage.completionTokens / 1000) * model.output_cost_per_1k
  return inputCost + outputCost
}
```

## Assistant Architect Integration

### Streaming with Context

```typescript
// Build system prompt with repository context
const systemPrompt = await buildSystemPrompt({
  toolId,
  repositoryIds,
  assistantOwnerSub,
  executionContext
})

// Stream with context
const result = streamText({
  model,
  system: systemPrompt,
  messages: [
    { role: 'user', content: userPrompt }
  ],
  temperature: 0.7,
  maxTokens: 4000
})
```

### Knowledge Retrieval

```typescript
import { getRelevantKnowledge } from '@/lib/assistant-architect/knowledge-retrieval'

// Retrieve relevant context
const knowledge = await getRelevantKnowledge({
  query: userPrompt,
  repositoryIds,
  limit: 10,
  minScore: 0.7
})

// Include in system prompt
const enhancedPrompt = `
${baseSystemPrompt}

Relevant Knowledge:
${knowledge.map(k => k.content).join('\n\n')}
`
```

## Testing AI Features

### Mocking Providers

```typescript
import { vi } from 'vitest'

vi.mock('@/app/api/chat/lib/provider-factory', () => ({
  createProviderModel: vi.fn(() => ({
    // Mock model implementation
    doGenerate: async () => ({
      text: 'Mocked response',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    })
  }))
}))
```

### Integration Tests

```typescript
test('chat endpoint streams response', async () => {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
      modelId: 'gpt-4-turbo',
      provider: 'openai'
    })
  })
  
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  
  let fullResponse = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    fullResponse += decoder.decode(value)
  }
  
  expect(fullResponse).toContain('data:')
})
```

## Best Practices

1. **Always use the provider factory** - Don't instantiate providers directly
2. **Track token usage** - Monitor costs and usage patterns
3. **Handle streaming errors gracefully** - Provide fallback responses
4. **Cache model configurations** - Reduce database queries
5. **Use structured outputs** when you need typed responses
6. **Set appropriate temperatures** - Lower for factual, higher for creative
7. **Implement retry logic** for transient failures
8. **Sanitize user inputs** before sending to AI
9. **Monitor response times** and set appropriate timeouts
10. **Test with mocked providers** to avoid API costs in tests

## Common Issues

### Issue: API Key Not Found
```typescript
// Solution: Check settings management
const apiKey = await Settings.getOpenAI()
if (!apiKey) {
  // Check database settings table
  // Fall back to environment variables
  // Provide clear error message
}
```

### Issue: Streaming Timeout
```typescript
// Solution: Set appropriate timeout
export const maxDuration = 30  // seconds

// Or use AbortController
const controller = new AbortController()
setTimeout(() => controller.abort(), 30000)

const result = streamText({
  model,
  messages,
  abortSignal: controller.signal
})
```

### Issue: Token Limit Exceeded
```typescript
// Solution: Truncate or summarize context
const MAX_CONTEXT_TOKENS = 8000

function truncateMessages(messages: Message[], maxTokens: number) {
  // Implementation to keep most recent/relevant messages
  // within token limit
}
```

---

*For provider-specific documentation, refer to the respective AI SDK packages.*