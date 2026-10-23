import { createOpenAI } from '@ai-sdk/openai';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { AwsClient } from 'aws4fetch';
import { Settings } from '@/lib/settings-manager';
import { createLogger } from '@/lib/logger';

const log = createLogger({ module: 'bedrock-openai' });

/**
 * OpenAI GPT models served by Amazon Bedrock (`us.openai.gpt-5.5`,
 * `openai.gpt-6-sol`, ...). These are reached through the OpenAI Responses API
 * that bedrock-runtime exposes at `/openai/v1`, NOT through Converse: Converse
 * rejects `document` blocks for these models (Responses takes `input_file`),
 * and the AI SDK's Bedrock provider only maps reasoning effort for bare
 * `openai.` IDs, never for the `us.` inference profiles these models require.
 *
 * gpt-oss is excluded on purpose — it is not a Responses-API model family and
 * keeps the Converse path.
 */
const BEDROCK_OPENAI_MODEL_PATTERN = /(?:^|\.)openai\.gpt-(?!oss)/i;

/**
 * bedrock-mantle also serves this API (and adds hosted web search), but we were
 * told by AWS it is expected to be retired; bedrock-runtime is the endpoint AWS
 * recommends for new applications. Runtime only accepts
 * cross-Region inference profile IDs (`us.openai.*`) for these models — the
 * bare `openai.*` ID fails with "on-demand throughput isn't supported".
 */
const runtimeBaseURL = (region: string) =>
  `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;

/**
 * `createOpenAI` requires an API key and sends it as a Bearer header. Bedrock
 * authenticates by SigV4 instead, so the header is stripped before signing.
 */
const SIGV4_PLACEHOLDER_API_KEY = 'bedrock-sigv4';

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

// Memoized by the SDK: credentials are cached and refreshed before expiry.
let defaultCredentialChain: (() => Promise<AwsCredentials>) | undefined;

export function isBedrockOpenAIModel(modelId: string): boolean {
  return BEDROCK_OPENAI_MODEL_PATTERN.test(modelId);
}

/**
 * Provider options the streaming adapter adds for Bedrock-hosted GPT requests.
 * Mirrors the direct OpenAI adapter's reasoning-effort default.
 */
export function getBedrockOpenAIProviderOptions(
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
): Record<string, unknown> {
  return {
    openai: {
      reasoningEffort: reasoningEffort || 'medium'
    }
  };
}

/**
 * Applied to every request, whichever caller builds it (streaming adapter,
 * `createProviderModel` + `generateText`, ...); a caller's own value wins.
 *
 * `store: false` keeps each request self-contained: prior reasoning is replayed
 * inline instead of as `item_reference`s to server-stored items. A `us.`
 * inference profile routes each request to any member Region, so a reference
 * to an item stored by an earlier request is not guaranteed to resolve.
 *
 * `forceReasoning: true` because the OpenAI provider detects reasoning models
 * by ID prefix (`gpt-5`, `o3`, ...). `us.openai.gpt-5.5` matches none of them,
 * so without it the provider silently drops `reasoningEffort`, sends the
 * system prompt with the `system` role instead of `developer`, and forwards
 * sampling parameters that reasoning models reject.
 */
const BEDROCK_OPENAI_DEFAULTS = defaultSettingsMiddleware({
  settings: { providerOptions: { openai: { store: false, forceReasoning: true } } }
});

function createSigV4Fetch(
  region: string,
  getCredentials: () => Promise<AwsCredentials>
): typeof fetch {
  return async (input, init) => {
    const credentials = await getCredentials();
    const signer = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      service: 'bedrock',
      region,
      // The AI SDK owns retries; aws4fetch would otherwise retry 10 times.
      retries: 0
    });
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    const url = input instanceof Request ? input.url : input.toString();
    return signer.fetch(url, { ...init, headers });
  };
}

/**
 * Creates a Bedrock-hosted OpenAI GPT model on the Responses API.
 *
 * Credentials mirror the Converse path: stored Bedrock keys outside Lambda
 * (local development and any deployment that configures them), otherwise the
 * default AWS credential chain (ECS task role, Lambda role, SSO profile).
 */
export async function createBedrockOpenAIModel(modelId: string): Promise<LanguageModel> {
  const config = await Settings.getBedrock();
  const region = config.region || 'us-east-1';
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const accessKeyId = config.accessKeyId;
  const secretAccessKey = config.secretAccessKey;
  const useStoredKeys = !isLambda && !!accessKeyId && !!secretAccessKey;

  log.debug('Creating Bedrock OpenAI model', {
    modelId,
    region,
    credentialSource: useStoredKeys ? 'stored-keys' : 'default-chain'
  });

  const getCredentials: () => Promise<AwsCredentials> =
    useStoredKeys && accessKeyId && secretAccessKey
      ? async () => ({ accessKeyId, secretAccessKey })
      : (defaultCredentialChain ??= fromNodeProviderChain());

  const client = createOpenAI({
    name: 'amazon-bedrock-openai',
    baseURL: runtimeBaseURL(region),
    apiKey: SIGV4_PLACEHOLDER_API_KEY,
    fetch: createSigV4Fetch(region, getCredentials)
  });

  return wrapLanguageModel({
    model: client.responses(modelId),
    middleware: BEDROCK_OPENAI_DEFAULTS
  });
}
