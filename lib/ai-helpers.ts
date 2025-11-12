import { 
  generateText, 
  generateObject,
  embed,
  embedMany,
  tool,
  CoreMessage,
  StreamTextResult,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError,
  LanguageModel,
  UIMessage
} from 'ai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import logger from "@/lib/logger"
import { createProviderModel } from '@/lib/ai/provider-factory'
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service'
import type { StreamRequest } from '@/lib/streaming/types'

interface ModelConfig {
  provider: string
  modelId: string
}

export interface StreamingOptions {
  onToken?: (token: string) => void
  onFinish?: (result: unknown) => void
  onError?: (error: Error) => void
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  execute: (input: unknown) => Promise<unknown>
}

// Get the appropriate model client based on provider
// Now uses the centralized provider factory for consistency
async function getModelClient(modelConfig: ModelConfig): Promise<LanguageModel> {
  logger.info('[ai-helpers] Getting model client via provider factory', {
    provider: modelConfig.provider,
    modelId: modelConfig.modelId
  });
  
  try {
    const model = await createProviderModel(modelConfig.provider, modelConfig.modelId);
    logger.info('[ai-helpers] Model client created successfully');
    return model;
  } catch (error) {
    logger.error('[ai-helpers] Failed to get model client:', {
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

// Generate a text completion
export async function generateCompletion(
  modelConfig: ModelConfig,
  messages: CoreMessage[],
  tools?: Record<string, unknown>
) {
  const model = await getModelClient(modelConfig);
  
  try {
    const result = await generateText({
      model,
      messages,
      tools: tools as Parameters<typeof generateText>[0]['tools'],
      maxRetries: tools ? 5 : undefined // Allow multi-step tool calling
    });

    if (!result.text) {
      throw new Error(`No content returned from ${modelConfig.provider}`);
    }

    return result.text;
  } catch (error) {
    // Handle specific AI SDK errors
    if (error instanceof NoSuchToolError) {
      logger.error('[generateCompletion] Tool not found:', error.toolName);
      throw new Error(`AI tried to use unknown tool: ${error.toolName}`);
    } else if (error instanceof InvalidToolInputError) {
      logger.error('[generateCompletion] Invalid tool arguments:', error);
      throw new Error(`Invalid arguments for tool: ${error.message}`);
    } else if (error instanceof Error && error.name === 'ToolExecutionError') {
      logger.error('[generateCompletion] Tool execution failed:', error);
      throw new Error(`Tool execution failed: ${error.message}`);
    }
    
    throw error;
  }
}

// Stream a text completion using unified streaming service
export async function streamCompletion(
  modelConfig: ModelConfig,
  messages: CoreMessage[],
  options?: StreamingOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<StreamTextResult<any, any>> {
  logger.info('[streamCompletion] Using unified streaming service', {
    provider: modelConfig.provider,
    modelId: modelConfig.modelId,
    hasTools: !!tools
  });
  
  try {
    // Convert CoreMessage to UIMessage format for unified streaming
    const uiMessages: UIMessage[] = messages.map((msg, index) => ({
      id: `msg-${index}`,
      role: msg.role as 'user' | 'assistant' | 'system',
      parts: [{
        type: 'text',
        text: typeof msg.content === 'string' 
          ? msg.content 
          : JSON.stringify(msg.content)
      }]
    }));
    
    // Create stream request for unified service
    const streamRequest: StreamRequest = {
      messages: uiMessages,
      modelId: modelConfig.modelId,
      provider: modelConfig.provider,
      source: 'ai-helpers', // Identify the source
      userId: 'system', // For system-level calls
      sessionId: 'system',
      callbacks: {
        onProgress: (event) => {
          if (event.type === 'token' && options?.onToken && event.text) {
            options.onToken(event.text);
          }
        },
        onFinish: async (data) => {
          if (options?.onFinish) {
            options.onFinish(data);
          }
        },
        onError: (error) => {
          if (options?.onError) {
            options.onError(error);
          }
        }
      }
    };
    
    // Note: The unified streaming service doesn't directly support tools yet
    // For now, we'll fall back to the provider's native implementation when tools are needed
    if (tools) {
      logger.warn('[streamCompletion] Tools not yet supported in unified streaming, using fallback');
      const model = await getModelClient(modelConfig);
      const { streamText } = await import('ai');
      return streamText({
        model,
        messages,
        tools,
        maxRetries: 5,
        onChunk: ({ chunk }) => {
          if (chunk.type === 'text-delta' && options?.onToken) {
            options.onToken((chunk as { text?: string }).text || '');
          }
        },
        onFinish: options?.onFinish
      });
    }
    
    // Use unified streaming service for non-tool calls
    const response = await unifiedStreamingService.stream(streamRequest);
    // The response.result is already a StreamTextResult-compatible object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return response.result as unknown as StreamTextResult<any, any>;
    
  } catch (error) {
    logger.error('[streamCompletion] Error during unified streaming:', error);
    throw error;
  }
}

// Generate a structured object
export async function generateStructuredOutput<T>(
  modelConfig: ModelConfig,
  messages: CoreMessage[],
  schema: z.ZodType<T>
): Promise<T> {
  const model = await getModelClient(modelConfig);
  
  const result = await generateObject({
    model,
    messages,
    schema,
    output: 'object'
    // Type casting needed for complex generic type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return result.object as T;
}

// Helper to create a tool from a definition
export function createTool(definition: ToolDefinition): unknown {
  return tool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: definition.execute
  });
}

// Export error types for consumers
export {
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallRepairError
};

// Embedding configuration interface
export interface EmbeddingConfig {
  provider: string
  modelId: string
  dimensions: number
  maxTokens: number
  batchSize: number
}

// Get embedding configuration from settings
export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  const { getSettings } = await import('@/lib/settings-manager');
  const settings = await getSettings([
    'EMBEDDING_MODEL_PROVIDER',
    'EMBEDDING_MODEL_ID', 
    'EMBEDDING_DIMENSIONS',
    'EMBEDDING_MAX_TOKENS',
    'EMBEDDING_BATCH_SIZE'
  ])
  
  if (!settings['EMBEDDING_MODEL_PROVIDER'] || !settings['EMBEDDING_MODEL_ID']) {
    throw new Error('Embedding configuration not found in settings')
  }
  
  return {
    provider: settings['EMBEDDING_MODEL_PROVIDER'],
    modelId: settings['EMBEDDING_MODEL_ID'],
    dimensions: Number.parseInt(settings['EMBEDDING_DIMENSIONS'] || '1536', 10),
    maxTokens: Number.parseInt(settings['EMBEDDING_MAX_TOKENS'] || '8192', 10),
    batchSize: Number.parseInt(settings['EMBEDDING_BATCH_SIZE'] || '100', 10)
  }
}

// Get embedding model client
// Note: Embedding models need special handling, so we keep some provider-specific logic here
// But we reuse settings from the centralized settings-manager
async function getEmbeddingModelClient(config: ModelConfig) {
  const { Settings } = await import('@/lib/settings-manager');
  
  logger.info('[ai-helpers] Getting embedding model client', {
    provider: config.provider,
    modelId: config.modelId
  });
  
  switch (config.provider) {
    case 'openai': {
      const openAIKey = await Settings.getOpenAI();
      
      if (!openAIKey) {
        throw new Error('OpenAI API key not configured');
      }
      
      const openai = createOpenAI({
        apiKey: openAIKey
      });
      
      // Type casting needed for AI SDK v5 compatibility
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return openai.embedding(config.modelId) as any;
    }
    
    case 'amazon-bedrock': {
      try {
        const bedrockConfig = await Settings.getBedrock();
        
        const bedrockOptions: Parameters<typeof createAmazonBedrock>[0] = {
          region: bedrockConfig.region || 'us-east-1'
        };
        
        // In AWS Lambda, use IAM role credentials
        const isAwsLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
        
        if (bedrockConfig.accessKeyId && bedrockConfig.secretAccessKey && !isAwsLambda) {
          // Only use stored credentials for local development
          bedrockOptions.accessKeyId = bedrockConfig.accessKeyId;
          bedrockOptions.secretAccessKey = bedrockConfig.secretAccessKey;
        }
        
        const bedrock = createAmazonBedrock(bedrockOptions);
        const embeddingModel = bedrock.embedding(config.modelId);
        
        logger.info('[ai-helpers] Embedding model created successfully');
        // Type casting needed for AI SDK v5 compatibility
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return embeddingModel as any;
      } catch (error) {
        logger.error('[ai-helpers] Failed to create embedding model:', {
          modelId: config.modelId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
    
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`)
  }
}

// Generate embedding for a single text
export async function generateEmbedding(
  text: string,
  config?: Partial<EmbeddingConfig>
): Promise<number[]> {
  const embeddingConfig = config ? { ...await getEmbeddingConfig(), ...config } : await getEmbeddingConfig()
  
  const modelConfig: ModelConfig = {
    provider: embeddingConfig.provider,
    modelId: embeddingConfig.modelId
  }
  
  const model = await getEmbeddingModelClient(modelConfig)
  
  try {
    const result = await embed({
      model,
      value: text
    })
    
    return Array.from(result.embedding)
  } catch (error) {
    logger.error('[generateEmbedding] Error generating embedding:', error)
    throw new Error(`Failed to generate embedding: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Generate embeddings for multiple texts (batch processing)
export async function generateEmbeddings(
  texts: string[],
  config?: Partial<EmbeddingConfig>
): Promise<number[][]> {
  const embeddingConfig = config ? { ...await getEmbeddingConfig(), ...config } : await getEmbeddingConfig()
  
  const modelConfig: ModelConfig = {
    provider: embeddingConfig.provider,
    modelId: embeddingConfig.modelId
  }
  
  const model = await getEmbeddingModelClient(modelConfig)
  
  try {
    // Process in batches according to configured batch size
    const embeddings: number[][] = []
    const batchSize = embeddingConfig.batchSize
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      
      const result = await embedMany({
        model,
        values: batch
      })
      
      // Convert embeddings to arrays of numbers
      embeddings.push(...result.embeddings.map(embedding => Array.from(embedding)))
    }
    
    return embeddings
  } catch (error) {
    logger.error('[generateEmbeddings] Error generating embeddings:', error)
    throw new Error(`Failed to generate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

// Calculate cosine similarity between two embeddings
export function cosineSimilarity(embedding1: number[], embedding2: number[]): number {
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same length')
  }
  
  let dotProduct = 0
  let norm1 = 0
  let norm2 = 0
  
  for (const [i, element] of embedding1.entries()) {
    dotProduct += element * embedding2[i]
    norm1 += element * element
    norm2 += embedding2[i] * embedding2[i]
  }
  
  norm1 = Math.sqrt(norm1)
  norm2 = Math.sqrt(norm2)
  
  if (norm1 === 0 || norm2 === 0) {
    return 0
  }
  
  return dotProduct / (norm1 * norm2)
}

// Find most similar embeddings
export function findMostSimilar(
  queryEmbedding: number[],
  embeddings: Array<{ id: string | number; embedding: number[] }>,
  topK: number = 10
): Array<{ id: string | number; similarity: number }> {
  const similarities = embeddings.map(item => ({
    id: item.id,
    similarity: cosineSimilarity(queryEmbedding, item.embedding)
  }))
  
  // Sort by similarity descending and take top K
  return similarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
} 