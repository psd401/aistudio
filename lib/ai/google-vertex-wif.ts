/**
 * Keyless Vertex AI auth for the web app: AWS → Google workload identity
 * federation (standard 14, AI services: no Gemini API key where Vertex AI
 * offers a keyless path).
 *
 * The ECS task role signs an sts:GetCallerIdentity request, Google STS
 * exchanges it at the `vertex-ai` provider of the `aws-agent-broker` pool, and
 * the federated token impersonates `aistudio-vertex@psd-aistudio-{env}`, which
 * holds roles/aiplatform.user on that project only. The Google side (provider
 * condition pinned to the exact task role names, workloadIdentityUser per env)
 * lives in psd401/psd-gcp-infra vertex-ai.tf.
 *
 * AWS credentials come from the AWS SDK default chain, not from
 * google-auth-library's built-in AWS source: that one reads only the
 * AWS_ACCESS_KEY_* env vars or EC2 IMDS and never the ECS Fargate task
 * credentials (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI). Same approach as
 * infra/lambdas/shared/google-chat-wif.ts (#1989).
 */
import { AwsClient } from 'google-auth-library';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

export const VERTEX_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Interactions API (Deep Research) is served from the global location. */
export const VERTEX_INTERACTIONS_LOCATION = 'global';

const ENV_NAMES = [
  'GOOGLE_VERTEX_WIF_AUDIENCE',
  'GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_VERTEX_PROJECT_ID',
] as const;

export interface VertexWifConfig {
  audience: string;
  serviceAccountEmail: string;
  projectId: string;
  region: string;
}

/**
 * Read the Vertex WIF config. Returns null when none of the three variables is
 * set (local development without WIF); throws when only some are set, so a
 * half-configured deploy fails closed instead of quietly using another path.
 */
export function readVertexWifConfig(env: Record<string, string | undefined> = process.env): VertexWifConfig | null {
  const values = ENV_NAMES.map((name) => env[name]?.trim() || '');
  if (values.every((v) => !v)) return null;
  const missing = ENV_NAMES.filter((_, i) => !values[i]);
  if (missing.length > 0) {
    throw new Error(`Vertex AI auth is partly configured; missing ${missing.join(', ')}`);
  }
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (!region) {
    throw new Error('AWS_REGION is not configured; Vertex AI auth cannot start');
  }
  const [audience, serviceAccountEmail, projectId] = values;
  return { audience, serviceAccountEmail, projectId, region };
}

let cached: { key: string; client: AwsClient } | undefined;

/** One AwsClient per process and config; it refreshes its own tokens. */
export function getVertexWifAuthClient(config: VertexWifConfig): AwsClient {
  const key = `${config.audience}|${config.serviceAccountEmail}|${config.region}`;
  if (cached?.key === key) return cached.client;

  const awsCredentials = fromNodeProviderChain();
  const client = new AwsClient({
    audience: config.audience,
    subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
    service_account_impersonation_url:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
      `${config.serviceAccountEmail}:generateAccessToken`,
    scopes: [VERTEX_CLOUD_PLATFORM_SCOPE],
    aws_security_credentials_supplier: {
      getAwsRegion: async () => config.region,
      getAwsSecurityCredentials: async () => {
        const credentials = await awsCredentials();
        return {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          token: credentials.sessionToken,
        };
      },
    },
  });
  cached = { key, client };
  return client;
}

/** Test-only: drop the cached client. */
export function __resetVertexWifCacheForTests(): void {
  cached = undefined;
}
