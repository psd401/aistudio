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
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
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
import { resolveAbortMs, resolveTurnDeadlineS } from './turn-deadline';
import {
  buildJobPayload,
  promotionReason,
  type PromotionReason,
} from './job-promotion';
import * as chatPkg from '@googleapis/chat';
import * as crypto from 'node:crypto';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { extractRichEnvelope } from './rich-envelope';
import {
  createScheduledInvocationContextToken,
  deriveScheduledRequestProofKey,
} from './invocation-context';
import {
  loadAuthorizedSchedule,
  type AuthorizedSchedule,
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
const ecsClient = new ECSClient({});

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
  /**
   * Harness error class from the response metadata, when the turn failed.
   *
   * Previously discarded. It is what distinguishes "ran out of clock" (
   * ChatDeadlineExpired) from "actually broke", and therefore what decides
   * whether a failed scheduled turn is worth promoting to a background job.
   */
  errorClass?: string;
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

function invokeFailure(response: string): InvokeResult {
  return { response, inputTokens: 0, outputTokens: 0, ok: false };
}

function resolveAgentCoreRuntimeArn(
  runtimeId: string,
  log: Logger,
): { runtimeArn: string } | { failure: InvokeResult } {
  if (runtimeId.startsWith('arn:')) return { runtimeArn: runtimeId };

  const region = process.env.AWS_REGION || 'us-east-1';
  const account = process.env.AWS_ACCOUNT_ID || '';
  if (!account) {
    log.error('AWS_ACCOUNT_ID env var not set — cannot construct AgentCore ARN', {
      runtimeId,
    });
    return {
      failure: invokeFailure(
        'Agent configuration error — missing AWS account ID.',
      ),
    };
  }
  return {
    runtimeArn: `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeId}`,
  };
}

async function createAgentCoreRequest(options: {
  runtimeArn: string;
  prompt: string;
  userEmail: string;
  sessionId: string;
  userContext: { displayName?: string; workspacePrefix?: string };
  remainingMs: () => number;
}): Promise<HttpRequest> {
  const {
    runtimeArn,
    prompt,
    userEmail,
    sessionId,
    userContext,
    remainingMs,
  } = options;
  const region = process.env.AWS_REGION || 'us-east-1';
  const invocationSecret = await getInvocationSigningSecret();
  const invocationContext = createScheduledInvocationContextToken(
    invocationSecret,
    {
      ownerEmail: userEmail,
      sessionId,
      workspacePrefix: userContext.workspacePrefix ?? '',
    },
  );
  // Read the clock after fetching the signing secret: the deadline must reflect
  // the time actually left when the request is ready to leave this Lambda.
  const turnDeadlineS = resolveTurnDeadlineS(remainingMs());
  return new HttpRequest({
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
    body: JSON.stringify({
      prompt,
      user_email: userEmail,
      user_display_name: userContext.displayName ?? '',
      workspace_prefix: userContext.workspacePrefix ?? '',
      invocation_context: invocationContext,
      invocation_request_proof_key: deriveScheduledRequestProofKey(
        invocationSecret,
        invocationContext,
      ),
      // Without this the harness falls back to its fixed 840s default, which is
      // measured from a later start than our abort and so can never fire first.
      deadline_s: turnDeadlineS,
      source: 'scheduled',
    }),
  });
}

type AgentCoreResponseRead =
  | { responseBody: Record<string, unknown> }
  | { failure: InvokeResult };

async function readAgentCoreResponse(
  response: Response,
  log: Logger,
  fetchStart: number,
): Promise<AgentCoreResponseRead> {
  if (!response.ok) {
    const errBody = await response.text();
    log.error('AgentCore invocation failed', {
      status: response.status,
      body: errBody.substring(0, 500),
    });
    return {
      failure: invokeFailure(
        'Agent encountered an error processing scheduled task.',
      ),
    };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const finalEvent = await consumeAgentCoreStream(response, log, fetchStart);
    return finalEvent
      ? { responseBody: finalEvent }
      : { failure: invokeFailure('No response from agent.') };
  }

  const parsed: unknown = await response.json();
  log.info('AgentCore response body parsed', {
    totalElapsedMs: Date.now() - fetchStart,
    mode: 'buffered',
  });
  if (!parsed || typeof parsed !== 'object') {
    log.error('AgentCore returned non-object body', { kind: typeof parsed });
    return {
      failure: invokeFailure('Agent returned an unexpected response shape.'),
    };
  }
  return { responseBody: parsed as Record<string, unknown> };
}

function toInvokeResult(responseBody: Record<string, unknown>): InvokeResult {
  const rawResult = responseBody.result;
  const result = typeof rawResult === 'string' && rawResult.length > 0
    ? rawResult
    : 'No response from agent.';
  const ok = typeof rawResult === 'string' && rawResult.length > 0;
  const metadata =
    responseBody.metadata && typeof responseBody.metadata === 'object'
      ? (responseBody.metadata as Record<string, unknown>)
      : {};
  const errorClass =
    typeof metadata.error_class === 'string' && metadata.error_class
      ? metadata.error_class
      : undefined;
  return {
    response: result,
    inputTokens:
      typeof metadata.input_tokens === 'number' ? metadata.input_tokens : 0,
    outputTokens:
      typeof metadata.output_tokens === 'number' ? metadata.output_tokens : 0,
    ok,
    errorClass,
  };
}

interface AgentCoreInvocation {
  prompt: string;
  userEmail: string;
  sessionId: string;
  log: Logger;
  userContext: { displayName?: string; workspacePrefix?: string };
  remainingMs: () => number;
}

async function invokeAgentCore(
  invocation: AgentCoreInvocation,
): Promise<InvokeResult> {
  const {
    prompt,
    userEmail,
    sessionId,
    log,
    userContext,
    remainingMs,
  } = invocation;
  const runtimeId = await getRuntimeId(log);
  if (!runtimeId) {
    return invokeFailure('Agent is not yet deployed.');
  }

  const invokeStart = Date.now();
  try {
    const runtime = resolveAgentCoreRuntimeArn(runtimeId, log);
    if ('failure' in runtime) return runtime.failure;
    const request = await createAgentCoreRequest({
      runtimeArn: runtime.runtimeArn,
      prompt,
      userEmail,
      sessionId,
      userContext,
      remainingMs,
    });
    const signed = await agentCoreSigner.sign(request);
    const fetchStart = Date.now();
    const response = await fetch(`https://${signed.hostname}${signed.path}`, {
      method: signed.method,
      headers: signed.headers as Record<string, string>,
      body: signed.body as string,
      // Derived from the SAME clock as turnDeadlineS above, so the ordering
      // harness-deadline < abort < Lambda-timeout actually holds. The old
      // hardcoded 870s assumed a 900s Lambda and zero startup cost; when
      // reaching the container took ~47s, the abort beat the harness and threw
      // away a turn that had already succeeded.
      signal: AbortSignal.timeout(resolveAbortMs(remainingMs())),
    });
    log.info('AgentCore response headers received', {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'none',
      timeToHeadersMs: Date.now() - fetchStart,
    });

    const readResult = await readAgentCoreResponse(response, log, fetchStart);
    return 'failure' in readResult
      ? readResult.failure
      : toInvokeResult(readResult.responseBody);
  } catch (error) {
    const errName = error instanceof Error ? error.name : 'Unknown';
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('AgentCore invocation error', {
      errorName: errName,
      error: errMsg,
      elapsedMs: Date.now() - invokeStart,
    });
    return invokeFailure(
      errName === 'TimeoutError'
        ? 'This scheduled task ran out of time before it could finish. It was still working when the deadline was reached — consider narrowing what it does, or splitting it into smaller scheduled tasks.'
        : 'Agent temporarily unavailable for scheduled task. Please try again later.',
    );
  }
}

/**
 * Acquire the `kind='job'` session lock before launching a background job.
 *
 * Mirrors the router's tryAcquireSessionLock. Pre-acquiring closes the gap
 * between promotion and the runner's first renewal (~60s of Fargate cold
 * start); without it a user message arriving in that window would start a
 * second turn against the same session the job is about to resume.
 *
 * Returns null when the lock is contended (someone else owns the session —
 * skip promotion), or a token to pass to the runner, which renews it every 10
 * minutes and releases it on exit.
 *
 * NOTE the deliberate asymmetry with the router: if the table is unset or
 * DynamoDB errors, the router falls through to a pass-through token so a user's
 * message is never blocked. Here we return null and DO NOT promote. An
 * unlockable background job is worse than no background job: nothing would stop
 * a concurrent turn from corrupting the session it resumes, and a scheduled
 * task has no human watching to notice.
 */
async function tryAcquireJobLock(
  sessionId: string,
  log: Logger,
): Promise<string | null> {
  const tableName = process.env.SESSION_LOCKS_TABLE;
  if (!tableName) {
    log.warn('Job promotion skipped — SESSION_LOCKS_TABLE not configured');
    return null;
  }
  const lockToken = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          sessionId,
          expiresAt: nowS + 14 * 60,
          lockToken,
          kind: 'job',
          claimedAt: new Date().toISOString(),
        },
        ConditionExpression:
          'attribute_not_exists(sessionId) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': nowS },
      }),
    );
    return lockToken;
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') {
      log.warn('Job promotion aborted — session lock contended');
      return null;
    }
    log.warn('Job promotion aborted — session lock acquire failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Release a job lock we acquired but could not hand to a running task.
 * Conditional on the token so we can never delete a newer holder's lock.
 */
async function releaseJobLock(
  sessionId: string,
  lockToken: string,
  log: Logger,
): Promise<void> {
  const tableName = process.env.SESSION_LOCKS_TABLE;
  if (!tableName) return;
  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { sessionId },
        ConditionExpression: 'lockToken = :tok',
        ExpressionAttributeValues: { ':tok': lockToken },
      }),
    );
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') return;
    log.warn('Job lock release failed; relying on TTL backstop', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Promote a recoverable scheduled turn to the background job-runner.
 *
 * A deadline resumes the same AgentCore session. Context overflow restarts in
 * a derived fresh session because resuming the overflowing transcript would
 * fail again. Both paths use the same ECS runner and post the finished answer
 * to the owner's Chat space.
 *
 * Returns true when the job launched — the caller must then NOT post the
 * partial, or the owner gets two messages for one task.
 *
 * Returns false on ANY failure (missing config, lock contention, RunTask
 * error), and the caller falls back to today's behaviour of posting what the
 * agent managed to produce. Promotion must never make things worse than the
 * status quo.
 */
interface ScheduledJobInput {
  sessionId: string;
  runtimeId: string;
  userEmail: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  originalPrompt: string;
  scheduleName: string;
  reason: PromotionReason;
}

interface JobRunnerConfig {
  clusterArn: string;
  taskDefArn: string;
  subnets: string[];
  securityGroup: string;
  containerName: string;
}

function readJobRunnerConfig(log: Logger): JobRunnerConfig | null {
  const config = {
    clusterArn: process.env.JOB_CLUSTER_ARN || '',
    taskDefArn: process.env.JOB_TASK_DEF_ARN || '',
    subnets: (process.env.JOB_SUBNETS || '').split(',').filter(Boolean),
    securityGroup: process.env.JOB_SECURITY_GROUP || '',
    containerName: process.env.JOB_CONTAINER_NAME || 'job-runner',
  };
  if (
    !config.clusterArn
    || !config.taskDefArn
    || config.subnets.length === 0
    || !config.securityGroup
  ) {
    log.warn('Job promotion not configured — posting the partial instead');
    return null;
  }
  return config;
}

async function launchScheduledJob(
  input: ScheduledJobInput,
  lockToken: string,
  config: JobRunnerConfig,
  log: Logger,
): Promise<void> {
  const payload = buildJobPayload({
    sessionId: input.sessionId,
    reason: input.reason,
    lockToken,
    runtimeId: input.runtimeId,
    userEmail: input.userEmail,
    displayName: input.displayName,
    workspacePrefix: input.workspacePrefix,
    spaceName: input.spaceName,
    // Scheduled tasks always deliver to the owner's DM, never a shared space.
    isDM: true,
    originalPrompt: input.originalPrompt,
  });
  const result = await ecsClient.send(
    new RunTaskCommand({
      cluster: config.clusterArn,
      taskDefinition: config.taskDefArn,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'agent-cron-promotion',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.subnets,
          securityGroups: [config.securityGroup],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: config.containerName,
            environment: [{ name: 'JOB_PAYLOAD', value: payload }],
          },
        ],
      },
    }),
  );
  if (result.failures && result.failures.length > 0) {
    throw new Error(
      `RunTask failures: ${result.failures
        .map((failure) => {
          const detail = failure.detail ? ` (${failure.detail})` : '';
          return `${failure.reason ?? 'unknown'}${detail}`;
        })
        .join('; ')}`,
    );
  }
  log.info('Scheduled turn promoted to background job', {
    marker: 'BACKGROUND_PROMOTION',
    source: 'cron',
    reason: input.reason,
    scheduleName: input.scheduleName,
    sessionId: input.sessionId,
    taskArn: result.tasks?.[0]?.taskArn ?? 'unknown',
  });
}

async function promoteScheduledTurnToJob(
  input: ScheduledJobInput,
  log: Logger,
): Promise<boolean> {
  const config = readJobRunnerConfig(log);
  if (!config) return false;
  const lockToken = await tryAcquireJobLock(input.sessionId, log);
  if (lockToken === null) return false;
  try {
    await launchScheduledJob(input, lockToken, config, log);
    return true;
  } catch (error) {
    // Roll the lock back, or the owner's next message sits behind a job that
    // never started until the 14-minute TTL expires.
    await releaseJobLock(input.sessionId, lockToken, log);
    log.error('Job promotion failed — posting the partial instead', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
  /**
   * 'promoted' means this leg handed the work to the background job-runner;
   * the answer is delivered by that task, not here. It is neither a success
   * (nothing was produced yet) nor an error (nothing broke), and recording it
   * as either would make run history lie about what happened.
   *
   * Safe without a migration: agent_scheduled_runs.status is VARCHAR(32) with
   * no CHECK constraint (schema/066-agent-operations-tables.sql).
   */
  status: 'success' | 'error' | 'skipped' | 'promoted';
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

type HandlerResult = {
  status: 'success' | 'error' | 'skipped';
  scheduleId: string;
};

interface ScheduledResultContext {
  schedule: AuthorizedSchedule;
  scheduleName: string;
  startTime: number;
  sessionId: string;
  result: InvokeResult;
  log: Logger;
}

async function sendPromotionAcknowledgement(
  context: ScheduledResultContext,
  reason: PromotionReason,
): Promise<void> {
  const { schedule, scheduleName, log } = context;
  const acknowledgement =
    reason === 'context-overflow'
      ? "⏳ This run grew too large to finish in one pass, so I'm starting it over in the background with a longer budget. I'll post the result here when it's done."
      : "⏳ This is taking longer than one pass allows — I've moved it to a background job and will post the result here when it's done.";
  try {
    await sendChatMessage(
      schedule.dmSpaceName,
      `📋 **${scheduleName}**\n\n${acknowledgement}`,
      log,
    );
  } catch (error) {
    // The job is already running, so acknowledgement delivery is best-effort.
    log.warn('Promotion ack delivery failed; job still running', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordPromotedRun(
  context: ScheduledResultContext,
): Promise<void> {
  const { schedule, scheduleName, sessionId, result, startTime, log } = context;
  await recordRun(
    {
      userEmail: schedule.ownerEmail,
      scheduleId: schedule.scheduleId,
      scheduleName,
      sessionId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startTime,
      status: 'promoted',
    },
    log,
  );
  log.info('Scheduled task handed to background job', {
    scheduleId: schedule.scheduleId,
    scheduleName,
    sessionId,
    email: sanitizeEmail(schedule.ownerEmail),
    latencyMs: Date.now() - startTime,
  });
}

async function tryPromoteScheduledResult(
  context: ScheduledResultContext,
): Promise<boolean> {
  const { schedule, scheduleName, sessionId, result, log } = context;
  const reason = promotionReason(result.errorClass);
  if (reason === null) return false;
  const runtimeId = await getRuntimeId(log);
  if (!runtimeId) return false;
  const promoted = await promoteScheduledTurnToJob(
    {
      sessionId,
      runtimeId,
      userEmail: schedule.ownerEmail,
      displayName: schedule.displayName ?? '',
      workspacePrefix: schedule.workspacePrefix,
      spaceName: schedule.dmSpaceName,
      originalPrompt: schedule.prompt,
      scheduleName,
      reason,
    },
    log,
  );
  if (!promoted) return false;
  await sendPromotionAcknowledgement(context, reason);
  await recordPromotedRun(context);
  return true;
}

async function deliverScheduledResult(
  context: ScheduledResultContext,
): Promise<HandlerResult> {
  const { schedule, scheduleName, sessionId, result, startTime, log } = context;
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(
  event: ScheduleReferenceEvent,
  context: LambdaContext,
): Promise<HandlerResult> {
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

  const result = await invokeAgentCore({
    prompt: schedule.prompt,
    userEmail: schedule.ownerEmail,
    sessionId,
    log,
    userContext: {
      displayName: schedule.displayName,
      workspacePrefix: schedule.workspacePrefix,
    },
    remainingMs: () => context.getRemainingTimeInMillis(),
  });

  const scheduledResult = {
    schedule,
    scheduleName,
    startTime,
    sessionId,
    result,
    log,
  };
  if (await tryPromoteScheduledResult(scheduledResult)) {
    return { status: 'success', scheduleId: schedule.scheduleId };
  }
  return deliverScheduledResult(scheduledResult);
}
