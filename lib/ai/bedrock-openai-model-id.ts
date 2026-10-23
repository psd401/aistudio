/**
 * OpenAI GPT models served by Amazon Bedrock (`us.openai.gpt-5.5`,
 * `openai.gpt-6-sol`, ...). Kept free of server imports so client components
 * (the admin model form) can use it too.
 *
 * gpt-oss is excluded on purpose — it is not a Responses-API model family and
 * keeps the Converse path.
 */
const BEDROCK_OPENAI_MODEL_PATTERN = /(?:^|\.)openai\.gpt-(?!oss)/i;

export function isBedrockOpenAIModel(modelId: string): boolean {
  return BEDROCK_OPENAI_MODEL_PATTERN.test(modelId);
}
