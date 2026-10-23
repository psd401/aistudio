import { createOpenAI } from '@ai-sdk/openai';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { AwsClient } from 'aws4fetch';
import { Settings } from '@/lib/settings-manager';
import { getBedrockCredentialProvider, type AwsCredentials } from '@/lib/ai/bedrock-credentials';
import { createLogger } from '@/lib/logger';
import { getAIModelByModelId } from '@/lib/db/drizzle';
import { MODEL_REASONING_EFFORTS, type ModelReasoningEffort } from '@/lib/db/types/jsonb';

export { isBedrockOpenAIModel } from './bedrock-openai-model-id';

const log = createLogger({ module: 'bedrock-openai' });

/**
 * OpenAI GPT models served by Amazon Bedrock (`us.openai.gpt-5.5`,
 * `openai.gpt-6-sol`, ...; matched by `isBedrockOpenAIModel`). These are reached
 * through the OpenAI Responses API that bedrock-runtime exposes at
 * `/openai/v1`, NOT through Converse: Converse rejects `document` blocks for
 * these models (Responses takes `input_file`), and the AI SDK's Bedrock
 * provider only maps reasoning effort for bare `openai.` IDs, never for the
 * `us.` inference profiles these models require.
 */

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
const UNUSED_BEARER_VALUE = 'unused';

export type BedrockOpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return MODEL_REASONING_EFFORTS.includes(value as ModelReasoningEffort);
}

/**
 * The admin-set default effort for a model row
 * (`ai_models.provider_metadata.defaultReasoningEffort`), or undefined.
 *
 * Fails open to undefined — the model's own default — so a lookup problem
 * never blocks a request.
 */
async function getModelDefaultReasoningEffort(
  modelId: string
): Promise<ModelReasoningEffort | undefined> {
  try {
    const row = await getAIModelByModelId(modelId);
    const value = row?.providerMetadata?.defaultReasoningEffort;
    return isModelReasoningEffort(value) ? value : undefined;
  } catch (error) {
    log.warn('Could not read model default reasoning effort; using the model default', {
      modelId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

/**
 * Defaults applied to every request, whichever caller builds it (streaming
 * adapter, `createProviderModel` + `generateText`, ...); a caller's own
 * provider options still win.
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
 *
 * `reasoningEffort` is bound here, on the model, because the shared streaming
 * path (`BaseProviderAdapter.streamWithEnhancements`) does not forward an
 * adapter's `getProviderOptions()` to `streamText()`. When it is undefined
 * nothing is sent and the model uses its own default (GPT-5.4: none; GPT-5.5,
 * 5.6 and 6.x: medium).
 */
function bedrockOpenAIDefaults(reasoningEffort?: BedrockOpenAIReasoningEffort) {
  return defaultSettingsMiddleware({
    settings: {
      providerOptions: {
        openai: {
          store: false,
          forceReasoning: true,
          ...(reasoningEffort && { reasoningEffort })
        }
      }
    }
  });
}

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
 * Credentials come from `getBedrockCredentialProvider`, shared with the
 * Converse path: stored Bedrock keys outside Lambda, otherwise the default AWS
 * credential chain (ECS task role, Lambda role, SSO profile).
 */
export async function createBedrockOpenAIModel(
  modelId: string,
  options?: { reasoningEffort?: BedrockOpenAIReasoningEffort }
): Promise<LanguageModel> {
  const config = await Settings.getBedrock();
  const region = config.region || 'us-east-1';
  // A request's own effort wins; otherwise the model row's admin default;
  // otherwise nothing, so the model applies its own default.
  const reasoningEffort =
    options?.reasoningEffort ?? (await getModelDefaultReasoningEffort(modelId));
  const { source, credentialProvider } = getBedrockCredentialProvider(config);

  log.debug('Creating Bedrock OpenAI model', {
    modelId,
    region,
    credentialSource: source,
    reasoningEffort: reasoningEffort ?? 'model-default'
  });

  const client = createOpenAI({
    name: 'amazon-bedrock-openai',
    baseURL: runtimeBaseURL(region),
    apiKey: UNUSED_BEARER_VALUE,
    fetch: createSigV4Fetch(region, credentialProvider)
  });

  return wrapLanguageModel({
    model: client.responses(modelId),
    middleware: bedrockOpenAIDefaults(reasoningEffort)
  });
}
