/**
 * Agent Cron Lambda
 *
 * Triggered by EventBridge rules for scheduled agent tasks:
 *   - Morning Brief (9 AM weekdays)
 *   - Evening Wrap (6 PM weekdays)
 *   - Weekly Summary (3 PM Friday)
 *   - Kaizen Scan (8 PM Sunday)
 *
 * Flow:
 *   1. Receive EventBridge event with schedule type
 *   2. Scan DynamoDB for all active users
 *   3. For each user, stagger by 30s to avoid Bedrock API throttling
 *   4. Invoke AgentCore session with the scheduled prompt
 *   5. Deliver output to user's Google Chat DM
 *
 * Environment variables (injected by CDK):
 *   ENVIRONMENT            — dev/staging/prod
 *   USERS_TABLE            — DynamoDB table name
 *   GOOGLE_CREDENTIALS_SECRET_ARN — Secrets Manager ARN for Google service account JSON
 *   STAGGER_DELAY_MS       — Delay between user wakeups (default 30000)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand as DocScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import type { EventBridgeEvent, Context as LambdaContext } from 'aws-lambda';
import * as chatPkg from '@googleapis/chat';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// PII sanitization — mask email addresses in logs (FERPA compliance)
// ---------------------------------------------------------------------------

function sanitizeEmail(email: string): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return `${email.charAt(0)}***`;
  return `${local.charAt(0)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  return `cron_${crypto.randomUUID()}`;
}

function createLogger(context: Record<string, unknown> = {}) {
  const baseContext = {
    service: 'agent-cron',
    ...context,
  };

  return {
    info: (message: string, meta: Record<string, unknown> = {}) => {
      process.stdout.write(
        JSON.stringify({ level: 'INFO', message, timestamp: new Date().toISOString(), ...baseContext, ...meta }) +
          '\n'
      );
    },
    error: (message: string, meta: Record<string, unknown> = {}) => {
      process.stderr.write(
        JSON.stringify({ level: 'ERROR', message, timestamp: new Date().toISOString(), ...baseContext, ...meta }) +
          '\n'
      );
    },
    warn: (message: string, meta: Record<string, unknown> = {}) => {
      process.stdout.write(
        JSON.stringify({ level: 'WARN', message, timestamp: new Date().toISOString(), ...baseContext, ...meta }) +
          '\n'
      );
    },
  };
}

// ---------------------------------------------------------------------------
// AWS SDK clients (re-used across invocations)
// ---------------------------------------------------------------------------

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});
const ssmClient = new SSMClient({});

const agentCoreCredentials = defaultProvider();
const agentCoreSigner = new SignatureV4({
  service: 'bedrock-agentcore',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: agentCoreCredentials,
  sha256: Sha256,
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const USERS_TABLE = process.env.USERS_TABLE || '';
const GOOGLE_CREDENTIALS_SECRET_ARN = process.env.GOOGLE_CREDENTIALS_SECRET_ARN || '';
const STAGGER_DELAY_MS = parseInt(process.env.STAGGER_DELAY_MS || '30000', 10);

// Hard cap on users per cron run to prevent Lambda timeout.
// At 30s stagger + ~60s per invocation, 10 users ≈ 15 minutes.
// Increase only with architectural change (SQS fan-out).
const MAX_USERS_PER_RUN = parseInt(process.env.MAX_USERS_PER_RUN || '10', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentUser {
  googleIdentity: string;
  email: string;
  displayName: string;
  department: string;
  workspacePrefix: string;
  /** Google Chat DM space name — populated after first welcome */
  dmSpaceName?: string;
  createdAt: string;
  lastActiveAt: string;
  sessionCount: number;
}

interface ScheduleDetail {
  scheduleType: 'morning-brief' | 'evening-wrap' | 'weekly-summary' | 'kaizen-scan';
}

// ---------------------------------------------------------------------------
// Schedule prompts — baked into the Cron Lambda image
// ---------------------------------------------------------------------------

const SCHEDULE_PROMPTS: Record<string, string> = {
  'morning-brief': [
    'Generate my morning brief. Include:',
    '- Today\'s calendar events and meetings',
    '- Overdue or high-priority tasks',
    '- Relevant email highlights from overnight',
    '- Any items that need my attention before 10 AM',
    'Keep it concise and actionable.',
  ].join('\n'),

  'evening-wrap': [
    'Generate my evening wrap-up. Include:',
    '- Summary of what happened today (meetings attended, decisions made)',
    '- Tasks that stalled or need follow-up',
    '- Items to prepare for tomorrow',
    '- Any threads I should respond to before end of day',
    'Keep it concise.',
  ].join('\n'),

  'weekly-summary': [
    'Generate my weekly summary for this week. Include:',
    '- Completed items and key accomplishments',
    '- Pending items and blockers',
    '- Patterns you\'ve noticed across the week (recurring topics, escalations)',
    '- Recommended focus areas for next week',
    'Format as a brief executive summary.',
  ].join('\n'),

  'kaizen-scan': [
    'Run your weekly self-improvement scan. Include:',
    '- AI developments relevant to my role this week',
    '- New tools, techniques, or frameworks worth knowing about',
    '- Suggestions for improving our workflows based on this week\'s patterns',
    '- One specific thing I could try next week to be more effective',
    'Keep it focused and practical.',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Cached secrets
// ---------------------------------------------------------------------------

let cachedGoogleCredentials: string | null = null;
let credentialsCachedAt: number | null = null;
const CREDENTIALS_TTL_MS = 10 * 60 * 1000;

let cachedChatClient: ReturnType<typeof chatPkg.chat> | null = null;

let cachedRuntimeId: string | null = null;
let runtimeIdCachedAt: number | null = null;
const RUNTIME_ID_TTL_MS = 10 * 60 * 1000;

// Cache discovered DM spaces across warm invocations to avoid N+1 Google Chat
// API calls on every cron fire.
let cachedDmSpaces: Map<string, string> | null = null;
let dmSpacesCachedAt: number | null = null;
const DM_SPACES_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

async function getGoogleCredentials(): Promise<string> {
  if (
    cachedGoogleCredentials &&
    credentialsCachedAt &&
    Date.now() - credentialsCachedAt < CREDENTIALS_TTL_MS
  ) {
    return cachedGoogleCredentials;
  }
  if (!GOOGLE_CREDENTIALS_SECRET_ARN) {
    throw new Error('GOOGLE_CREDENTIALS_SECRET_ARN not configured');
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: GOOGLE_CREDENTIALS_SECRET_ARN })
  );
  cachedGoogleCredentials = result.SecretString || '';
  credentialsCachedAt = Date.now();
  cachedChatClient = null;
  return cachedGoogleCredentials;
}

async function getChatClient(): Promise<ReturnType<typeof chatPkg.chat>> {
  if (cachedChatClient) return cachedChatClient;

  const credentialsJson = await getGoogleCredentials();
  const credentials = JSON.parse(credentialsJson) as Record<string, unknown>;

  const googleAuth = new chatPkg.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });
  cachedChatClient = chatPkg.chat({ version: 'v1', auth: googleAuth });
  return cachedChatClient;
}

async function getRuntimeId(log: ReturnType<typeof createLogger>): Promise<string> {
  let runtimeId = process.env.AGENTCORE_RUNTIME_ID || '';
  if (!runtimeId) {
    if (
      cachedRuntimeId &&
      runtimeIdCachedAt &&
      Date.now() - runtimeIdCachedAt < RUNTIME_ID_TTL_MS
    ) {
      runtimeId = cachedRuntimeId;
    } else {
      try {
        const param = await ssmClient.send(
          new GetParameterCommand({
            Name: `/aistudio/${ENVIRONMENT}/agentcore-runtime-id`,
          })
        );
        runtimeId = param.Parameter?.Value || '';
        if (runtimeId) {
          cachedRuntimeId = runtimeId;
          runtimeIdCachedAt = Date.now();
        }
      } catch {
        log.error('Failed to resolve AgentCore Runtime ID from SSM');
      }
    }
  }
  return runtimeId;
}

async function getAllActiveUsers(
  log: ReturnType<typeof createLogger>
): Promise<AgentUser[]> {
  const users: AgentUser[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamoClient.send(
      new DocScanCommand({
        TableName: USERS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );

    if (result.Items) {
      users.push(...(result.Items as AgentUser[]));
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  log.info('Fetched active users', { count: users.length });
  return users;
}

async function invokeAgentCore(
  message: string,
  userId: string,
  sessionId: string,
  log: ReturnType<typeof createLogger>,
  userContext?: { displayName?: string; workspacePrefix?: string }
): Promise<{ response: string; inputTokens: number; outputTokens: number }> {
  const runtimeId = await getRuntimeId(log);

  if (!runtimeId) {
    return {
      response: 'Agent is not yet deployed.',
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  try {
    const region = process.env.AWS_REGION || 'us-east-1';
    const account = process.env.AWS_ACCOUNT_ID || '';
    const runtimeArn = runtimeId.startsWith('arn:')
      ? runtimeId
      : `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeId}`;

    const body = JSON.stringify({
      prompt: message,
      user_email: userId,
      user_display_name: userContext?.displayName ?? '',
      workspace_prefix: userContext?.workspacePrefix ?? '',
      source: 'scheduled',
    });

    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: `bedrock-agentcore.${region}.amazonaws.com`,
      path: `/runtimes/${encodeURIComponent(runtimeArn)}/invocations`,
      headers: {
        'Content-Type': 'application/json',
        host: `bedrock-agentcore.${region}.amazonaws.com`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        'X-Amzn-Bedrock-AgentCore-Runtime-User-Id': userId,
      },
      body,
    });

    const signed = await agentCoreSigner.sign(request);

    const response = await fetch(
      `https://${signed.hostname}${signed.path}`,
      {
        method: signed.method,
        headers: signed.headers as Record<string, string>,
        body: signed.body as string,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      log.error('AgentCore invocation failed', {
        status: response.status,
        body: errorBody.substring(0, 500),
      });
      return {
        response: 'Agent encountered an error processing scheduled task.',
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    const responseBody = await response.json() as Record<string, unknown>;
    const result = (responseBody.result as string) || 'No response from agent.';
    const metadata = (responseBody.metadata as Record<string, unknown>) || {};

    return {
      response: result,
      inputTokens: (metadata.input_tokens as number) || 0,
      outputTokens: (metadata.output_tokens as number) || 0,
    };
  } catch (error) {
    log.error('AgentCore invocation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response: 'Agent temporarily unavailable for scheduled task.',
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

/**
 * Send a message to a Google Chat space. Throws on failure so the caller
 * can count the delivery as failed (rather than silently succeeding).
 */
async function sendGoogleChatResponse(
  spaceName: string,
  text: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const chatClient = await getChatClient();

  // Truncate response for Google Chat API limits
  const maxLength = 4096;
  const truncatedText =
    text.length > maxLength
      ? text.substring(0, maxLength - 50) + '\n\n_(Response truncated)_'
      : text;

  await chatClient.spaces.messages.create({
    parent: spaceName,
    requestBody: { text: truncatedText },
  });

  log.info('Scheduled response sent to Google Chat', {
    space: spaceName,
    responseLength: truncatedText.length,
  });
}

/**
 * List all DM spaces where the bot has been added.
 * Uses Google Chat API to list spaces, filtering for DMs.
 * Returns a map of google identity (users/{userId}) → space name.
 */
async function getBotDmSpaces(
  log: ReturnType<typeof createLogger>
): Promise<Map<string, string>> {
  const dmMap = new Map<string, string>();

  try {
    const chatClient = await getChatClient();
    let pageToken: string | undefined;

    do {
      // Google Chat API spaces.list — pageToken and pageSize are valid params
      const response = await chatClient.spaces.list({
        pageToken,
        pageSize: 100,
      } as Record<string, unknown>);

      const data = (response as { data?: { spaces?: Array<{ name?: string; singleUserBotDm?: boolean }>; nextPageToken?: string } }).data;
      const spaces = data?.spaces || [];
      for (const space of spaces) {
        if (space.name && space.singleUserBotDm) {
          // For single-user bot DMs, list members to find the human
          try {
            const membersResp = await chatClient.spaces.members.list({
              parent: space.name,
              pageSize: 10,
            } as Record<string, unknown>);
            const membersData = (membersResp as { data?: { memberships?: Array<{ member?: { type?: string; name?: string } }> } }).data;
            const members = membersData?.memberships || [];
            for (const member of members) {
              if (member.member?.type === 'HUMAN' && member.member?.name) {
                dmMap.set(member.member.name, space.name);
              }
            }
          } catch (memberErr) {
            log.warn('Failed to list members for DM space', {
              space: space.name,
              error: memberErr instanceof Error ? memberErr.message : String(memberErr),
            });
          }
        }
      }

      pageToken = data?.nextPageToken || undefined;
    } while (pageToken);

    log.info('Discovered bot DM spaces', { count: dmMap.size });
  } catch (error) {
    log.error('Failed to list bot DM spaces', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return dmMap;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(
  event: EventBridgeEvent<string, ScheduleDetail>,
  _context: LambdaContext
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, environment: ENVIRONMENT });

  // Determine schedule type from the event detail
  // EventBridge rules pass { scheduleType: 'morning-brief' | ... } in detail
  const scheduleType = event.detail?.scheduleType || 'morning-brief';
  const prompt = SCHEDULE_PROMPTS[scheduleType];

  if (!prompt) {
    log.error('Unknown schedule type', { scheduleType });
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  log.info('Cron job started', { scheduleType, staggerDelayMs: STAGGER_DELAY_MS });

  // Step 1: Get all active users
  const users = await getAllActiveUsers(log);
  if (users.length === 0) {
    log.warn('No active users found');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  // Step 2: Discover bot DM spaces (cached across warm invocations)
  let dmSpaces: Map<string, string>;
  if (
    cachedDmSpaces &&
    dmSpacesCachedAt &&
    Date.now() - dmSpacesCachedAt < DM_SPACES_TTL_MS
  ) {
    dmSpaces = cachedDmSpaces;
    log.info('Using cached DM space map', { count: dmSpaces.size });
  } else {
    dmSpaces = await getBotDmSpaces(log);
    cachedDmSpaces = dmSpaces;
    dmSpacesCachedAt = Date.now();
  }

  // Step 3: Process each user with staggered execution
  // Enforce hard cap to prevent Lambda timeout (15 min budget).
  if (users.length > MAX_USERS_PER_RUN) {
    log.warn('User count exceeds per-run cap — processing first batch only', {
      totalUsers: users.length,
      maxUsersPerRun: MAX_USERS_PER_RUN,
    });
  }
  const usersToProcess = users.slice(0, MAX_USERS_PER_RUN);

  let succeeded = 0;
  let failed = 0;
  const buildTag = process.env.AGENT_BUILD_TAG || 'cron';

  for (let i = 0; i < usersToProcess.length; i++) {
    const user = usersToProcess[i];

    // Stagger — wait between users to avoid Bedrock API throttling
    if (i > 0) {
      log.info('Staggering next user', { delayMs: STAGGER_DELAY_MS, userIndex: i });
      await sleep(STAGGER_DELAY_MS);
    }

    // Find the user's DM space
    const dmSpaceName = user.dmSpaceName || dmSpaces.get(user.googleIdentity);
    if (!dmSpaceName) {
      log.warn('No DM space found for user — skipping (user has not DM\'d the bot yet)', {
        email: sanitizeEmail(user.email),
        googleIdentity: user.googleIdentity,
      });
      failed++;
      continue;
    }

    try {
      // Build a schedule-specific session ID — keeps scheduled invocations
      // separate from interactive sessions so they don't share context.
      const scheduleHash = crypto.createHash('sha256')
        .update(`${scheduleType}-${new Date().toISOString().split('T')[0]}`)
        .digest('hex')
        .substring(0, 16);
      const sessionId = `${user.workspacePrefix}-sched-${scheduleHash}-${buildTag}`;

      log.info('Invoking agent for scheduled task', {
        email: sanitizeEmail(user.email),
        scheduleType,
        sessionId,
      });

      const result = await invokeAgentCore(
        prompt,
        user.email,
        sessionId,
        log,
        {
          displayName: user.displayName,
          workspacePrefix: user.workspacePrefix,
        }
      );

      // Deliver response to the user's DM
      await sendGoogleChatResponse(
        dmSpaceName,
        `📋 **${scheduleType.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}**\n\n${result.response}`,
        log
      );

      log.info('Scheduled task completed', {
        email: sanitizeEmail(user.email),
        scheduleType,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      succeeded++;
    } catch (error) {
      log.error('Scheduled task failed for user', {
        email: sanitizeEmail(user.email),
        scheduleType,
        error: error instanceof Error ? error.message : String(error),
      });
      failed++;
    }
  }

  const skipped = users.length - usersToProcess.length;
  const summary = {
    processed: usersToProcess.length,
    succeeded,
    failed,
    ...(skipped > 0 ? { skipped } : {}),
  };

  log.info('Cron job completed', { ...summary, scheduleType });
  return { processed: summary.processed, succeeded, failed };
}
