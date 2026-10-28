/**
 * Keyless Google Chat app auth: AWS → Google workload identity federation
 * (issue #1989). Replaces the service-account JSON key that used to sit in
 * Secrets Manager (`psd-agent-google-sa-{env}`).
 *
 * The caller's AWS role signs an sts:GetCallerIdentity request, Google STS
 * exchanges it at the `chat-app` provider of the `aws-agent-broker` pool, and
 * the federated token impersonates the env's Chat app service account with
 * scope `chat.bot`. The Google side (provider condition pinned to the exact
 * Chat-calling role names, plus workloadIdentityUser on each env's chat SA)
 * lives in psd401/psd-gcp-infra (chat-app-wif.tf).
 *
 * AWS credentials come from the AWS SDK's own default chain (the same
 * defaultProvider the router already signs AgentCore calls with), not from
 * google-auth-library's built-in AWS source: that one reads only the
 * AWS_ACCESS_KEY_* env vars or EC2 IMDS, so it works on Lambda but fails on
 * the ECS Fargate job-runner, whose task credentials arrive through
 * AWS_CONTAINER_CREDENTIALS_RELATIVE_URI. The supplier below only hands those
 * credentials over; signing, the token exchange and impersonation all stay
 * inside google-auth-library.
 *
 * NOTE: Each Lambda has an isolated build context that prevents
 * cross-directory imports, so this file is copied byte-for-byte into
 * agent-router, agent-cron, agent-triage-poll and agent-triage-digest. The
 * canonical source is infra/lambdas/shared/google-chat-wif.ts;
 * tests/unit/google-chat-wif-mirrors.test.ts fails if any copy drifts.
 */
import * as chatPkg from '@googleapis/chat';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

export const GOOGLE_CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

export interface AwsCredentialsLike {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface GoogleChatWifOptions {
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests; defaults to the AWS SDK default chain. */
  awsCredentials?: () => Promise<AwsCredentialsLike>;
}

export type GoogleChatWifAuth = InstanceType<typeof chatPkg.auth.AwsClient>;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured; Google Chat auth cannot start`);
  }
  return value;
}

export function createGoogleChatWifAuth(
  options: GoogleChatWifOptions = {}
): GoogleChatWifAuth {
  const env = options.env ?? process.env;
  const audience = requireEnv(env, 'GOOGLE_CHAT_WIF_AUDIENCE');
  const serviceAccountEmail = requireEnv(
    env,
    'GOOGLE_CHAT_SERVICE_ACCOUNT_EMAIL'
  );
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (!region) {
    throw new Error('AWS_REGION is not configured; Google Chat auth cannot start');
  }
  const awsCredentials = options.awsCredentials ?? defaultProvider();

  return new chatPkg.auth.AwsClient({
    audience,
    subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
    service_account_impersonation_url:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
      `${serviceAccountEmail}:generateAccessToken`,
    scopes: [GOOGLE_CHAT_BOT_SCOPE],
    aws_security_credentials_supplier: {
      getAwsRegion: async () => region,
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
}
