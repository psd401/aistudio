/**
 * Agent Cron Lambda — v2 (per-user, per-schedule)
 *
 * Triggered by EventBridge Scheduler. Each user-defined schedule in the
 * psd-agent-schedules-{env} DynamoDB table has exactly one corresponding
 * EventBridge Scheduler entry that targets this Lambda with a payload
 * describing a single invocation:
 *
 *   {
 *     scheduleId:      "3f1e9d...",       // UUID, primary key in schedules table
 *     scheduleName:    "Morning Brief",   // user-defined label
 *     userEmail:       "hagelk@psd401.net",
 *     googleIdentity:  "users/12345",     // Google Chat stable user ID
 *     prompt:          "Generate my morning brief...",
 *     dmSpaceName:     "spaces/abc"       // optional — resolved on demand if absent
 *   }
 *
 * One payload = one user = one AgentCore invocation = one DM. No batching,
 * no cross-user stagger, no hard cap. Writes a row to `agent_scheduled_runs`
 * for every invocation (success or failure).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
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
import type { Context as LambdaContext } from 'aws-lambda';
import * as chatPkg from '@googleapis/chat';
import * as crypto from 'crypto';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

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

type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

function createLogger(context: Record<string, unknown> = {}): Logger {
  const base = { service: 'agent-cron', ...context };
  const emit = (
    level: 'INFO' | 'WARN' | 'ERROR',
    stream: NodeJS.WritableStream,
    msg: string,
    meta: Record<string, unknown> = {},
  ) => {
    stream.write(
      JSON.stringify({
        level,
        message: msg,
        timestamp: new Date().toISOString(),
        ...base,
        ...meta,
      }) + '\n',
    );
  };
  return {
    info: (m, meta) => emit('INFO', process.stdout, m, meta),
    warn: (m, meta) => emit('WARN', process.stdout, m, meta),
    error: (m, meta) => emit('ERROR', process.stderr, m, meta),
  };
}

// ---------------------------------------------------------------------------
// AWS SDK clients (shared across warm invocations)
// ---------------------------------------------------------------------------

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});
const ssmClient = new SSMClient({});
const rdsDataClient = new RDSDataClient({});

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
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE || '';
const GOOGLE_CREDENTIALS_SECRET_ARN = process.env.GOOGLE_CREDENTIALS_SECRET_ARN || '';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';

// ---------------------------------------------------------------------------
// Cached secrets and clients
// ---------------------------------------------------------------------------

let cachedGoogleCredentials: string | null = null;
let credentialsCachedAt: number | null = null;
const CREDENTIALS_TTL_MS = 10 * 60 * 1000;

let cachedChatClient: ReturnType<typeof chatPkg.chat> | null = null;

let cachedRuntimeId: string | null = null;
let runtimeIdCachedAt: number | null = null;
const RUNTIME_ID_TTL_MS = 10 * 60 * 1000;


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleEvent {
  scheduleId: string;
  scheduleName: string;
  userEmail: string;
  googleIdentity?: string;
  prompt: string;
  dmSpaceName?: string;
}

interface InvokeResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
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
    new GetSecretValueCommand({ SecretId: GOOGLE_CREDENTIALS_SECRET_ARN }),
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

async function getRuntimeId(log: Logger): Promise<string> {
  let runtimeId = process.env.AGENTCORE_RUNTIME_ID || '';
  if (runtimeId) return runtimeId;
  if (
    cachedRuntimeId &&
    runtimeIdCachedAt &&
    Date.now() - runtimeIdCachedAt < RUNTIME_ID_TTL_MS
  ) {
    return cachedRuntimeId;
  }
  try {
    const param = await ssmClient.send(
      new GetParameterCommand({
        Name: `/aistudio/${ENVIRONMENT}/agentcore-runtime-id`,
      }),
    );
    runtimeId = param.Parameter?.Value || '';
    if (runtimeId) {
      cachedRuntimeId = runtimeId;
      runtimeIdCachedAt = Date.now();
    }
  } catch (error) {
    log.error('Failed to resolve AgentCore Runtime ID from SSM', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return runtimeId;
}

async function resolveDmSpace(
  googleIdentity: string,
  log: Logger,
): Promise<string | null> {
  try {
    const chatClient = await getChatClient();
    // List spaces and find the DM that contains this user.
    // Bounded by the bot's DM count (one per user who has messaged the bot),
    // so this is cheap and has no per-user N+1 when handling a single user.
    let pageToken: string | undefined;
    do {
      const resp = await chatClient.spaces.list({ pageToken, pageSize: 100 });
      const spaces = resp.data.spaces || [];
      for (const space of spaces) {
        if (!space.name || !space.singleUserBotDm) continue;
        const membersResp = await chatClient.spaces.members.list({
          parent: space.name,
          pageSize: 10,
        });
        for (const m of membersResp.data.memberships || []) {
          if (m.member?.type === 'HUMAN' && m.member?.name === googleIdentity) {
            return space.name;
          }
        }
      }
      pageToken = resp.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (error) {
    log.error('Failed to resolve DM space', {
      googleIdentity,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

async function invokeAgentCore(
  prompt: string,
  userEmail: string,
  sessionId: string,
  log: Logger,
  userContext: { displayName?: string; workspacePrefix?: string },
): Promise<InvokeResult> {
  const runtimeId = await getRuntimeId(log);
  if (!runtimeId) {
    return { response: 'Agent is not yet deployed.', inputTokens: 0, outputTokens: 0, ok: false };
  }

  try {
    const region = process.env.AWS_REGION || 'us-east-1';
    const account = process.env.AWS_ACCOUNT_ID || '';
    let runtimeArn: string;
    if (runtimeId.startsWith('arn:')) {
      runtimeArn = runtimeId;
    } else {
      if (!account) {
        log.error('AWS_ACCOUNT_ID env var not set — cannot construct AgentCore ARN', {
          runtimeId,
        });
        return {
          response: 'Agent configuration error — missing AWS account ID.',
          inputTokens: 0,
          outputTokens: 0,
          ok: false,
        };
      }
      runtimeArn = `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeId}`;
    }

    const body = JSON.stringify({
      prompt,
      user_email: userEmail,
      user_display_name: userContext.displayName ?? '',
      workspace_prefix: userContext.workspacePrefix ?? '',
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
        'X-Amzn-Bedrock-AgentCore-Runtime-User-Id': userEmail,
      },
      body,
    });

    const signed = await agentCoreSigner.sign(request);
    const response = await fetch(`https://${signed.hostname}${signed.path}`, {
      method: signed.method,
      headers: signed.headers as Record<string, string>,
      body: signed.body as string,
    });

    if (!response.ok) {
      const errBody = await response.text();
      log.error('AgentCore invocation failed', {
        status: response.status,
        body: errBody.substring(0, 500),
      });
      return {
        response: 'Agent encountered an error processing scheduled task.',
        inputTokens: 0,
        outputTokens: 0,
        ok: false,
      };
    }

    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object') {
      log.error('AgentCore returned non-object body', { kind: typeof parsed });
      return { response: 'Agent returned an unexpected response shape.', inputTokens: 0, outputTokens: 0, ok: false };
    }
    const responseBody = parsed as Record<string, unknown>;
    const rawResult = responseBody.result;
    const result = typeof rawResult === 'string' && rawResult.length > 0
      ? rawResult
      : 'No response from agent.';
    const ok = typeof rawResult === 'string' && rawResult.length > 0;
    const metadata =
      responseBody.metadata && typeof responseBody.metadata === 'object'
        ? (responseBody.metadata as Record<string, unknown>)
        : {};
    const inputTokens = typeof metadata.input_tokens === 'number' ? metadata.input_tokens : 0;
    const outputTokens = typeof metadata.output_tokens === 'number' ? metadata.output_tokens : 0;
    return { response: result, inputTokens, outputTokens, ok };
  } catch (error) {
    log.error('AgentCore invocation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response: 'Agent temporarily unavailable for scheduled task.',
      inputTokens: 0,
      outputTokens: 0,
      ok: false,
    };
  }
}

async function sendChatMessage(
  spaceName: string,
  text: string,
  log: Logger,
): Promise<void> {
  const chatClient = await getChatClient();
  const maxLength = 4096;
  const truncated =
    text.length > maxLength
      ? text.substring(0, maxLength - 50) + '\n\n_(Response truncated)_'
      : text;
  await chatClient.spaces.messages.create({
    parent: spaceName,
    requestBody: { text: truncated },
  });
  log.info('Scheduled response sent to Google Chat', {
    space: spaceName,
    responseLength: truncated.length,
  });
}

async function recordRun(params: {
  userEmail: string;
  scheduleId: string;
  scheduleName: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: 'success' | 'error' | 'skipped';
  errorMessage?: string;
}, log: Logger): Promise<void> {
  if (!DATABASE_RESOURCE_ARN || !DATABASE_SECRET_ARN) {
    log.warn('Database not configured — skipping run telemetry', {
      scheduleId: params.scheduleId,
    });
    return;
  }
  try {
    await rdsDataClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `INSERT INTO agent_scheduled_runs
                (user_id, schedule_id, schedule_name, session_id,
                 input_tokens, output_tokens, latency_ms, status, error_message)
              VALUES
                (:user_id, :schedule_id, :schedule_name, :session_id,
                 :input_tokens, :output_tokens, :latency_ms, :status, :error_message)`,
        parameters: [
          { name: 'user_id', value: { stringValue: params.userEmail } },
          { name: 'schedule_id', value: { stringValue: params.scheduleId } },
          { name: 'schedule_name', value: { stringValue: params.scheduleName } },
          { name: 'session_id', value: { stringValue: params.sessionId } },
          { name: 'input_tokens', value: { longValue: params.inputTokens } },
          { name: 'output_tokens', value: { longValue: params.outputTokens } },
          { name: 'latency_ms', value: { longValue: params.latencyMs } },
          { name: 'status', value: { stringValue: params.status } },
          params.errorMessage
            ? { name: 'error_message', value: { stringValue: params.errorMessage } }
            : { name: 'error_message', value: { isNull: true } },
        ],
      }),
    );
  } catch (error) {
    // Telemetry failure must not break delivery; log and continue.
    log.error('Failed to record scheduled run', {
      scheduleId: params.scheduleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Backfill a freshly resolved Google Chat DM space back into the schedule
 * row so subsequent invocations skip the API scan (which is O(spaces) for
 * the bot, paginated). Best-effort — failure just means the next run does
 * another scan.
 */
async function backfillDmSpace(
  userId: string,
  scheduleId: string,
  dmSpaceName: string,
  log: Logger,
): Promise<void> {
  if (!SCHEDULES_TABLE) return;
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: SCHEDULES_TABLE,
        Key: { userId, scheduleId },
        UpdateExpression: 'SET dmSpaceName = :dm, updatedAt = :now',
        ExpressionAttributeValues: {
          ':dm': dmSpaceName,
          ':now': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(scheduleId)',
      }),
    );
    log.info('Backfilled DM space on schedule row', { scheduleId });
  } catch (error) {
    log.warn('DM space backfill failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function lookupUserByGoogleIdentity(
  googleIdentity: string,
  log: Logger,
): Promise<{
  displayName?: string;
  workspacePrefix?: string;
  dmSpaceName?: string;
  email?: string;
} | null> {
  if (!USERS_TABLE) return null;
  try {
    const resp = await dynamoClient.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity },
      }),
    );
    const item = resp.Item;
    if (!item) return null;
    return {
      displayName: item.displayName as string | undefined,
      workspacePrefix: item.workspacePrefix as string | undefined,
      dmSpaceName: item.dmSpaceName as string | undefined,
      email: item.email as string | undefined,
    };
  } catch (error) {
    log.error('User lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(
  event: ScheduleEvent,
  _context: LambdaContext,
): Promise<{ status: 'success' | 'error' | 'skipped'; scheduleId: string }> {
  const requestId = generateRequestId();
  const log = createLogger({
    requestId,
    environment: ENVIRONMENT,
    scheduleId: event?.scheduleId,
  });

  // Validate payload.
  if (!event?.scheduleId || !event?.userEmail || !event?.prompt) {
    log.error('Invalid schedule payload', {
      hasScheduleId: !!event?.scheduleId,
      hasUserEmail: !!event?.userEmail,
      hasPrompt: !!event?.prompt,
    });
    return { status: 'error', scheduleId: event?.scheduleId ?? 'unknown' };
  }

  const scheduleName = event.scheduleName || 'Scheduled Task';
  const startTime = Date.now();

  log.info('Scheduled task started', {
    scheduleId: event.scheduleId,
    scheduleName,
    email: sanitizeEmail(event.userEmail),
  });

  // Resolve user metadata from DynamoDB if googleIdentity provided.
  // Cross-check: googleIdentity must belong to the payload's userEmail, else
  // a spoofed schedule entry could direct a prompt at another user's DM.
  let userContext: { displayName?: string; workspacePrefix?: string; dmSpaceName?: string } = {};
  let googleIdentityTrusted = false;
  if (event.googleIdentity) {
    const lookup = await lookupUserByGoogleIdentity(event.googleIdentity, log);
    if (lookup && lookup.email && lookup.email.toLowerCase() === event.userEmail.toLowerCase()) {
      userContext = lookup;
      googleIdentityTrusted = true;
    } else if (lookup) {
      log.error('googleIdentity / userEmail mismatch — refusing to deliver', {
        email: sanitizeEmail(event.userEmail),
        identityEmail: lookup.email ? sanitizeEmail(lookup.email) : null,
      });
      await recordRun(
        {
          userEmail: event.userEmail,
          scheduleId: event.scheduleId,
          scheduleName,
          sessionId: 'rejected',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startTime,
          status: 'error',
          errorMessage: 'googleIdentity does not match userEmail',
        },
        log,
      );
      return { status: 'error', scheduleId: event.scheduleId };
    }
  }

  // Resolve DM space: payload > user record > Google Chat API scan.
  // The API scan is only allowed when googleIdentity was verified against
  // DynamoDB above — otherwise an attacker-supplied identity could resolve
  // someone else's DM space.
  let dmSpace = event.dmSpaceName || userContext.dmSpaceName || null;
  let dmSpaceResolvedViaApi = false;
  if (!dmSpace && event.googleIdentity && googleIdentityTrusted) {
    dmSpace = await resolveDmSpace(event.googleIdentity, log);
    dmSpaceResolvedViaApi = !!dmSpace;
  }
  if (!dmSpace) {
    log.warn('No DM space found — skipping (user has not DM\'d the bot yet)', {
      email: sanitizeEmail(event.userEmail),
      googleIdentity: event.googleIdentity,
    });
    await recordRun(
      {
        userEmail: event.userEmail,
        scheduleId: event.scheduleId,
        scheduleName,
        sessionId: 'skipped',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startTime,
        status: 'skipped',
        errorMessage: 'No DM space — user has not initiated DM with bot',
      },
      log,
    );
    return { status: 'skipped', scheduleId: event.scheduleId };
  }

  // Session ID — unique per schedule invocation, not shared with interactive
  // sessions. Keeps scheduled context isolated. Bound the length so a long
  // workspace prefix can't push us past AgentCore's session-id limits.
  const dateKey = new Date().toISOString().split('T')[0];
  const rawPrefix =
    userContext.workspacePrefix || event.userEmail.split('@')[0] || 'unknown';
  const prefix = rawPrefix.substring(0, 40);
  const sessionId = `${prefix}-sched-${event.scheduleId.substring(0, 12)}-${dateKey}`;

  // Invoke AgentCore.
  log.info('Invoking agent for scheduled task', {
    email: sanitizeEmail(event.userEmail),
    scheduleName,
    sessionId,
  });

  const result = await invokeAgentCore(
    event.prompt,
    event.userEmail,
    sessionId,
    log,
    {
      displayName: userContext.displayName,
      workspacePrefix: userContext.workspacePrefix,
    },
  );

  // Deliver response to DM regardless of success (so user sees errors).
  try {
    await sendChatMessage(
      dmSpace,
      `📋 **${scheduleName}**\n\n${result.response}`,
      log,
    );
    // Delivery succeeded — if we discovered the DM space via the expensive
    // API scan, cache it on the schedule row so the next fire skips scanning.
    if (dmSpaceResolvedViaApi) {
      await backfillDmSpace(event.userEmail, event.scheduleId, dmSpace, log);
    }
  } catch (error) {
    log.error('Failed to deliver scheduled response', {
      error: error instanceof Error ? error.message : String(error),
    });
    await recordRun(
      {
        userEmail: event.userEmail,
        scheduleId: event.scheduleId,
        scheduleName,
        sessionId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startTime,
        status: 'error',
        errorMessage: `Chat delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      log,
    );
    return { status: 'error', scheduleId: event.scheduleId };
  }

  const status: 'success' | 'error' = result.ok ? 'success' : 'error';
  await recordRun(
    {
      userEmail: event.userEmail,
      scheduleId: event.scheduleId,
      scheduleName,
      sessionId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startTime,
      status,
      errorMessage: result.ok ? undefined : result.response.substring(0, 500),
    },
    log,
  );

  log.info('Scheduled task completed', {
    scheduleId: event.scheduleId,
    scheduleName,
    status,
    email: sanitizeEmail(event.userEmail),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: Date.now() - startTime,
  });

  return { status, scheduleId: event.scheduleId };
}
