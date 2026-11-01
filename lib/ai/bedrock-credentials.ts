import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type BedrockCredentialSource = 'stored-keys' | 'default-chain';

// Memoized by the SDK: credentials are cached and refreshed before expiry.
let defaultCredentialChain: (() => Promise<AwsCredentials>) | undefined;

/**
 * Resolves the credentials every Bedrock client in the app signs with.
 *
 * Stored `BEDROCK_ACCESS_KEY_ID` / `BEDROCK_SECRET_ACCESS_KEY` settings win
 * outside Lambda (local development, or any deployment that configures them).
 * Otherwise the default AWS credential chain is used: the ECS task role, the
 * Lambda role, or a local SSO profile.
 *
 * The chain must be passed explicitly. Without a `credentialProvider`, the AI
 * SDK's Bedrock provider only reads the `AWS_ACCESS_KEY_ID` env vars, which
 * Lambda sets but ECS does not — so ECS with no stored keys would fail to sign.
 */
export function getBedrockCredentialProvider(config: {
  accessKeyId: string | null;
  secretAccessKey: string | null;
}): { source: BedrockCredentialSource; credentialProvider: () => Promise<AwsCredentials> } {
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const { accessKeyId, secretAccessKey } = config;

  if (!isLambda && accessKeyId && secretAccessKey) {
    return {
      source: 'stored-keys',
      credentialProvider: async () => ({ accessKeyId, secretAccessKey })
    };
  }

  return {
    source: 'default-chain',
    credentialProvider: (defaultCredentialChain ??= fromNodeProviderChain())
  };
}
