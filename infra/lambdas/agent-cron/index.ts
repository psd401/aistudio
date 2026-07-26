/**
 * Agent Cron Lambda — v2 (per-user, per-schedule)
 *
 * Triggered by EventBridge Scheduler. Each user-defined schedule in the
 * psd-agent-schedules-{env} DynamoDB table has exactly one corresponding
 * EventBridge Scheduler entry that targets this Lambda with a compact,
 * non-authoritative record reference:
 *
 *   {
 *     ownerEmail: "hagelk@psd401.net",
 *     scheduleId: "3f1e9d...",
 *     version: 3
 *   }
 *
 * Cron loads the authoritative DynamoDB row and validates owner, version,
 * enabled state, prompt, and delivery destination before invoking anything.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
import { extractRichEnvelope } from './rich-envelope';
import {
  createScheduledInvocationContextToken,
  deriveScheduledRequestProofKey,
} from './invocation-context';
import {
  loadAuthorizedSchedule,
  type ScheduleReferenceEvent,
} from './schedule-record';

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
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE || '';
const GOOGLE_CREDENTIALS_SECRET_ARN = process.env.GOOGLE_CREDENTIALS_SECRET_ARN || '';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const AGENT_INVOCATION_SIGNING_SECRET_ID =
  process.env.AGENT_INVOCATION_SIGNING_SECRET_ID || '';

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

let cachedInvocationSigningSecret: string | null = null;
let invocationSigningSecretCachedAt: number | null = null;


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

async function getInvocationSigningSecret(): Promise<string> {
  if (
    cachedInvocationSigningSecret
    && invocationSigningSecretCachedAt
    && Date.now() - invocationSigningSecretCachedAt < CREDENTIALS_TTL_MS
  ) {
    return cachedInvocationSigningSecret;
  }
  if (!AGENT_INVOCATION_SIGNING_SECRET_ID) {
    throw new Error('AGENT_INVOCATION_SIGNING_SECRET_ID not configured');
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: AGENT_INVOCATION_SIGNING_SECRET_ID }),
  );
  const secret = result.SecretString || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Agent invocation signing secret is missing or too short');
  }
  cachedInvocationSigningSecret = secret;
  invocationSigningSecretCachedAt = Date.now();
  return secret;
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

/**
 * Drain an AgentCore SSE stream, discard heartbeat and start events, and
 * return the last event carrying a `result` field.
 *
 * Stream contract (see infra/agent-image/agentcore_wrapper.py):
 *   - start event:     {"type": "start"} — immediate header flush
 *   - heartbeat event: {"type": "heartbeat", "elapsed_s": int} every ~30s
 *   - final event:     {"result": "...", "metadata": {...}}
 *
 * SYNC: This function is intentionally duplicated in agent-router/index.ts
 * (function `consumeAgentCoreStream`). The two Lambda bundles compile
 * independently (each has its own tsconfig with rootDir=./), so sharing
 * source files requires build pipeline changes. If you modify the SSE
 * parsing logic here, update `consumeAgentCoreStream` in
 * infra/lambdas/agent-router/index.ts too, and vice versa.
 *
 * Known differences (intentional):
 *   - agent-cron accepts `Response`, agent-router accepts `{ body: unknown }`
 *   - agent-cron logs `totalElapsedMs` and `mode: 'streaming'`
 */
async function consumeAgentCoreStream(
  response: Response,
  log: Logger,
  fetchStart: number,
): Promise<Record<string, unknown> | null> {
  if (!response.body) {
    log.error('AgentCore SSE response has no body');
    return null;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let heartbeats = 0;
  let lastResultEvent: Record<string, unknown> | null = null;

  // SSE events are separated by a blank line. Each event has zero or more
  // `data:` lines whose payload concatenated forms a JSON object.
  const flushEvent = (rawEvent: string) => {
    const dataLines = rawEvent
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (obj.type === 'start') return; // Header-flush event — no payload to process
        if (obj.type === 'heartbeat') {
          heartbeats += 1;
          return;
        }
        if (typeof obj.result === 'string') {
          lastResultEvent = obj;
        }
      }
    } catch {
      // Ignore non-JSON SSE frames (e.g. comments).
    }
  };

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    // Normalize \r\n → \n (SSE spec allows \r\n and \r as line terminators)
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      flushEvent(rawEvent);
    }
  }
  // Flush any residual bytes from the TextDecoder's internal buffer
  // (required by spec when { stream: true } was used).
  const residual = decoder.decode();
  if (residual) buffer += residual;
  if (buffer.length > 0) flushEvent(buffer);

  log.info('AgentCore SSE stream complete', {
    totalElapsedMs: Date.now() - fetchStart,
    heartbeats,
    haveResult: lastResultEvent !== null,
    mode: 'streaming',
  });

  return lastResultEvent;
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

    const invocationSecret = await getInvocationSigningSecret();
    const invocationContext = createScheduledInvocationContextToken(
      invocationSecret,
      {
        ownerEmail: userEmail,
        sessionId,
        workspacePrefix: userContext.workspacePrefix ?? '',
      },
    );
    const body = JSON.stringify({
      prompt,
      user_email: userEmail,
      user_display_name: userContext.displayName ?? '',
      workspace_prefix: userContext.workspacePrefix ?? '',
      invocation_context: invocationContext,
      invocation_request_proof_key: deriveScheduledRequestProofKey(
        invocationSecret,
        invocationContext,
      ),
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
    const fetchStart = Date.now();
    const response = await fetch(`https://${signed.hostname}${signed.path}`, {
      method: signed.method,
      headers: signed.headers as Record<string, string>,
      body: signed.body as string,
      // 14:30 client-side cap. Sits above the harness adapter's 14-min chat
      // deadline (so the agent has a chance to return a partial first) and
      // 30s under the 15-min Lambda timeout (so we have time to record
      // telemetry and post the chat fallback before Lambda kills us).
      signal: AbortSignal.timeout(870 * 1000),
    });
    log.info('AgentCore response headers received', {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'none',
      timeToHeadersMs: Date.now() - fetchStart,
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

    const contentType = response.headers.get('content-type') ?? '';
    let responseBody: Record<string, unknown>;
    if (contentType.includes('text/event-stream')) {
      // Streaming entrypoint (see infra/agent-image/agentcore_wrapper.py).
      // Drains the SSE stream, discards heartbeat events, and keeps the last
      // event that carries a `result` field.
      const finalEvent = await consumeAgentCoreStream(response, log, fetchStart);
      if (!finalEvent) {
        return { response: 'No response from agent.', inputTokens: 0, outputTokens: 0, ok: false };
      }
      responseBody = finalEvent;
    } else {
      const parsed: unknown = await response.json();
      log.info('AgentCore response body parsed', {
        totalElapsedMs: Date.now() - fetchStart,
        mode: 'buffered',
      });
      if (!parsed || typeof parsed !== 'object') {
        log.error('AgentCore returned non-object body', { kind: typeof parsed });
        return { response: 'Agent returned an unexpected response shape.', inputTokens: 0, outputTokens: 0, ok: false };
      }
      responseBody = parsed as Record<string, unknown>;
    }
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
    const errName = error instanceof Error ? error.name : 'Unknown';
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('AgentCore invocation error', { errorName: errName, error: errMsg });
    return {
      // Sanitized user-facing message — full error details are in CloudWatch logs above.
      response: 'Agent temporarily unavailable for scheduled task. Please try again later.',
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
  // Lift any PSD_AGENT_RICH_V1 envelope out of the reply before truncating —
  // the sentinels are way past the 4096 ceiling when the envelope is real,
  // and we want the card payload to survive intact. Mirrors the
  // agent-router behaviour so scheduled tasks (morning brief etc.) can
  // deliver cards/charts too.
  const { envelope, remaining, malformed } = extractRichEnvelope(text);
  if (malformed) {
    log.warn('rich_envelope_malformed — falling back to plain text', {
      space: spaceName,
      preview: text.slice(0, 200),
    });
  }

  const maxLength = 4096;
  const proseSource = envelope ? remaining || envelope.textFallback || 'Rich response' : remaining || text;
  const truncated =
    proseSource.length > maxLength
      ? proseSource.substring(0, maxLength - 50) + '\n\n_(Response truncated)_'
      : proseSource;

  const requestBody: Record<string, unknown> = { text: truncated };
  if (envelope) {
    if (envelope.cardsV2) requestBody.cardsV2 = envelope.cardsV2;
    if (envelope.accessoryWidgets) requestBody.accessoryWidgets = envelope.accessoryWidgets;
  }

  await chatClient.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });
  log.info('Scheduled response sent to Google Chat', {
    space: spaceName,
    responseLength: truncated.length,
    hasCards: !!envelope?.cardsV2,
    hasAccessoryWidgets: !!envelope?.accessoryWidgets,
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

  // Mirror error/skipped runs into agent_failures so the admin dashboard sees
  // them alongside router/harness failures. agent_scheduled_runs remains the
  // source of truth for cron analytics.
  if (params.status === 'error') {
    await recordCronFailure(
      {
        userEmail: params.userEmail,
        sessionId: params.sessionId,
        scheduleId: params.scheduleId,
        scheduleName: params.scheduleName,
        errorMessage: params.errorMessage ?? null,
      },
      log,
    );
  }
}

/**
 * Mirror a failed scheduled run into agent_failures. Best-effort, never throws.
 */
async function recordCronFailure(
  params: {
    userEmail: string;
    sessionId: string;
    scheduleId: string;
    scheduleName: string;
    errorMessage: string | null;
  },
  log: Logger,
): Promise<void> {
  // Emit a structured CloudWatch line so the metric filter on AGENT_FAILURE_RECORD
  // fires regardless of whether the DB write below succeeds. Include the error
  // message (truncated) as a fallback for triage when the DB write fails.
  log.error('AGENT_FAILURE_RECORD', {
    source: 'cron',
    severity: 'error',
    userId: params.userEmail,
    sessionId: params.sessionId,
    scheduleName: params.scheduleName,
    errorMessage: typeof params.errorMessage === 'string'
      ? params.errorMessage.slice(0, 500)
      : null,
  });
  if (!DATABASE_RESOURCE_ARN || !DATABASE_SECRET_ARN) return;
  try {
    const truncated =
      typeof params.errorMessage === 'string'
        ? params.errorMessage.slice(0, 4000)
        : null;
    const context = JSON.stringify({
      scheduleId: params.scheduleId,
    });
    await rdsDataClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `INSERT INTO agent_failures
                (source, severity, user_id, session_id, schedule_name,
                 error_message, context, occurred_at)
              VALUES
                ('cron', 'error', :user_id, :session_id, :schedule_name,
                 :error_message, CAST(:context AS jsonb), NOW())`,
        parameters: [
          { name: 'user_id', value: { stringValue: params.userEmail } },
          { name: 'session_id', value: { stringValue: params.sessionId } },
          { name: 'schedule_name', value: { stringValue: params.scheduleName } },
          truncated
            ? { name: 'error_message', value: { stringValue: truncated } }
            : { name: 'error_message', value: { isNull: true } },
          { name: 'context', value: { stringValue: context } },
        ],
      }),
    );
  } catch (error) {
    log.error('Failed to record cron failure mirror', {
      scheduleId: params.scheduleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(
  event: ScheduleReferenceEvent,
  _context: LambdaContext,
): Promise<{ status: 'success' | 'error' | 'skipped'; scheduleId: string }> {
  const referencedScheduleId =
    typeof event?.scheduleId === 'string' ? event.scheduleId : 'unknown';
  const requestId = generateRequestId();
  const log = createLogger({
    requestId,
    environment: ENVIRONMENT,
    scheduleId: referencedScheduleId,
  });
  let loaded;
  try {
    loaded = await loadAuthorizedSchedule(event, dynamoClient, SCHEDULES_TABLE);
  } catch (error) {
    log.error('Authoritative schedule lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'error', scheduleId: referencedScheduleId };
  }
  if (!loaded.authorized) {
    log.warn('Schedule reference rejected before invocation', {
      reason: loaded.reason,
    });
    return { status: 'skipped', scheduleId: referencedScheduleId };
  }
  const schedule = loaded.schedule;
  const scheduleName = schedule.name;
  const startTime = Date.now();

  log.info('Scheduled task started', {
    scheduleId: schedule.scheduleId,
    version: schedule.version,
    scheduleName,
    email: sanitizeEmail(schedule.ownerEmail),
  });

  // Session ID — unique per schedule invocation, not shared with interactive
  // sessions. Keeps scheduled context isolated. Bound the length so a long
  // workspace prefix can't push us past AgentCore's session-id limits.
  const dateKey = new Date().toISOString().split('T')[0];
  const prefix = schedule.workspacePrefix.substring(0, 40);
  const sessionId =
    `${prefix}-sched-${schedule.scheduleId.substring(0, 12)}-${dateKey}`;

  // Invoke AgentCore.
  log.info('Invoking agent for scheduled task', {
    email: sanitizeEmail(schedule.ownerEmail),
    scheduleName,
    sessionId,
  });

  const result = await invokeAgentCore(
    schedule.prompt,
    schedule.ownerEmail,
    sessionId,
    log,
    {
      displayName: schedule.displayName,
      workspacePrefix: schedule.workspacePrefix,
    },
  );

  // Deliver response to DM regardless of success (so user sees errors).
  try {
    await sendChatMessage(
      schedule.dmSpaceName,
      `📋 **${scheduleName}**\n\n${result.response}`,
      log,
    );
  } catch (error) {
    log.error('Failed to deliver scheduled response', {
      error: error instanceof Error ? error.message : String(error),
    });
    await recordRun(
      {
        userEmail: schedule.ownerEmail,
        scheduleId: schedule.scheduleId,
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
    return { status: 'error', scheduleId: schedule.scheduleId };
  }

  const status: 'success' | 'error' = result.ok ? 'success' : 'error';
  await recordRun(
    {
      userEmail: schedule.ownerEmail,
      scheduleId: schedule.scheduleId,
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
    scheduleId: schedule.scheduleId,
    scheduleName,
    status,
    email: sanitizeEmail(schedule.ownerEmail),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: Date.now() - startTime,
  });

  return { status, scheduleId: schedule.scheduleId };
}
