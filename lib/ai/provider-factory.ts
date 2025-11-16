import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { google } from '@ai-sdk/google';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';
import { createLogger } from '@/lib/logger';
import { LanguageModel } from 'ai';
import { getProviderAdapter, type ProviderCapabilities } from '@/lib/streaming/provider-adapters';

const log = createLogger({ module: 'provider-factory' });

/**
 * Creates a provider-specific model instance
 * Extensible design for easy addition of new providers
 */
export async function createProviderModel(provider: string, modelId: string): Promise<LanguageModel> {
  log.info(`Creating model for provider: ${provider}, modelId: ${modelId}`);

  // Add validation
  if (!provider) {
    log.error('Provider is undefined or null');
    throw ErrorFactories.validationFailed([
      { field: 'provider', message: 'Provider is required but was undefined' }
    ]);
  }

  if (!modelId) {
    log.error('ModelId is undefined or null');
    throw ErrorFactories.validationFailed([
      { field: 'modelId', message: 'ModelId is required but was undefined' }
    ]);
  }

  // Ensure provider is lowercase for comparison
  const normalizedProvider = provider.toLowerCase();

  switch (normalizedProvider) {
    case 'openai':
      return await createOpenAIModel(modelId);
    case 'google':
      return await createGoogleModel(modelId);
    case 'amazon-bedrock':
      return await createBedrockModel(modelId);
    case 'azure':
      return await createAzureModel(modelId);
    case 'latimer':
      return await createLatimerModel(modelId);
    default:
      log.error(`Unsupported provider: ${provider}`);
      throw ErrorFactories.validationFailed([
        { field: 'provider', message: `Provider '${provider}' is not supported` }
      ]);
  }
}

/**
 * OpenAI Provider - Supports GPT-5, GPT-4, GPT-3.5, etc.
 */
async function createOpenAIModel(modelId: string): Promise<LanguageModel> {
  try {
    const apiKey = await Settings.getOpenAI();
    if (!apiKey) {
      log.error('OpenAI API key not configured');
      throw ErrorFactories.sysConfigurationError('OpenAI API key not configured');
    }

    // Ensure apiKey is a string (not null or undefined)
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      log.error('Invalid OpenAI API key format', { keyType: typeof apiKey });
      throw ErrorFactories.sysConfigurationError('OpenAI API key is invalid or empty');
    }

    log.debug(`Creating OpenAI model: ${modelId}`);
    const openai = createOpenAI({ apiKey });
    return openai(modelId);
  } catch (error) {
    log.error('Failed to create OpenAI model', {
      modelId,
      error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}

/**
 * Google AI Provider - Supports Gemini models
 */
async function createGoogleModel(modelId: string): Promise<LanguageModel> {
  try {
    const apiKey = await Settings.getGoogleAI();
    if (!apiKey) {
      log.error('Google API key not configured');
      throw ErrorFactories.sysConfigurationError('Google API key not configured');
    }

    log.debug(`Creating Google model: ${modelId}`);
    // Set environment variable for Google SDK
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    return google(modelId);
  } catch (error) {
    log.error('Failed to create Google model', { modelId, error });
    throw error;
  }
}

/**
 * Amazon Bedrock Provider - Supports Claude, Llama, and other Bedrock models
 */
async function createBedrockModel(modelId: string): Promise<LanguageModel> {
  try {
    const config = await Settings.getBedrock();
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

    log.debug(`Creating Bedrock model: ${modelId}`, {
      hasAccessKey: !!config.accessKeyId,
      hasSecretKey: !!config.secretAccessKey,
      region: config.region || 'us-east-1',
      isLambda
    });

    const bedrockOptions: Parameters<typeof createAmazonBedrock>[0] = {
      region: config.region || 'us-east-1'
    };

    // Only use explicit credentials for local development
    // In Lambda, use IAM role credentials
    if (!isLambda && config.accessKeyId && config.secretAccessKey) {
      log.debug('Using explicit credentials for local development');
      bedrockOptions.accessKeyId = config.accessKeyId;
      bedrockOptions.secretAccessKey = config.secretAccessKey;
    } else {
      log.debug('Using default AWS credential chain');
      // Let SDK use the default credential provider chain
      // This works with IAM roles in Lambda
    }

    const bedrock = createAmazonBedrock(bedrockOptions);
    return bedrock(modelId);
  } catch (error) {
    log.error('Failed to create Bedrock model', { modelId, error });
    throw error;
  }
}

/**
 * Azure OpenAI Provider
 */
async function createAzureModel(modelId: string): Promise<LanguageModel> {
  try {
    const config = await Settings.getAzureOpenAI();
    if (!config.key || !config.resourceName) {
      log.error('Azure OpenAI not configured');
      throw ErrorFactories.sysConfigurationError('Azure OpenAI not configured');
    }

    log.debug(`Creating Azure model: ${modelId}`);
    const azure = createAzure({
      apiKey: config.key,
      resourceName: config.resourceName
    });
    return azure(modelId);
  } catch (error) {
    log.error('Failed to create Azure model', { modelId, error });
    throw error;
  }
}

/**
 * Latimer AI Provider - OpenAI-compatible API
 * Delegates to LatimerAdapter to avoid code duplication
 */
async function createLatimerModel(modelId: string): Promise<LanguageModel> {
  try {
    log.debug(`Creating Latimer model: ${modelId}`);
    const adapter = await getProviderAdapter('latimer');
    return await adapter.createModel(modelId);
  } catch (error) {
    log.error('Failed to create Latimer model', { modelId, error });
    throw error;
  }
}

/**
 * Helper to validate if a provider is supported
 */
export function isSupportedProvider(provider: string): boolean {
  return ['openai', 'google', 'amazon-bedrock', 'azure', 'latimer'].includes(provider);
}

/**
 * Get list of supported providers
 */
export function getSupportedProviders(): string[] {
  return ['openai', 'google', 'amazon-bedrock', 'azure', 'latimer'];
}

/**
 * Enhanced provider model creation with capabilities detection
 * Returns both the model and its capabilities for the unified streaming system
 */
export async function createProviderModelWithCapabilities(
  provider: string,
  modelId: string,
  options?: {
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    responseMode?: 'standard' | 'flex' | 'priority';
    backgroundMode?: boolean;
    thinkingBudget?: number;
  }
): Promise<{ model: LanguageModel; capabilities: ProviderCapabilities }> {
  log.info(`Creating enhanced model for provider: ${provider}, modelId: ${modelId}`, {
    provider,
    modelId,
    options
  });

  // Get the provider adapter for enhanced capabilities
  const adapter = await getProviderAdapter(provider);

  // Create the model using the adapter
  const model = await adapter.createModel(modelId, options);

  // Get model capabilities
  const capabilities = adapter.getCapabilities(modelId);

  log.debug('Model created with capabilities', {
    provider,
    modelId,
    supportsReasoning: capabilities.supportsReasoning,
    supportsThinking: capabilities.supportsThinking,
    maxTimeoutMs: capabilities.maxTimeoutMs
  });

  return { model, capabilities };
}

/**
 * Get model capabilities without creating the model
 * Useful for frontend model selection and configuration
 */
export async function getModelCapabilities(provider: string, modelId: string): Promise<ProviderCapabilities> {
  const adapter = await getProviderAdapter(provider);
  return adapter.getCapabilities(modelId);
}

/**
 * Check if a specific model supports reasoning features
 */
export async function supportsReasoning(provider: string, modelId: string): Promise<boolean> {
  const capabilities = await getModelCapabilities(provider, modelId);
  return capabilities.supportsReasoning;
}

/**
 * Check if a specific model supports thinking features (Claude)
 */
export async function supportsThinking(provider: string, modelId: string): Promise<boolean> {
  const capabilities = await getModelCapabilities(provider, modelId);
  return capabilities.supportsThinking;
}

/**
 * Get recommended timeout for a model based on its capabilities
 */
export async function getRecommendedTimeout(provider: string, modelId: string): Promise<number> {
  const capabilities = await getModelCapabilities(provider, modelId);
  return capabilities.maxTimeoutMs;
}
