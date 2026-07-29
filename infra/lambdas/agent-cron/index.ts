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
 *     version: 3,
 *     scheduledTime: "2026-07-28T15:00:00Z"
 *   }
 *
 * Cron loads the authoritative DynamoDB row and validates owner, version,
 * enabled state, prompt, and delivery destination before invoking anything.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  type RunTaskCommandInput,
} from '@aws-sdk/client-ecs';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import type {
  Context as LambdaContext,
  SQSEvent,
} from 'aws-lambda';
import { resolveAbortMs, resolveTurnDeadlineS } from './turn-deadline';
import {
  buildJobPayload,
  promotionReason,
  type PromotionReason,
} from './job-promotion';
import * as chatPkg from '@googleapis/chat';
import * as crypto from 'node:crypto';
import {
  ExecuteStatementCommand,
  RDSDataClient,
} from '@aws-sdk/client-rds-data';
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
import {
  JobLockAcquisitionError,
  renewJobLock,
  runWithJobLock,
  type JobLockFailure,
  type LockedJobExecution,
  type LockedJobResult,
} from './job-lock';
import {
  createPromotedRun,
  createRunTelemetry,
  isPromotedRunPending,
  reservePromotedRunId,
  updatePromotedRunTerminal,
} from './run-telemetry';
import { runSchedulePreflight } from './schedule-preflight';
import {
  beginScheduleFireExecution,
  claimScheduleFire,
  completeScheduleFire,
  releaseScheduleFire,
  resolveScheduleLockContention,
  scheduleFireIdentity,
  scheduleFireLaunchIdentity,
  ScheduleFireExecutionError,
  scheduledRunStartedBy,
  type ScheduleFireClaim,
  type ScheduleFireFailure,
  type ScheduleFireIdentity,
} from './schedule-fire';
import { sanitizeEmailForLog } from './log-sanitization';
import {
  isJobRunnerStoppedEvent,
  monitorStoppedJob,
  type JobRunnerStoppedEvent,
} from './job-monitor';
import {
  findRunTaskByStartedBy,
  reconcileRunTaskLaunch,
  type RunTaskAttempt,
  type RunTaskLookupDependencies,
} from './run-task-reconciliation';
import {
  parseScheduledRunReconciliationMessage,
  reconcileScheduledRun,
  SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS,
  type ScheduledRunReconciliationMessage,
} from './scheduled-run-reconciliation';
import { sanitizeDiagnostic } from './diagnostic-sanitization';

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
const sqsClient = new SQSClient({});
const RDS_DATA_REQUEST_TIMEOUT_MS = 30_000;
const runTelemetryRdsClient = {
  execute: (input: ConstructorParameters<typeof ExecuteStatementCommand>[0]) =>
    rdsDataClient.send(
      new ExecuteStatementCommand(input),
      {
        abortSignal: AbortSignal.timeout(RDS_DATA_REQUEST_TIMEOUT_MS),
      },
    ),
};
const jobLockDynamoClient = {
  put: (input: ConstructorParameters<typeof PutCommand>[0]) =>
    dynamoClient.send(new PutCommand(input)),
  get: (input: ConstructorParameters<typeof GetCommand>[0]) =>
    dynamoClient.send(new GetCommand(input)),
  delete: (input: ConstructorParameters<typeof DeleteCommand>[0]) =>
    dynamoClient.send(new DeleteCommand(input)),
  update: (input: ConstructorParameters<typeof UpdateCommand>[0]) =>
    dynamoClient.send(new UpdateCommand(input)),
};
const scheduleFireDynamoClient = {
  ...jobLockDynamoClient,
  get: (input: ConstructorParameters<typeof GetCommand>[0]) =>
    dynamoClient.send(new GetCommand(input)),
};
const scheduleRecordDynamoClient = {
  get: (input: ConstructorParameters<typeof GetCommand>[0]) =>
    dynamoClient.send(new GetCommand(input)),
};

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
const SESSION_LOCKS_TABLE = process.env.SESSION_LOCKS_TABLE || '';
const JOB_CONTAINER_NAME = process.env.JOB_CONTAINER_NAME || 'job-runner';
const SCHEDULE_RECONCILIATION_QUEUE_URL =
  process.env.SCHEDULE_RECONCILIATION_QUEUE_URL || '';

const runTelemetry = createRunTelemetry(
  {
    databaseResourceArn: DATABASE_RESOURCE_ARN,
    databaseSecretArn: DATABASE_SECRET_ARN,
    databaseName: DATABASE_NAME,
  },
  runTelemetryRdsClient,
);

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
 * Promote a recoverable scheduled turn to the background job-runner.
 *
 * A deadline resumes the same AgentCore session. Context overflow restarts in
 * a derived fresh session because resuming the overflowing transcript would
 * fail again. Both paths use the same ECS runner and post the finished answer
 * to the owner's Chat space.
 *
 * Returns a structured outcome. The caller reports every abort to
 * agent_failures, then falls back to posting the partial response.
 */
interface ScheduledJobInput {
  sessionId: string;
  scheduleId: string;
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

interface ScheduledJobLaunchIdentity {
  clientToken: string;
  startedBy: string;
}

// The resolver is delivered eight minutes after it is queued. The promoted-row
// insert is bounded to 30 seconds and each of two idempotent RunTask attempts
// to 20 seconds, so even the latest possible acceptance precedes the resolver
// by well over ECS's documented five-minute consistency backoff window.
const RUN_TASK_ATTEMPT_TIMEOUT_MS = 20_000;

interface LaunchScheduledJobOptions {
  input: ScheduledJobInput;
  lockToken: string;
  scheduledRunId: string;
  fireKey?: string;
  launchIdentity: ScheduledJobLaunchIdentity;
  config: JobRunnerConfig;
  log: Logger;
}

interface PromoteScheduledTurnOptions {
  input: ScheduledJobInput;
  lockToken: string;
  fireIdentity: ScheduleFireIdentity | null;
  log: Logger;
  reserveRun: () => Promise<string>;
  prepareLaunch: (
    scheduledRunId: string,
    launchIdentity: ScheduledJobLaunchIdentity,
  ) => Promise<void>;
  persistRun: (scheduledRunId: string) => Promise<void>;
  afterLaunchFailure: (
    scheduledRunId: string,
    errorMessage: string,
  ) => Promise<void>;
}

type PromotionResult =
  | {
      promoted: true;
      /** Present when ECS accepted state could not be resolved safely. */
      ambiguity?: string;
    }
  | {
      promoted: false;
      phase:
        | 'job-runner-config'
        | 'lock-config'
        | 'lock-renew'
        | 'run-telemetry'
        | 'reconciliation-enqueue'
        | 'run-task';
      severity: 'error' | 'warn';
      errorMessage: string;
    };

type PromotionPreparation =
  | {
      prepared: true;
      scheduledRunId: string;
      launchIdentity: ScheduledJobLaunchIdentity;
    }
  | {
      prepared: false;
      failure: Extract<PromotionResult, { promoted: false }>;
    };

class AmbiguousRunTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousRunTaskError';
  }
}

function errorDetail(error: unknown): string {
  return sanitizeDiagnostic(
    error instanceof Error ? error.message : String(error),
  );
}

async function prepareScheduledJobPromotion(
  options: PromoteScheduledTurnOptions,
): Promise<PromotionPreparation> {
  const {
    fireIdentity,
    lockToken,
    log,
    reserveRun,
    prepareLaunch,
    persistRun,
  } = options;
  let scheduledRunId: string;
  try {
    // Reserve the exact future row ID without creating any non-terminal state.
    scheduledRunId = await reserveRun();
  } catch (error) {
    const detail = errorDetail(error);
    log.error('Job promotion telemetry failed — posting the partial instead', {
      error: detail,
    });
    return {
      prepared: false,
      failure: {
        promoted: false,
        phase: 'run-telemetry',
        severity: 'error',
        errorMessage: `Promotion telemetry failed: ${detail}`,
      },
    };
  }
  const launchIdentity = fireIdentity
    ? scheduleFireLaunchIdentity(fireIdentity)
    : legacyScheduledJobLaunchIdentity(lockToken);
  try {
    // Install the delayed, durable resolver before making the side effect.
    await prepareLaunch(scheduledRunId, launchIdentity);
  } catch (error) {
    const detail = errorDetail(error);
    log.error(
      'Job promotion reconciliation could not be prepared — task not launched',
      { error: detail },
    );
    return {
      prepared: false,
      failure: {
        promoted: false,
        phase: 'reconciliation-enqueue',
        severity: 'error',
        errorMessage: `Promotion reconciliation setup failed: ${detail}`,
      },
    };
  }
  try {
    // The durable resolver already carries this reserved ID. A hard crash
    // before/during this insert either leaves no row or a row the resolver can
    // close; no promoted row can exist without a resolver.
    await persistRun(scheduledRunId);
  } catch (error) {
    const detail = errorDetail(error);
    log.error('Job promotion telemetry failed — task not launched', {
      error: detail,
    });
    return {
      prepared: false,
      failure: {
        promoted: false,
        phase: 'run-telemetry',
        severity: 'error',
        errorMessage: `Promotion telemetry failed: ${detail}`,
      },
    };
  }
  return { prepared: true, scheduledRunId, launchIdentity };
}

function readJobRunnerConfig(log: Logger): JobRunnerConfig | null {
  const config = {
    clusterArn: process.env.JOB_CLUSTER_ARN || '',
    taskDefArn: process.env.JOB_TASK_DEF_ARN || '',
    subnets: (process.env.JOB_SUBNETS || '').split(',').filter(Boolean),
    securityGroup: process.env.JOB_SECURITY_GROUP || '',
    containerName: JOB_CONTAINER_NAME,
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

function legacyScheduledJobLaunchIdentity(
  lockToken: string,
): ScheduledJobLaunchIdentity {
  const digest = crypto
    .createHash('sha256')
    .update(`legacy-scheduled-lock#${lockToken}`)
    .digest('hex');
  return {
    clientToken: lockToken,
    startedBy: scheduledRunStartedBy(digest),
  };
}

function ecsTaskLookupDependencies(
  clusterArn: string,
  startedBy: string,
): RunTaskLookupDependencies {
  return {
    startedBy,
    // ECS requires startedBy to be the only ListTasks filter. With no status
    // filter this returns live tasks for the exact schedule fire.
    listRunningTasks: async () => {
      const result = await ecsClient.send(
        new ListTasksCommand({
          cluster: clusterArn,
          startedBy,
        }),
      );
      return result.taskArns ?? [];
    },
    // Stopped tasks cannot be queried with startedBy. Page through the bounded
    // recent STOPPED set, then DescribeTasks and filter the exact startedBy.
    listStoppedTasks: async (nextToken) => {
      const result = await ecsClient.send(
        new ListTasksCommand({
          cluster: clusterArn,
          desiredStatus: 'STOPPED',
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        }),
      );
      return {
        taskArns: result.taskArns ?? [],
        ...(result.nextToken ? { nextToken: result.nextToken } : {}),
      };
    },
    describeTasks: async (taskArns) => {
      const result = await ecsClient.send(
        new DescribeTasksCommand({
          cluster: clusterArn,
          tasks: taskArns,
        }),
      );
      return result.tasks?.map((task) => ({
        ...(task.taskArn ? { taskArn: task.taskArn } : {}),
        ...(task.startedBy ? { startedBy: task.startedBy } : {}),
      })) ?? [];
    },
  };
}

async function launchScheduledJob(
  options: LaunchScheduledJobOptions,
): Promise<void> {
  const {
    input,
    lockToken,
    scheduledRunId,
    fireKey,
    launchIdentity,
    config,
    log,
  } = options;
  const payload = buildJobPayload({
    sessionId: input.sessionId,
    reason: input.reason,
    lockToken,
    runtimeId: input.runtimeId,
    userEmail: input.userEmail,
    displayName: input.displayName,
    workspacePrefix: input.workspacePrefix,
    spaceName: input.spaceName,
    scheduleId: input.scheduleId,
    scheduleName: input.scheduleName,
    scheduledRunId,
    fireKey,
    // Scheduled tasks always deliver to the owner's DM, never a shared space.
    isDM: true,
    originalPrompt: input.originalPrompt,
  });
  const runTaskInput = {
    cluster: config.clusterArn,
    taskDefinition: config.taskDefArn,
    launchType: 'FARGATE',
    count: 1,
    clientToken: launchIdentity.clientToken,
    startedBy: launchIdentity.startedBy,
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
  } satisfies RunTaskCommandInput;
  const launch = await reconcileRunTaskLaunch({
    ...ecsTaskLookupDependencies(
      config.clusterArn,
      launchIdentity.startedBy,
    ),
    runTask: async (): Promise<RunTaskAttempt> => {
      const result = await ecsClient.send(
        new RunTaskCommand(runTaskInput),
        {
          abortSignal: AbortSignal.timeout(RUN_TASK_ATTEMPT_TIMEOUT_MS),
        },
      );
      return {
        taskArns: result.tasks
          ?.map((task) => task.taskArn)
          .filter((taskArn): taskArn is string => !!taskArn) ?? [],
        failures: result.failures?.map((failure) => ({
          ...(failure.reason ? { reason: failure.reason } : {}),
          ...(failure.detail ? { detail: failure.detail } : {}),
        })) ?? [],
      };
    },
    wait: (delayMs) =>
      new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      }),
  });
  if (launch.status === 'ambiguous') {
    throw new AmbiguousRunTaskError(launch.errorMessage);
  }
  if (launch.status === 'rejected') {
    throw new Error(launch.errorMessage);
  }
  log.info('Scheduled turn promoted to background job', {
    marker: 'BACKGROUND_PROMOTION',
    source: 'cron',
    reason: input.reason,
    scheduleName: input.scheduleName,
    sessionId: input.sessionId,
    taskArn: launch.taskArn,
    startedBy: launchIdentity.startedBy,
    reconciled: launch.reconciled,
  });
}

async function promoteScheduledTurnToJob(
  options: PromoteScheduledTurnOptions,
): Promise<PromotionResult> {
  const {
    input,
    lockToken,
    log,
    afterLaunchFailure,
  } = options;
  const config = readJobRunnerConfig(log);
  if (!config) {
    return {
      promoted: false,
      phase: 'job-runner-config',
      severity: 'error',
      errorMessage: 'Background job runner configuration is incomplete',
    };
  }
  const renewal = await renewJobLock(
    input.sessionId,
    lockToken,
    SESSION_LOCKS_TABLE,
    jobLockDynamoClient,
    log,
  );
  if (!renewal.acquired) {
    return {
      promoted: false,
      phase: renewal.phase === 'lock-config' ? 'lock-config' : 'lock-renew',
      severity: renewal.severity,
      errorMessage: renewal.errorMessage,
    };
  }
  const preparation = await prepareScheduledJobPromotion(options);
  if (!preparation.prepared) return preparation.failure;
  const { scheduledRunId, launchIdentity } = preparation;
  try {
    await launchScheduledJob({
      input,
      lockToken,
      scheduledRunId,
      fireKey: options.fireIdentity?.key,
      launchIdentity,
      config,
      log,
    });
    return { promoted: true };
  } catch (error) {
    const detail = errorDetail(error);
    let errorMessage = `RunTask failed: ${detail}`;
    if (error instanceof AmbiguousRunTaskError) {
      // An accepted task may already own this payload. Do not terminalize its
      // row or post the partial: either action can conflict with the eventual
      // full result. Retain the lock and expose the uncertainty to monitoring.
      log.error('Job promotion outcome is ambiguous — retaining the job state', {
        error: detail,
      });
      return { promoted: true, ambiguity: detail };
    }
    log.error('Job promotion failed — posting the partial instead', {
      error: detail,
    });
    try {
      // No task exists to emit STOPPED, so close the exact promoted row before
      // falling back to the partial response. The later ordinary terminal row
      // remains the latest per-fire result shown to users.
      await afterLaunchFailure(scheduledRunId, errorMessage);
    } catch (terminalError) {
      const detail = terminalError instanceof Error
        ? terminalError.message
        : String(terminalError);
      log.error('Failed to terminalize rejected job promotion', {
        scheduledRunId,
        error: detail,
      });
      errorMessage += `; terminal telemetry failed: ${detail}`;
    }
    return {
      promoted: false,
      phase: 'run-task',
      severity: 'error',
      errorMessage,
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

type HandlerResult = {
  status: 'success' | 'error' | 'skipped';
  scheduleId: string;
};

interface ScheduledResultContext {
  schedule: AuthorizedSchedule;
  scheduleName: string;
  startTime: number;
  sessionId: string;
  fireIdentity: ScheduleFireIdentity | null;
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
      error: errorDetail(error),
    });
  }
}

async function sendPromotionAmbiguityAcknowledgement(
  context: ScheduledResultContext,
): Promise<void> {
  const { schedule, scheduleName, log } = context;
  try {
    await sendChatMessage(
      schedule.dmSpaceName,
      `📋 **${scheduleName}**\n\n` +
        "⚠️ The background launch response was interrupted, so I couldn't " +
        "safely confirm whether it started. I won't launch it again and risk " +
        'duplicating work. If it did start, I will post the result here; ' +
        'the uncertainty has been recorded for monitoring.',
      log,
    );
  } catch (error) {
    log.warn('Promotion ambiguity acknowledgement failed', {
      error: errorDetail(error),
    });
  }
}

async function recordPromotedRun(
  context: ScheduledResultContext,
  scheduledRunId: string,
): Promise<void> {
  const { schedule, scheduleName, sessionId, result, startTime, log } = context;
  await createPromotedRun(
    {
      databaseResourceArn: DATABASE_RESOURCE_ARN,
      databaseSecretArn: DATABASE_SECRET_ARN,
      databaseName: DATABASE_NAME,
    },
    runTelemetryRdsClient,
    {
      scheduledRunId,
      fireKey: context.fireIdentity?.key,
      userEmail: schedule.ownerEmail,
      scheduleId: schedule.scheduleId,
      scheduleName,
      sessionId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startTime,
      status: 'promoted',
    },
  );
  log.info('Scheduled task promotion state persisted', {
    scheduledRunId,
    scheduleId: schedule.scheduleId,
    scheduleName,
    sessionId,
    email: sanitizeEmailForLog(schedule.ownerEmail),
    latencyMs: Date.now() - startTime,
  });
}

async function reservePromotionRunId(): Promise<string> {
  return reservePromotedRunId(
    {
      databaseResourceArn: DATABASE_RESOURCE_ARN,
      databaseSecretArn: DATABASE_SECRET_ARN,
      databaseName: DATABASE_NAME,
    },
    runTelemetryRdsClient,
  );
}

async function recordPromotionLaunchFailure(
  context: ScheduledResultContext,
  scheduledRunId: string,
  errorMessage: string,
): Promise<void> {
  const { schedule, scheduleName, sessionId, log } = context;
  const fireKey =
    context.fireIdentity?.key ?? `scheduled-run#${scheduledRunId}`;
  // RunTask rejected the request, so no ECS supervisor can repair this path.
  // Write the idempotent failure mirror before terminalizing the promoted row:
  // a failure keeps the row pending for retry, while a later terminalization
  // failure can safely upsert this same fire on the next invocation.
  await runTelemetry.recordCronFailureStrict(
    {
      userEmail: schedule.ownerEmail,
      scheduleId: schedule.scheduleId,
      fireKey,
      scheduleName,
      sessionId,
      errorMessage,
      severity: 'error',
      context: {
        phase: 'run-task',
        scheduledRunId,
      },
    },
    log,
  );
  await updatePromotedRunTerminal(
    {
      databaseResourceArn: DATABASE_RESOURCE_ARN,
      databaseSecretArn: DATABASE_SECRET_ARN,
      databaseName: DATABASE_NAME,
    },
    runTelemetryRdsClient,
    {
      scheduledRunId,
      fireKey,
      userEmail: schedule.ownerEmail,
      scheduleId: schedule.scheduleId,
      scheduleName,
      sessionId,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: 'error',
      errorMessage,
    },
  );
  log.info('Rejected job promotion terminalized', {
    scheduledRunId,
    scheduleId: schedule.scheduleId,
    sessionId,
    email: sanitizeEmailForLog(schedule.ownerEmail),
  });
}

async function enqueuePromotionReconciliation(
  context: ScheduledResultContext,
  scheduledRunId: string,
  launchIdentity: ScheduledJobLaunchIdentity,
): Promise<void> {
  const { schedule, scheduleName, sessionId, log } = context;
  const message: ScheduledRunReconciliationMessage = {
    type: 'scheduled-run-reconciliation',
    scheduledRunId,
    fireKey:
      context.fireIdentity?.key ?? `scheduled-run#${scheduledRunId}`,
    userEmail: schedule.ownerEmail,
    scheduleId: schedule.scheduleId,
    scheduleName,
    sessionId,
    startedBy: launchIdentity.startedBy,
  };
  try {
    if (!SCHEDULE_RECONCILIATION_QUEUE_URL) {
      throw new Error(
        'SCHEDULE_RECONCILIATION_QUEUE_URL is not configured',
      );
    }
    const result = await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: SCHEDULE_RECONCILIATION_QUEUE_URL,
        DelaySeconds: SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS,
        MessageBody: JSON.stringify(message),
      }),
    );
    if (!result.MessageId) {
      throw new Error('SQS accepted no reconciliation message ID');
    }
    log.info('Delayed promotion reconciliation queued', {
      scheduledRunId,
      scheduleId: schedule.scheduleId,
      startedBy: launchIdentity.startedBy,
      messageId: result.MessageId,
      delaySeconds: SCHEDULED_RUN_RECONCILIATION_DELAY_SECONDS,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Delayed promotion reconciliation enqueue failed: ` +
        detail,
      { cause: error },
    );
  }
}

async function tryPromoteScheduledResult(
  context: ScheduledResultContext,
  lockToken: string,
): Promise<boolean> {
  const { schedule, scheduleName, sessionId, result, log } = context;
  const reason = promotionReason(result.errorClass);
  if (reason === null) return false;
  const runtimeId = await getRuntimeId(log);
  if (!runtimeId) {
    await runTelemetry.recordCronFailure(
      {
        userEmail: schedule.ownerEmail,
        scheduleId: schedule.scheduleId,
        fireKey: context.fireIdentity?.key,
        scheduleName,
        sessionId,
        errorMessage: 'AgentCore Runtime ID is unavailable for job promotion',
        context: {
          phase: 'runtime-config',
          promotionReason: reason,
        },
      },
      log,
    );
    return false;
  }
  const promotion = await promoteScheduledTurnToJob({
    input: {
      sessionId,
      scheduleId: schedule.scheduleId,
      runtimeId,
      userEmail: schedule.ownerEmail,
      displayName: schedule.displayName ?? '',
      workspacePrefix: schedule.workspacePrefix,
      spaceName: schedule.dmSpaceName,
      originalPrompt: schedule.prompt,
      scheduleName,
      reason,
    },
    lockToken,
    fireIdentity: context.fireIdentity,
    log,
    reserveRun: reservePromotionRunId,
    prepareLaunch: (scheduledRunId, launchIdentity) =>
      enqueuePromotionReconciliation(
        context,
        scheduledRunId,
        launchIdentity,
      ),
    persistRun: (scheduledRunId) =>
      recordPromotedRun(context, scheduledRunId),
    afterLaunchFailure: (scheduledRunId, errorMessage) =>
      recordPromotionLaunchFailure(context, scheduledRunId, errorMessage),
  });
  if (promotion.promoted && promotion.ambiguity) {
    await runTelemetry.recordCronFailure(
      {
        userEmail: schedule.ownerEmail,
        scheduleId: schedule.scheduleId,
        fireKey: context.fireIdentity?.key,
        scheduleName,
        sessionId,
        errorMessage: promotion.ambiguity,
        severity: 'error',
        context: {
          phase: 'run-task-ambiguous',
          promotionReason: reason,
        },
      },
      log,
    );
    await sendPromotionAmbiguityAcknowledgement(context);
    return true;
  }
  if (!promotion.promoted) {
    await runTelemetry.recordCronFailure(
      {
        userEmail: schedule.ownerEmail,
        scheduleId: schedule.scheduleId,
        fireKey: context.fireIdentity?.key,
        scheduleName,
        sessionId,
        errorMessage: promotion.errorMessage,
        severity: promotion.severity,
        context: {
          phase: promotion.phase,
          promotionReason: reason,
        },
      },
      log,
    );
    return false;
  }
  await sendPromotionAcknowledgement(context, reason);
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
    const detail = errorDetail(error);
    log.error('Failed to deliver scheduled response', {
      error: detail,
    });
    await runTelemetry.recordRun(
      {
        fireKey: context.fireIdentity?.key,
        userEmail: schedule.ownerEmail,
        scheduleId: schedule.scheduleId,
        scheduleName,
        sessionId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startTime,
        status: 'error',
        errorMessage: `Chat delivery failed: ${detail}`,
      },
      log,
    );
    return { status: 'error', scheduleId: schedule.scheduleId };
  }
  const status: 'success' | 'error' = result.ok ? 'success' : 'error';
  await runTelemetry.recordRun(
    {
      fireKey: context.fireIdentity?.key,
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
    email: sanitizeEmailForLog(schedule.ownerEmail),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: Date.now() - startTime,
  });
  return { status, scheduleId: schedule.scheduleId };
}

interface LockedScheduleContext {
  schedule: AuthorizedSchedule;
  scheduleName: string;
  sessionId: string;
  startTime: number;
  fireIdentity: ScheduleFireIdentity | null;
  lambdaContext: LambdaContext;
  log: Logger;
}

async function executeLockedScheduledTurn(
  context: LockedScheduleContext,
  lockToken: string,
): Promise<LockedJobExecution<HandlerResult>> {
  const {
    schedule,
    scheduleName,
    sessionId,
    startTime,
    lambdaContext,
    log,
  } = context;
  log.info('Invoking agent for scheduled task', {
    email: sanitizeEmailForLog(schedule.ownerEmail),
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
    remainingMs: () => lambdaContext.getRemainingTimeInMillis(),
  });
  const scheduledResult = {
    schedule,
    scheduleName,
    startTime,
    sessionId,
    fireIdentity: context.fireIdentity,
    result,
    log,
  };
  if (await tryPromoteScheduledResult(scheduledResult, lockToken)) {
    return {
      value: { status: 'success', scheduleId: schedule.scheduleId },
      retainLock: true,
    };
  }
  return {
    value: await deliverScheduledResult(scheduledResult),
    retainLock: false,
  };
}

type ScheduleGuardFailure = JobLockFailure | ScheduleFireFailure;

async function recordScheduleGuardFailure(
  context: Omit<LockedScheduleContext, 'lambdaContext'>,
  failure: ScheduleGuardFailure,
  status: HandlerResult['status'],
  durability: 'best-effort' | 'strict' = 'best-effort',
): Promise<HandlerResult> {
  const { schedule, scheduleName, sessionId, startTime, log } = context;
  await runTelemetry[
    durability === 'strict' ? 'recordRunStrict' : 'recordRun'
  ](
    {
      fireKey: context.fireIdentity?.key,
      userEmail: schedule.ownerEmail,
      scheduleId: schedule.scheduleId,
      scheduleName,
      sessionId,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      status,
      errorMessage: failure.errorMessage,
      failure: {
        severity: failure.severity,
        context: { phase: failure.phase },
      },
    },
    log,
  );
  return { status, scheduleId: schedule.scheduleId };
}

type OwnedScheduleFireClaim = Extract<
  ScheduleFireClaim,
  { claimed: true }
>;

async function acquireScheduleFireClaim(
  identity: ReturnType<typeof scheduleFireIdentity>,
  context: LockedScheduleContext,
): Promise<OwnedScheduleFireClaim | HandlerResult | null> {
  if (!identity) {
    context.log.warn(
      'Schedule target has no scheduled-time identity; contention will retry',
    );
    return null;
  }
  const claim = await claimScheduleFire(
    identity,
    SESSION_LOCKS_TABLE,
    scheduleFireDynamoClient,
    context.log,
  );
  if (claim.claimed) return claim;

  if (claim.failure.phase === 'fire-completed') {
    context.log.info('Completed duplicate schedule fire suppressed', {
      scheduleId: context.schedule.scheduleId,
    });
    return {
      status: 'skipped',
      scheduleId: context.schedule.scheduleId,
    };
  }
  if (!claim.failure.recordRun) {
    context.log.warn(
      'In-progress duplicate schedule fire will retry without run telemetry',
      {
        scheduleId: context.schedule.scheduleId,
        phase: claim.failure.phase,
      },
    );
    throw new Error(claim.failure.errorMessage);
  }
  const status = claim.failure.retryable ? 'error' : 'skipped';
  const result = await recordScheduleGuardFailure(
    context,
    claim.failure,
    status,
  );
  if (claim.failure.retryable) {
    throw new Error(claim.failure.errorMessage);
  }
  return result;
}

function isHandlerResult(
  value: OwnedScheduleFireClaim | HandlerResult | null,
): value is HandlerResult {
  return value !== null && 'status' in value;
}

async function runLockedScheduleTurn(
  context: LockedScheduleContext,
  fireClaim: OwnedScheduleFireClaim | null,
  onFireExecutionStarted: () => void,
): Promise<LockedJobResult<HandlerResult>> {
  try {
    return await runWithJobLock(
      context.sessionId,
      SESSION_LOCKS_TABLE,
      jobLockDynamoClient,
      context.log,
      {
        execute: async (lockToken) => {
          if (fireClaim) {
            await beginScheduleFireExecution(
              fireClaim,
              SESSION_LOCKS_TABLE,
              scheduleFireDynamoClient,
              context.log,
            );
            onFireExecutionStarted();
          }
          return executeLockedScheduledTurn(context, lockToken);
        },
        fireKey: fireClaim?.identity.key,
      },
    );
  } catch (error) {
    if (error instanceof JobLockAcquisitionError) {
      await recordScheduleGuardFailure(
        context,
        error.failure,
        'error',
      );
    }
    if (
      error instanceof ScheduleFireExecutionError
      && error.failure.recordRun
    ) {
      await recordScheduleGuardFailure(
        context,
        error.failure,
        'error',
      );
    }
    throw error;
  }
}

async function finalizeScheduleFire(
  context: LockedScheduleContext,
  fireClaim: OwnedScheduleFireClaim,
): Promise<void> {
  const completion = await completeScheduleFire(
    fireClaim,
    SESSION_LOCKS_TABLE,
    scheduleFireDynamoClient,
    context.log,
  );
  if (completion.persisted) return;

  // The scheduled turn has already reached a terminal external outcome. Make
  // the durability gap visible, but never release/retry the claim here: doing
  // so would replay AgentCore tools and Chat delivery after successful work.
  await recordScheduleGuardFailure(
    context,
    {
      phase: 'fire-completion',
      severity: 'error',
      errorMessage: completion.errorMessage,
      retryable: false,
      recordRun: true,
    },
    'error',
  );
}

async function handleScheduleLockContention(
  context: LockedScheduleContext,
  failure: JobLockFailure,
  fireClaim: OwnedScheduleFireClaim | null,
): Promise<HandlerResult> {
  const resolution = resolveScheduleLockContention(
    failure,
    fireClaim,
  );
  if (resolution.action === 'retry') {
    if (resolution.fireClaim) {
      await releaseScheduleFire(
        resolution.fireClaim,
        SESSION_LOCKS_TABLE,
        scheduleFireDynamoClient,
        context.log,
      );
    }
    await recordScheduleGuardFailure(context, resolution.failure, 'error');
    throw new JobLockAcquisitionError(resolution.failure);
  }
  let result: HandlerResult;
  try {
    result = await recordScheduleGuardFailure(
      context,
      resolution.failure,
      'skipped',
      'strict',
    );
  } catch (error) {
    await releaseScheduleFire(
      resolution.fireClaim,
      SESSION_LOCKS_TABLE,
      scheduleFireDynamoClient,
      context.log,
    );
    throw error;
  }
  // This is an intentional coalesce, not an unobserved success: the skipped
  // run/failure is durable before the distinct fire is marked complete.
  await finalizeScheduleFire(context, resolution.fireClaim);
  return result;
}

async function runGuardedScheduleTurn(
  context: LockedScheduleContext,
  fireClaim: OwnedScheduleFireClaim | null,
): Promise<HandlerResult> {
  let locked: LockedJobResult<HandlerResult>;
  let fireExecutionStarted = false;
  try {
    locked = await runLockedScheduleTurn(
      context,
      fireClaim,
      () => {
        fireExecutionStarted = true;
      },
    );
  } catch (error) {
    if (fireClaim && !fireExecutionStarted) {
      await releaseScheduleFire(
        fireClaim,
        SESSION_LOCKS_TABLE,
        scheduleFireDynamoClient,
        context.log,
      );
    }
    // Once beginScheduleFireExecution succeeds, AgentCore tools or Chat
    // delivery may already have produced external effects. Retain the
    // replay-blocking fire marker on every later exception; Lambda retries
    // observe it as executing instead of replaying the same occurrence.
    throw error;
  }
  if (!locked.executed) {
    return handleScheduleLockContention(
      context,
      locked.lock,
      fireClaim,
    );
  }
  if (fireClaim) await finalizeScheduleFire(context, fireClaim);
  return locked.value;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleJobRunnerStopped(
  event: JobRunnerStoppedEvent,
  log: Logger,
): Promise<HandlerResult> {
  return monitorStoppedJob(
    event,
    JOB_CONTAINER_NAME,
    {
      describeTask: async (clusterArn, taskArn) => {
        const result = await ecsClient.send(
          new DescribeTasksCommand({
            cluster: clusterArn,
            tasks: [taskArn],
          }),
        );
        if (result.failures && result.failures.length > 0) {
          throw new Error(
            `DescribeTasks failures: ${result.failures
              .map((failure) => failure.reason ?? failure.arn ?? 'unknown')
              .join('; ')}`,
          );
        }
        const task = result.tasks?.[0];
        if (!task) {
          throw new Error(`Stopped ECS task not found: ${taskArn}`);
        }
        return task;
      },
      writeRun: (record) =>
        updatePromotedRunTerminal(
          {
            databaseResourceArn: DATABASE_RESOURCE_ARN,
            databaseSecretArn: DATABASE_SECRET_ARN,
            databaseName: DATABASE_NAME,
          },
          runTelemetryRdsClient,
          record,
        ),
      recordFailure: (record) =>
        runTelemetry.recordCronFailureStrict(record, log),
    },
    log,
  );
}

function isSqsEvent(event: unknown): event is SQSEvent {
  if (!event || typeof event !== 'object') return false;
  const records = (event as { Records?: unknown }).Records;
  return Array.isArray(records)
    && records.length > 0
    && records.every(
      (record) =>
        !!record
        && typeof record === 'object'
        && (record as { eventSource?: unknown }).eventSource === 'aws:sqs',
    );
}

async function handleScheduledRunReconciliation(
  message: ScheduledRunReconciliationMessage,
  log: Logger,
): Promise<HandlerResult> {
  const clusterArn = process.env.JOB_CLUSTER_ARN || '';
  if (!clusterArn) {
    throw new Error(
      'JOB_CLUSTER_ARN is not configured for scheduled-run reconciliation',
    );
  }

  const reconciliation = await reconcileScheduledRun(message, {
    isPending: (pendingMessage) =>
      isPromotedRunPending(
        {
          databaseResourceArn: DATABASE_RESOURCE_ARN,
          databaseSecretArn: DATABASE_SECRET_ARN,
          databaseName: DATABASE_NAME,
        },
        runTelemetryRdsClient,
        {
          scheduledRunId: pendingMessage.scheduledRunId,
          userEmail: pendingMessage.userEmail,
          scheduleId: pendingMessage.scheduleId,
          sessionId: pendingMessage.sessionId,
        },
      ),
    findTask: (startedBy) =>
      findRunTaskByStartedBy(
        ecsTaskLookupDependencies(clusterArn, startedBy),
      ),
    terminalize: (record) =>
      updatePromotedRunTerminal(
        {
          databaseResourceArn: DATABASE_RESOURCE_ARN,
          databaseSecretArn: DATABASE_SECRET_ARN,
          databaseName: DATABASE_NAME,
        },
        runTelemetryRdsClient,
        record,
      ),
    recordFailure: (record) =>
      runTelemetry.recordCronFailureStrict(record, log),
  });
  if (reconciliation.status === 'task-found') {
    log.info('Delayed promotion reconciliation found the ECS task', {
      scheduledRunId: message.scheduledRunId,
      scheduleId: message.scheduleId,
      startedBy: message.startedBy,
      taskArn: reconciliation.taskArn,
    });
    return { status: 'success', scheduleId: message.scheduleId };
  }
  if (reconciliation.status === 'no-pending-run') {
    log.info('Delayed promotion reconciliation found no pending run row', {
      scheduledRunId: message.scheduledRunId,
      scheduleId: message.scheduleId,
    });
    return { status: 'success', scheduleId: message.scheduleId };
  }

  log.error('Delayed promotion reconciliation terminalized ambiguity', {
    scheduledRunId: message.scheduledRunId,
    scheduleId: message.scheduleId,
    startedBy: message.startedBy,
  });
  return { status: 'error', scheduleId: message.scheduleId };
}

async function handleScheduledRunReconciliationEvent(
  event: SQSEvent,
  requestId: string,
): Promise<HandlerResult> {
  let result: HandlerResult | null = null;
  for (const record of event.Records) {
    const message = parseScheduledRunReconciliationMessage(record.body);
    const log = createLogger({
      requestId,
      environment: ENVIRONMENT,
      scheduleId: message.scheduleId,
      scheduledRunId: message.scheduledRunId,
      reconciliationMessageId: record.messageId,
    });
    result = await handleScheduledRunReconciliation(message, log);
  }
  if (!result) {
    throw new Error('Scheduled-run reconciliation event had no records');
  }
  return result;
}

export async function handler(
  event: ScheduleReferenceEvent | JobRunnerStoppedEvent | SQSEvent,
  context: LambdaContext,
): Promise<HandlerResult> {
  const handlerStartedAt = Date.now();
  const requestId = generateRequestId();
  if (isSqsEvent(event)) {
    return handleScheduledRunReconciliationEvent(event, requestId);
  }
  if (isJobRunnerStoppedEvent(event)) {
    const log = createLogger({
      requestId,
      environment: ENVIRONMENT,
      taskArn: event.detail.taskArn,
    });
    return handleJobRunnerStopped(event, log);
  }
  const log = createLogger({
    requestId,
    environment: ENVIRONMENT,
    scheduleId:
      typeof event?.scheduleId === 'string' ? event.scheduleId : 'unknown',
  });
  const fireIdentity = scheduleFireIdentity(event);
  const { loaded, referencedScheduleId } = await runSchedulePreflight(event, {
    requestId,
    startedAt: handlerStartedAt,
    fireKey: fireIdentity?.key,
    load: () =>
      loadAuthorizedSchedule(event, scheduleRecordDynamoClient, SCHEDULES_TABLE),
    telemetry: runTelemetry,
    log,
  });
  if (!loaded.authorized) {
    return { status: 'skipped', scheduleId: referencedScheduleId };
  }
  const schedule = loaded.schedule;
  const scheduleName = schedule.name;
  const startTime = Date.now();

  log.info('Scheduled task started', {
    scheduleId: schedule.scheduleId,
    version: schedule.version,
    scheduleName,
    email: sanitizeEmailForLog(schedule.ownerEmail),
  });

  // Session ID — stable for a schedule within a calendar day and isolated from
  // interactive sessions. The shared ID lets the conditional lock serialize
  // repeated fires. Bound the length for AgentCore's session-id limits.
  const dateKey =
    fireIdentity?.scheduledTime.slice(0, 10)
    ?? new Date().toISOString().split('T')[0];
  const prefix = schedule.workspacePrefix.substring(0, 40);
  const sessionId =
    `${prefix}-sched-${schedule.scheduleId.substring(0, 12)}-${dateKey}`;

  const lockedContext = {
    schedule,
    scheduleName,
    sessionId,
    startTime,
    fireIdentity,
    lambdaContext: context,
    log,
  };

  const fireClaim = await acquireScheduleFireClaim(
    fireIdentity,
    lockedContext,
  );
  if (isHandlerResult(fireClaim)) return fireClaim;
  return runGuardedScheduleTurn(lockedContext, fireClaim);
}
