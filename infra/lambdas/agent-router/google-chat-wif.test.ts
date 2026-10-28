/**
 * Unit tests for keyless Google Chat auth (#1989).
 *
 * What these lock down: the client federates to the chat-app provider,
 * impersonates the configured Chat service account with ONLY the chat.bot
 * scope, and signs its AWS proof with credentials from the injected AWS
 * provider (the Fargate job-runner's path), never a JSON key. Everything here
 * runs offline: retrieveSubjectToken only signs a GetCallerIdentity request.
 */
import { describe, expect, test } from 'bun:test';
import {
  GOOGLE_CHAT_BOT_SCOPE,
  createGoogleChatWifAuth,
} from './google-chat-wif';

const AUDIENCE =
  '//iam.googleapis.com/projects/1022506104054/locations/global/' +
  'workloadIdentityPools/aws-agent-broker/providers/chat-app';
const SERVICE_ACCOUNT = 'psd-agent-chat-dev@psd-aistudio-dev.iam.gserviceaccount.com';

const ENV = {
  GOOGLE_CHAT_WIF_AUDIENCE: AUDIENCE,
  GOOGLE_CHAT_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
  AWS_REGION: 'us-east-1',
};

const fakeCredentials = async () => ({
  accessKeyId: 'AKIDEXAMPLETASKROLE',
  secretAccessKey: 'fake-secret-for-signing-only',
  sessionToken: 'fake-ecs-task-session-token',
});

interface SubjectToken {
  url: string;
  method: string;
  headers: Array<{ key: string; value: string }>;
}

function decodeSubjectToken(token: string): SubjectToken {
  return JSON.parse(decodeURIComponent(token)) as SubjectToken;
}

function header(token: SubjectToken, key: string): string | undefined {
  return token.headers.find((h) => h.key.toLowerCase() === key)?.value;
}

describe('createGoogleChatWifAuth', () => {
  test('builds the client for the configured Chat service account and chat.bot scope', () => {
    const auth = createGoogleChatWifAuth({
      env: ENV,
      awsCredentials: fakeCredentials,
    });
    expect(auth.getServiceAccountEmail()).toBe(SERVICE_ACCOUNT);
    expect(auth.scopes).toEqual([GOOGLE_CHAT_BOT_SCOPE]);
  });

  test('signs the AWS proof with the injected credentials for the chat-app audience', async () => {
    const auth = createGoogleChatWifAuth({
      env: ENV,
      awsCredentials: fakeCredentials,
    });
    const token = decodeSubjectToken(await auth.retrieveSubjectToken());

    expect(token.method).toBe('POST');
    expect(token.url).toBe(
      'https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15'
    );
    expect(header(token, 'x-goog-cloud-target-resource')).toBe(AUDIENCE);
    expect(header(token, 'x-amz-security-token')).toBe(
      'fake-ecs-task-session-token'
    );
    expect(header(token, 'authorization')).toContain(
      'Credential=AKIDEXAMPLETASKROLE/'
    );
  });

  test('falls back to AWS_DEFAULT_REGION', async () => {
    const auth = createGoogleChatWifAuth({
      env: {
        GOOGLE_CHAT_WIF_AUDIENCE: AUDIENCE,
        GOOGLE_CHAT_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
        AWS_DEFAULT_REGION: 'us-west-2',
      },
      awsCredentials: fakeCredentials,
    });
    const token = decodeSubjectToken(await auth.retrieveSubjectToken());
    expect(token.url).toContain('https://sts.us-west-2.amazonaws.com');
  });

  test.each([
    'GOOGLE_CHAT_WIF_AUDIENCE',
    'GOOGLE_CHAT_SERVICE_ACCOUNT_EMAIL',
    'AWS_REGION',
  ])('fails closed when %s is missing', (name) => {
    const env: Record<string, string> = { ...ENV };
    delete env[name];
    expect(() =>
      createGoogleChatWifAuth({ env, awsCredentials: fakeCredentials })
    ).toThrow(`${name} is not configured`);
  });
});
