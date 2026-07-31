/**
 * Agent Router Lambda
 *
 * Core message pipeline for the PSD AI Agent Platform:
 *   Google Chat (Pub/Sub) → Router Lambda → Bedrock Guardrails → AgentCore → Google Chat API
 *
 * Flow:
 *   1. Receive Google Chat event via Pub/Sub (SNS/SQS trigger)
 *   2. Extract sender identity from event payload
 *   3. Validate sender belongs to allowed domain (@psd401.net)
 *   4. Look up user in DynamoDB (create record if new)
 *   5. Run message through Bedrock Guardrails (K-12 content safety)
 *   6. If blocked → respond with safety message, log to telemetry
 *   7. Invoke user's AgentCore session
 *   8. Log telemetry to Aurora (user, model, tokens, timestamp, latency)
 *   9. Send response back via Google Chat API
 *
 * Environment variables (injected by CDK):
 *   ENVIRONMENT            — dev/staging/prod
 *   USERS_TABLE            — DynamoDB table name
 *   GUARDRAIL_ID           — Bedrock Guardrail ID
 *   GUARDRAIL_VERSION      — Bedrock Guardrail version
 *   AGENTCORE_RUNTIME_ID   — AgentCore Runtime ID (resolved from SSM at runtime if not set;
 *                              the value is not known at CDK deploy time because the Runtime
 *                              is conditionally created only when an image tag is provided)
 *   DATABASE_RESOURCE_ARN  — Aurora cluster ARN
 *   DATABASE_SECRET_ARN    — Aurora credentials secret ARN
 *   DATABASE_NAME          — Aurora database name
 *   GOOGLE_CREDENTIALS_SECRET_ARN — Secrets Manager ARN for Google service account JSON
 *   TOKEN_LIMIT_PER_INTERACTION — Alerting threshold for token usage (default 100000)
 *   ALLOWED_DOMAINS        — Comma-separated list of allowed email domains (default: 'psd401.net')
 */

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import postgres from 'postgres';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { S3Client } from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand,
  type MessageAttributeValue,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Upload } from '@aws-sdk/lib-storage';
import { Context as LambdaContext, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import * as crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import * as chatPkg from '@googleapis/chat';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { classifyTopic, isPrivateMessage, isoWeek, type Topic } from './topic-classifier';
import { extractRichEnvelope } from './rich-envelope';
import {
  buildWorkspacePath,
  extractAttachments,
  type AgentAttachment,
  type ChatAnnotation,
  type ChatAttachment,
} from './attachments';
import {
  buildJobPayload,
  jobChatDeliveryContext,
  JOB_DEADLINE_S,
  JOB_INVOCATION_CONTEXT_TTL_S,
  promotionReason,
  type PromotionReason,
} from './job-promotion';
import type { ScheduledRunWrite } from './scheduled-run-telemetry';
import {
  createAgentRequestProof,
  createInvocationContextToken,
  deriveInvocationRequestProofKey,
  type InvocationMode,
} from './invocation-context';
import { buildAccountRequestBody } from './account-request-payload';
import { canInvokeOwnerAgent } from './delegation-policy';
import {
  sanitizeDiagnostic,
  sanitizeEmailForLog,
} from './log-sanitization';

// ---------------------------------------------------------------------------
// Structured logging (Lambda-compatible, no console.* per CLAUDE.md exception)
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function createLogger(context: Record<string, unknown> = {}) {
  const baseContext = {
    service: 'agent-router',
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
// AWS SDK clients (re-used across invocations for connection pooling)
// ---------------------------------------------------------------------------

const bedrockClient = new BedrockRuntimeClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});
const ssmClient = new SSMClient({});
const s3Client = new S3Client({});
const ecsClient = new ECSClient({});
const sqsClient = new SQSClient({});

// SigV4 signer — promoted to module scope to avoid re-creating the credential
// provider chain on every invocation. In a Lambda context credentials are stable
// for the container lifetime; defaultProvider() caches after first resolution.
const agentCoreCredentials = defaultProvider();
const agentCoreSigner = new SignatureV4({
  service: 'bedrock-agentcore',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: agentCoreCredentials,
  sha256: Sha256,
});

// Custom undici dispatcher for AgentCore invocations.
//
// Node's global `fetch()` is backed by undici with DEFAULT headersTimeout
// and bodyTimeout of 300_000 ms (5 min). We observed 5-min `fetch failed`
// errors after deploys: the Lambda timeout is 15 min, but undici was
// bailing at 5 min while the agent microVM was still streaming tokens
// (logs show GLM-5 still producing output >1 min after the Lambda
// already gave up). The Lambda timeout bump in #888 / commit 5a10b361
// was necessary but not sufficient.
//
// Set both knobs to 14 minutes so undici never fires before the Lambda
// timeout, and the Lambda's own 15-min ceiling is the only upper bound.
// `connectTimeout` stays at 10s because establishing the TLS handshake
// should always be fast; if it isn't, that's a real networking problem.
//
// AGENTCORE_TIMEOUT_MS_OVERRIDE (issue #1138 async jobs): the job-runner
// Fargate task reuses this module outside Lambda and must hold the SSE
// stream for up to the 2h job deadline + margin — it sets this env var.
// The Lambda path leaves it unset and keeps the 14-min default.
const AGENTCORE_TIMEOUT_MS =
  parseInt(process.env.AGENTCORE_TIMEOUT_MS_OVERRIDE || '', 10) || 14 * 60 * 1000;
const agentCoreDispatcher = new UndiciAgent({
  headersTimeout: AGENTCORE_TIMEOUT_MS,
  bodyTimeout: AGENTCORE_TIMEOUT_MS,
  connectTimeout: 10_000,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const USERS_TABLE = process.env.USERS_TABLE || '';
const GUARDRAIL_ID = process.env.GUARDRAIL_ID || '';
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION || 'DRAFT';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_HOST = process.env.DATABASE_HOST || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT || '5432', 10);
const GOOGLE_CREDENTIALS_SECRET_ARN =
  process.env.GOOGLE_CREDENTIALS_SECRET_ARN || '';
const TOKEN_LIMIT = parseInt(
  process.env.TOKEN_LIMIT_PER_INTERACTION || '100000',
  10
);
// Fail closed by default in K-12 environment — only allow through on explicit opt-in
// Domain allowlist for sender identity validation
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'psd401.net')
  .split(',')
  .map((d) => d.trim().toLowerCase());
// Max message length before hitting Guardrails/AgentCore — prevents timeouts
// and unexpected costs from unusually long inputs (e.g., pasted documents).
const MAX_MESSAGE_LENGTH = parseInt(
  process.env.MAX_MESSAGE_LENGTH || '10000',
  10
);
// Inter-agent communication limits
const MAX_INTERAGENT_MESSAGES_PER_HOUR = parseInt(
  process.env.MAX_INTERAGENT_MESSAGES_PER_HOUR || '5',
  10
);
const INTERAGENT_TABLE = process.env.INTERAGENT_TABLE || '';
// Organizational Nervous System signal store — see topic-classifier.ts
const SIGNALS_TABLE = process.env.SIGNALS_TABLE || '';
// TTL on signals: 90 days is long enough for the weekly pattern scanner's
// rolling 4-week comparison plus headroom for backfills / investigations.
const SIGNAL_TTL_DAYS = 90;

// Agent Workspace account auto-provisioning (#1233). When APP_BASE_URL + the
// internal API key are set, the router deterministically ensures each staff
// member's agnt_ Workspace account is provisioned via the app's
// account-request endpoint (which writes to the OneSync sheet). Unset → no-op.
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const AGENT_INTERNAL_API_KEY_SECRET_ID =
  process.env.AGENT_INTERNAL_API_KEY_SECRET_ID || '';
const AGENT_INVOCATION_SIGNING_SECRET_ID =
  process.env.AGENT_INVOCATION_SIGNING_SECRET_ID || '';
// Once an account isn't active, don't re-check more than hourly per user (the
// OneSync sync cadence is ~10–30 min, so hourly is ample).
const AGENT_ACCOUNT_RECHECK_MS = 60 * 60 * 1000;

// Cold-start diagnostic: log if AGENTCORE_RUNTIME_ID is not set at module load.
// When the env var is absent, every invocation pays an SSM GetParameter call.
// This makes the operational issue visible immediately in CloudWatch.
if (!process.env.AGENTCORE_RUNTIME_ID) {
  process.stdout.write(
    JSON.stringify({
      level: 'WARN',
      message: 'AGENTCORE_RUNTIME_ID not set — will resolve from SSM on each cold start',
      service: 'agent-router',
      timestamp: new Date().toISOString(),
    }) + '\n'
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoogleChatEvent {
  type: 'MESSAGE' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'CARD_CLICKED';
  eventTime: string;
  space: {
    name: string;
    type: 'DM' | 'ROOM' | 'TYPE_UNSPECIFIED';
    displayName?: string;
  };
  message?: {
    name: string;
    text: string;
    /**
     * Message text with bot @mentions stripped. Populated by Google Chat
     * for messages sent into a Space where the bot is mentioned. In a DM
     * this matches `text`. Prefer this over `text` in router logic so bot
     * mention chips don't pollute downstream parsing (e.g., cross-user
     * invocation regex).
     */
    argumentText?: string;
    sender: {
      name: string; // users/{userId}
      displayName: string;
      email: string;
      type: 'HUMAN' | 'BOT';
    };
    thread?: {
      name: string;
    };
    /**
     * Populated when the user invokes a registered slash command (e.g., /ask).
     * Contains only the commandId — the command name is mapped locally via
     * SLASH_COMMAND_NAMES for usage help text.
     */
    slashCommand?: {
      commandId: string;
    };
    /**
     * Files the user attached in Chat — uploaded content or a Drive file
     * added via the "+" menu. Forwarded to the agent so it knows a file
     * arrived (issue #1138 F1). Rides through normalizeChatEvent unchanged.
     */
    attachment?: ChatAttachment[];
    /**
     * Inline annotations, including Drive chips / rich links
     * (`type: 'RICH_LINK'`). Their driveFileId is surfaced to the agent.
     */
    annotations?: ChatAnnotation[];
    createTime: string;
  };
  /**
   * Populated on CARD_CLICKED events. Carries the function name + parameters
   * configured on the button's onClick.action. Our convention: every card
   * button emitted by the chat-card skill sets function="psd-agent" and
   * encodes the intent + any params as the parameters[] list. The Lambda
   * synthesizes a user message from these and routes through the normal
   * agent path so the agent decides the follow-up.
   */
  action?: {
    actionMethodName?: string;
    function?: string;
    parameters?: Array<{ key: string; value: string }>;
  };
  /**
   * On CARD_CLICKED events, the user who clicked. The shape mirrors
   * message.sender so domain validation can reuse the same accessor.
   */
  user?: {
    name: string;
    displayName: string;
    email: string;
    type: 'HUMAN' | 'BOT';
  };
}

/**
 * Normalize a Chat event into the legacy `{type, space, message}` shape that
 * the rest of this Lambda consumes. Accepts either:
 *   - the legacy webhook format (already normalized), or
 *   - the Workspace common-event format published by Pub/Sub-connected
 *     Chat apps: `{commonEventObject, chat: {user, eventTime, messagePayload}}`
 *
 * For the common-event format the event type is inferred from which payload
 * key is present (`messagePayload`, `addedToSpacePayload`, etc.). We only
 * need MESSAGE and ADDED_TO_SPACE; other event types degrade to
 * `TYPE_UNSPECIFIED` and are ignored downstream.
 */
function normalizeAddedToSpaceEvent(
  chat: Record<string, unknown>,
  eventTime: string,
  payload: {
    space: GoogleChatEvent['space'];
    user?: NonNullable<GoogleChatEvent['message']>['sender'];
  }
): GoogleChatEvent {
  const user =
    (chat.user as NonNullable<GoogleChatEvent['message']>['sender'] | undefined) ??
    payload.user;
  return {
    type: 'ADDED_TO_SPACE',
    eventTime,
    space: payload.space,
    message: user
      ? {
          name: '',
          text: '',
          sender: user,
          createTime: eventTime,
        }
      : undefined,
  };
}

function normalizeCommonChatEvent(
  chat: Record<string, unknown>,
  eventTime: string
): GoogleChatEvent {
  const messagePayload = chat.messagePayload as
    | { space?: GoogleChatEvent['space']; message?: GoogleChatEvent['message'] }
    | undefined;
  const addedPayload = chat.addedToSpacePayload as
    | { space?: GoogleChatEvent['space']; user?: NonNullable<GoogleChatEvent['message']>['sender'] }
    | undefined;
  const removedPayload = chat.removedFromSpacePayload as
    | { space?: GoogleChatEvent['space'] }
    | undefined;

  if (messagePayload?.message && messagePayload?.space) {
    return {
      type: 'MESSAGE',
      eventTime,
      space: messagePayload.space,
      message: messagePayload.message,
    };
  }

  if (addedPayload?.space) {
    return normalizeAddedToSpaceEvent(chat, eventTime, {
      space: addedPayload.space,
      user: addedPayload.user,
    });
  }

  if (removedPayload?.space) {
    return {
      type: 'REMOVED_FROM_SPACE',
      eventTime,
      space: removedPayload.space,
    };
  }

  // CARD_CLICKED (button on a card the agent posted). Google's common-event
  // shape names this `buttonClickedPayload`. We mirror legacy fields so the
  // CARD_CLICKED handler can read message/space/user/action through the same
  // accessors as MESSAGE.
  const buttonPayload = chat.buttonClickedPayload as
    | {
        space?: GoogleChatEvent['space'];
        message?: GoogleChatEvent['message'];
        action?: GoogleChatEvent['action'];
      }
    | undefined;
  if (buttonPayload?.space && buttonPayload?.action) {
    const user = chat.user as GoogleChatEvent['user'] | undefined;
    return {
      type: 'CARD_CLICKED',
      eventTime,
      space: buttonPayload.space,
      message: buttonPayload.message,
      action: buttonPayload.action,
      user,
    };
  }

  // Unknown common-event variant; mark unspecified and let caller skip it.
  return {
    type: 'TYPE_UNSPECIFIED' as GoogleChatEvent['type'],
    eventTime,
    space: { name: '', type: 'TYPE_UNSPECIFIED' },
  };
}

function normalizeChatEvent(raw: Record<string, unknown>): GoogleChatEvent {
  if (typeof raw.type === 'string') {
    return raw as unknown as GoogleChatEvent;
  }

  const chat = (raw.chat ?? {}) as Record<string, unknown>;
  const eventTime = (chat.eventTime as string | undefined) ?? '';
  return normalizeCommonChatEvent(chat, eventTime);
}

// Rich-output envelope helper extracted to its own module so the Cron
// Lambda can mirror the same logic and we can unit-test it independently.
// Keep behaviour in lockstep with infra/agent-image/chat_format.py.

interface AgentUser {
  googleIdentity: string;
  email: string;
  displayName: string;
  department: string;
  workspacePrefix: string;
  createdAt: string;
  lastActiveAt: string;
  sessionCount: number;
  // Agent Workspace account provisioning state (#1233). Records without these
  // fields (created before #1233) are treated as 'none'.
  //   none      — not yet checked / no request made
  //   requested — a username row is queued on the OneSync sheet; awaiting sync
  //   active    — the agnt_ account exists (broker probe succeeded)
  //   excluded  — a student (numeric-prefix) username; never provisioned
  agentAccountStatus?: 'none' | 'requested' | 'active' | 'excluded';
  agentAccountCheckedAt?: string;
}

/**
 * Result of parsing a cross-user invocation — either from @agent:username
 * (deprecated text prefix) or from a /ask slash command.
 */
interface CrossUserInvocation {
  /** The username portion (email local part) of the target agent owner */
  targetUsername: string;
  /** The message text with the invocation syntax stripped */
  strippedMessage: string;
  /** Which invocation method was used — drives deprecation notices */
  source: 'slash-command' | 'text-prefix';
  /** The slash command name that was invoked (e.g., "/ask", "/consult"). Only set for slash-command source. */
  commandName?: string;
}

interface AsideInvocation {
  /** The question with the /btw command token stripped. */
  messageText: string;
  /** Whether Google supplied a registered command id or text fallback matched. */
  source: 'slash-command' | 'text-prefix';
}

// ---------------------------------------------------------------------------
// Slash command configuration
// ---------------------------------------------------------------------------

/**
 * Recognized slash command IDs for cross-user invocation. These must match
 * the command IDs configured in the Google Cloud Console under
 * Chat API -> Configuration -> Slash commands.
 *
 * Command registration (manual in Cloud Console):
 *   /ask     -> commandId "1"  -> "Ask another PSD staff member's agent a question"
 *   /consult -> commandId "2"  -> "Consult another PSD staff member's agent"
 *
 * Both commands behave identically — /consult is a synonym for /ask.
 */
const CROSS_USER_SLASH_COMMAND_IDS = new Set(['1', '2']);

/**
 * Persistent owner-DM sidecar session command (issue #1405).
 *
 * Manual deploy-time registration in Google Cloud Console:
 *   /btw -> commandId "3" -> "Use a separate side-conversation transcript"
 */
const BTW_SLASH_COMMAND_ID = '3';

const RECOGNIZED_SLASH_COMMAND_IDS = new Set([
  ...CROSS_USER_SLASH_COMMAND_IDS,
  BTW_SLASH_COMMAND_ID,
]);

/** Maps commandId to the human-readable command name for usage help text. */
const SLASH_COMMAND_NAMES: Record<string, string> = {
  '1': '/ask',
  '2': '/consult',
  [BTW_SLASH_COMMAND_ID]: '/btw',
};

const ASIDE_RESPONSE_PREFIX = '[aside] ';
const WORKSPACE_RETRY_VISIBILITY_SECONDS = 60;
const WORKSPACE_DEFER_ATTRIBUTE = 'PsdWorkspaceDeferV1';
const WORKSPACE_DEFER_MAX_ATTEMPTS = 180;
const WORKSPACE_DEFER_MAX_AGE_SECONDS = 3 * 60 * 60;
const CHAT_DELIVERY_ENVELOPE_KIND = 'agent-chat-delivery-v1';
const MAX_CHAT_DELIVERY_ENVELOPE_BYTES = 32 * 1024;

class WorkspaceTurnDeferredError extends Error {
  readonly messageName: string | undefined;
  readonly reason: 'workspace-contended' | 'background-job-active';

  constructor(
    messageName: string | undefined,
    reason: WorkspaceTurnDeferredError['reason']
  ) {
    super(
      reason === 'background-job-active'
        ? 'Owner workspace is held by a background job'
        : 'Owner workspace is held by another turn'
    );
    this.name = 'WorkspaceTurnDeferredError';
    this.messageName = messageName;
    this.reason = reason;
  }
}

class ChatDeliveryRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatDeliveryRetryError';
  }
}

function isSlashCommandAvailable(
  commandId: string | undefined,
  spaceType: GoogleChatEvent['space']['type']
): boolean {
  if (!commandId || !RECOGNIZED_SLASH_COMMAND_IDS.has(commandId)) return false;
  return commandId !== BTW_SLASH_COMMAND_ID || spaceType === 'DM';
}

function logUnavailableSlashCommand(
  commandId: string,
  spaceType: GoogleChatEvent['space']['type'],
  log: ReturnType<typeof createLogger>
): void {
  const recognized = RECOGNIZED_SLASH_COMMAND_IDS.has(commandId);
  log.warn(
    recognized
      ? 'Ignoring slash command outside its allowed scope'
      : 'Ignoring unrecognized slash command',
    { commandId, spaceType }
  );
}

// ---------------------------------------------------------------------------
// Cached secrets
// ---------------------------------------------------------------------------

let cachedGoogleCredentials: string | null = null;
let credentialsCachedAt: number | null = null;
const CREDENTIALS_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cached Google Chat API client — reuses OAuth token across warm invocations.
// Invalidated when credentials are refreshed (TTL expiry or parse error).
function createGoogleChatAuth(
  credentials: Record<string, unknown>
) {
  return new chatPkg.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });
}

type GoogleChatAuth = ReturnType<typeof createGoogleChatAuth>;
let cachedChatAuth: GoogleChatAuth | null = null;
let cachedChatClient: ReturnType<typeof chatPkg.chat> | null = null;

// Cache SSM lookups at module scope to avoid redundant API calls on every invocation.
// The Runtime ID is resolved from SSM because it's not known at CDK deploy time.
let cachedRuntimeId: string | null = null;
let runtimeIdCachedAt: number | null = null;
const RUNTIME_ID_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Lazy-initialized postgres.js connection — reused across warm invocations.
// Uses direct PostgreSQL (same as the rest of the app) instead of RDS Data API
// for consistency and ~100-300ms lower latency per query.
let pgClient: postgres.Sql | null = null;

// Sentinel token for the intentional local-development pass-through scenario
// where no lock table is configured. A configured table must fail closed:
// running without the owner workspace mutex can corrupt durable history.
const LOCK_PASS_THROUGH = '__lock-pass-through__';
// Covers the complete interactive lifecycle, not merely Lambda's caller
// lifetime: AgentCore can still be stopping OpenClaw and flushing SQLite after
// a transport disconnect. Five-minute renewals normally keep this farther
// ahead; 30 minutes is the fail-safe when one renewal is missed.
const SESSION_LOCK_TTL_SECONDS = 30 * 60;
const SESSION_LOCK_RENEW_INTERVAL_MS = 5 * 60 * 1000;

interface SessionLockAcquireDependencies {
  tableName: string | undefined;
  send: (command: PutCommand) => Promise<unknown>;
}

/**
 * Try to acquire the per-session lock. Returns the unique lock token on
 * success, `null` if another holder already has it or a configured DynamoDB
 * table cannot prove ownership, or `LOCK_PASS_THROUGH` when locking is
 * intentionally disabled for local development.
 *
 * Each acquisition writes a random `lockToken` into the DynamoDB row. The
 * token is required by `releaseSessionLock` so that a stale holder (whose
 * lock expired and was re-acquired by a different invocation) cannot
 * accidentally delete a newer holder's lock. A caller-supplied stable token
 * may re-enter and extend its own row; promoted-job delivery retries use this
 * together with ECS clientToken idempotency.
 *
 * The 30-minute lease covers cold restore, the 14-minute harness budget, and
 * the wrapper's bounded final workspace flush. Interactive turns and async
 * jobs renew it while they run. The conditional-delete token prevents a stale
 * holder from releasing a newer holder's lock after expiry + re-acquisition.
 */
async function tryAcquireSessionLock(
  sessionId: string,
  log: ReturnType<typeof createLogger>,
  kind: 'turn' | 'job' = 'turn',
  override?: SessionLockAcquireDependencies,
  requestedLockToken?: string
): Promise<string | null> {
  const tableName = override?.tableName ?? process.env.SESSION_LOCKS_TABLE;
  if (!tableName) return LOCK_PASS_THROUGH; // Lock disabled (e.g. local) — pass through.

  const lockToken = requestedLockToken ?? crypto.randomUUID();
  const expiresAt =
    Math.floor(Date.now() / 1000) + SESSION_LOCK_TTL_SECONDS;
  try {
    const command = new PutCommand({
      TableName: tableName,
      // `kind: 'job'` marks a lock held by the async job-runner (#1138) —
      // the router replies "still working on your earlier task" instantly.
      // The runner renews expiresAt every ~5 min, leaving enough lease margin
      // for a full missed renewal.
      Item: {
        sessionId,
        expiresAt,
        lockToken,
        kind,
        claimedAt: new Date().toISOString(),
      },
      ConditionExpression:
        'attribute_not_exists(sessionId) OR expiresAt < :now ' +
        'OR lockToken = :tok',
      ExpressionAttributeValues: {
        ':now': Math.floor(Date.now() / 1000),
        ':tok': lockToken,
      },
    });
    await (override?.send(command) ?? dynamoClient.send(command));
    return lockToken;
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') return null;
    log.error('Session lock acquire failed; refusing unlocked workspace turn', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Release the per-session lock. Uses a conditional delete on `lockToken` so
 * only the current owner can release — prevents a stale holder from deleting
 * a newer holder's lock after TTL expiry + re-acquisition.
 *
 * Pass-through tokens (`LOCK_PASS_THROUGH`) are no-ops — no DDB row was
 * written, so there is nothing to delete.
 */
async function releaseSessionLock(
  sessionId: string,
  lockToken: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const tableName = process.env.SESSION_LOCKS_TABLE;
  if (!tableName || lockToken === LOCK_PASS_THROUGH) return;
  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { sessionId },
        ConditionExpression: 'lockToken = :tok',
        ExpressionAttributeValues: { ':tok': lockToken },
      })
    );
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') {
      // Another invocation re-acquired the lock (ours expired). This is
      // expected in long-running scenarios — the TTL backstop handles cleanup.
      log.info('Session lock already re-acquired by another holder; skipping release');
      return;
    }
    log.warn('Session lock release failed; relying on TTL backstop', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Renew a held session lock by extending expiresAt another 30 minutes,
 * conditioned on still owning it (lockToken match). Interactive turns and the
 * async job-runner call this every ~5 min. Returns false when the lock was lost
 * (expired + re-acquired by someone else), and in confirmation mode when a
 * transient error prevents proving the startup extension. The runner refuses
 * to start external work without that proof; later losses remain advisory
 * because work may already have side effects and OpenClaw serializes the
 * session itself.
 */
async function renewSessionLock(
  sessionId: string,
  lockToken: string,
  log: ReturnType<typeof createLogger>,
  requireConfirmation = false,
): Promise<boolean> {
  const tableName = process.env.SESSION_LOCKS_TABLE;
  if (!tableName || lockToken === LOCK_PASS_THROUGH) return true;
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { sessionId },
        UpdateExpression: 'SET expiresAt = :exp',
        ConditionExpression: 'lockToken = :tok',
        ExpressionAttributeValues: {
          ':exp':
            Math.floor(Date.now() / 1000) + SESSION_LOCK_TTL_SECONDS,
          ':tok': lockToken,
        },
      })
    );
    return true;
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') {
      log.warn('Session lock renewal lost ownership — continuing without lock');
      return false;
    }
    log.warn('Session lock renewal failed; will retry on next interval', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Once external work is underway, a transient error is advisory and the
    // interval keeps trying. At startup there is no work to preserve, so
    // require an actually confirmed extension before invoking AgentCore.
    return !requireConfirmation;
  }
}

/**
 * True when an ACTIVE `kind='job'` lock holds this session — a background
 * job is still running (#1138). Fail-open on errors: a DDB blip must not
 * block normal message processing.
 */
async function isJobLockActive(
  sessionId: string,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const tableName = process.env.SESSION_LOCKS_TABLE;
  if (!tableName) return false;
  try {
    const result = await dynamoClient.send(
      new GetCommand({ TableName: tableName, Key: { sessionId } })
    );
    const item = result.Item as
      | { kind?: string; expiresAt?: number }
      | undefined;
    return (
      !!item &&
      item.kind === 'job' &&
      typeof item.expiresAt === 'number' &&
      item.expiresAt > Math.floor(Date.now() / 1000)
    );
  } catch (error) {
    log.warn('Job-lock check failed; treating as no job', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Returns true if this message name has already been processed (or is being
 * processed concurrently) by claiming its row via a conditional PutItem. The
 * row carries a 1-hour TTL so the table self-prunes.
 *
 * Conservative on errors: if the dedup table is unreachable we return `false`
 * so the message still flows. Better to risk a rare double-send than to drop
 * messages on a transient DDB blip.
 */
async function isDuplicateMessage(
  messageName: string,
  log: ReturnType<typeof createLogger>,
  override?: {
    tableName: string | undefined;
    send: (command: PutCommand) => Promise<unknown>;
  }
): Promise<boolean> {
  const tableName =
    override?.tableName ?? process.env.MESSAGE_DEDUP_TABLE;
  if (!tableName) {
    return false; // Dedup not configured (e.g., local tests) — pass through
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
  const now = Math.floor(Date.now() / 1000);
  try {
    const command = new PutCommand({
        TableName: tableName,
        Item: {
          messageName,
          expiresAt,
          claimedAt: new Date().toISOString(),
        },
        ConditionExpression:
          'attribute_not_exists(messageName) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': now },
      });
    await (override?.send(command) ?? dynamoClient.send(command));
    return false; // Successfully claimed → first time we've seen this msg
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') {
      return true; // Someone else already claimed it
    }
    log.warn('Dedup check failed; proceeding without dedup', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function releaseMessageClaimForRetry(
  messageName: string | undefined,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const tableName = process.env.MESSAGE_DEDUP_TABLE;
  if (!tableName || !messageName) return true;
  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { messageName },
      })
    );
    return true;
  } catch (error) {
    log.error('Failed to release message claim for deferred workspace turn', {
      messageName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function deferWorkspaceTurn(
  record: SQSRecord,
  error: WorkspaceTurnDeferredError,
  log: ReturnType<typeof createLogger>,
  dependencies: {
    releaseClaim: typeof releaseMessageClaimForRetry;
    enqueue: (
      input: ConstructorParameters<typeof SendMessageCommand>[0]
    ) => Promise<unknown>;
    nowSeconds: () => number;
  } = {
    releaseClaim: releaseMessageClaimForRetry,
    enqueue: input => sqsClient.send(new SendMessageCommand(input)),
    nowSeconds: () => Math.floor(Date.now() / 1000),
  }
): Promise<boolean> {
  const queueUrl = process.env.ROUTER_QUEUE_URL;
  if (!queueUrl) {
    log.error(
      'ROUTER_QUEUE_URL is missing; deferred turn will use default visibility'
    );
    return false;
  }
  const nowSeconds = dependencies.nowSeconds();
  const deferState = nextWorkspaceDeferState(record, nowSeconds);
  if (!deferState) {
    log.error('Workspace deferral budget exhausted; record will follow DLQ redrive', {
      messageName: error.messageName,
      reason: error.reason,
      maxAttempts: WORKSPACE_DEFER_MAX_ATTEMPTS,
      maxAgeSeconds: WORKSPACE_DEFER_MAX_AGE_SECONDS,
      receiveCount: record.attributes?.ApproximateReceiveCount ?? '1',
    });
    return false;
  }
  const claimReleased = await dependencies.releaseClaim(
    error.messageName,
    log
  );
  if (!claimReleased) {
    // Leave the source queue's normal 90-minute visibility in place. The
    // one-hour dedup claim will expire before that retry, so the turn remains
    // recoverable even while DynamoDB is unhealthy.
    return false;
  }

  await dependencies.enqueue({
    QueueUrl: queueUrl,
    MessageBody: record.body,
    DelaySeconds: WORKSPACE_RETRY_VISIBILITY_SECONDS,
    MessageAttributes: workspaceRetryMessageAttributes(
      record,
      deferState
    ),
  });
  log.info('Requeued Chat turn for durable workspace retry', {
    messageName: error.messageName,
    reason: error.reason,
    retryAfterSeconds: WORKSPACE_RETRY_VISIBILITY_SECONDS,
    deferAttempt: deferState.attempt,
    firstDeferredAt: deferState.firstDeferredAt,
    receiveCount: record.attributes?.ApproximateReceiveCount ?? '1',
  });
  return true;
}

type WorkspaceDeferState = {
  firstDeferredAt: number;
  attempt: number;
};

function nextWorkspaceDeferState(
  record: SQSRecord,
  nowSeconds: number
): WorkspaceDeferState | null {
  const attribute = record.messageAttributes?.[WORKSPACE_DEFER_ATTRIBUTE];
  if (!attribute) {
    if (Object.keys(record.messageAttributes ?? {}).length >= 10) {
      return null;
    }
    return { firstDeferredAt: nowSeconds, attempt: 1 };
  }
  const state = parseWorkspaceDeferState(attribute);
  if (
    !state ||
    !workspaceDeferStateIsEligible(state, nowSeconds)
  ) {
    return null;
  }
  return {
    firstDeferredAt: state.firstDeferredAt,
    attempt: state.attempt + 1,
  };
}

function parseWorkspaceDeferState(
  attribute: SQSRecord['messageAttributes'][string]
): WorkspaceDeferState | null {
  if (
    attribute.dataType !== 'String' ||
    typeof attribute.stringValue !== 'string'
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(attribute.stringValue);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== 2 ||
    typeof state.firstDeferredAt !== 'number' ||
    !Number.isSafeInteger(state.firstDeferredAt) ||
    state.firstDeferredAt < 0 ||
    typeof state.attempt !== 'number' ||
    !Number.isSafeInteger(state.attempt) ||
    state.attempt < 1
  ) {
    return null;
  }
  return state as WorkspaceDeferState;
}

function workspaceDeferStateIsEligible(
  state: WorkspaceDeferState,
  nowSeconds: number
): boolean {
  return (
    state.firstDeferredAt <=
      nowSeconds + WORKSPACE_RETRY_VISIBILITY_SECONDS &&
    state.attempt < WORKSPACE_DEFER_MAX_ATTEMPTS &&
    nowSeconds - state.firstDeferredAt < WORKSPACE_DEFER_MAX_AGE_SECONDS
  );
}

function workspaceRetryMessageAttributes(
  record: SQSRecord,
  state: WorkspaceDeferState
): Record<string, MessageAttributeValue> {
  const attributes = Object.fromEntries(
    Object.entries(record.messageAttributes ?? {}).map(([name, value]) => [
      name,
      {
        DataType: value.dataType,
        ...(value.stringValue !== undefined
          ? { StringValue: value.stringValue }
          : {}),
        ...(value.binaryValue !== undefined
          ? { BinaryValue: Buffer.from(value.binaryValue, 'base64') }
          : {}),
        ...(value.stringListValues !== undefined
          ? { StringListValues: value.stringListValues }
          : {}),
        ...(value.binaryListValues !== undefined
          ? {
              BinaryListValues: value.binaryListValues.map(item =>
                Buffer.from(item, 'base64')
              ),
            }
          : {}),
      },
    ])
  );
  attributes[WORKSPACE_DEFER_ATTRIBUTE] = {
    DataType: 'String',
    StringValue: JSON.stringify(state),
  };
  return attributes;
}

async function deferChatDeliveryRetry(
  record: SQSRecord,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const queueUrl = process.env.ROUTER_QUEUE_URL;
  if (!queueUrl) {
    log.error(
      'ROUTER_QUEUE_URL is missing; Chat delivery retry will use default visibility'
    );
    return;
  }
  await sqsClient.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: record.receiptHandle,
      VisibilityTimeout: WORKSPACE_RETRY_VISIBILITY_SECONDS,
    })
  );
  log.warn('Deferred completed Chat response delivery for retry', {
    retryAfterSeconds: WORKSPACE_RETRY_VISIBILITY_SECONDS,
    receiveCount: record.attributes?.ApproximateReceiveCount ?? '1',
  });
}

async function getDbClient(): Promise<postgres.Sql> {
  if (pgClient) return pgClient;

  if (!DATABASE_HOST || !DATABASE_SECRET_ARN) {
    throw new Error('DATABASE_HOST and DATABASE_SECRET_ARN must be configured for telemetry');
  }

  // Read DB credentials from Secrets Manager (same secret used by the ECS app)
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN })
  );
  const secret = JSON.parse(result.SecretString || '{}') as {
    username: string;
    password: string;
  };

  pgClient = postgres({
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    database: DATABASE_NAME,
    username: secret.username,
    password: secret.password,
    ssl: 'require',
    // Lambda-appropriate pool settings — small pool, short idle timeout
    max: 2,
    idle_timeout: 60,
    connect_timeout: 10,
  });

  return pgClient;
}

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
  // Invalidate the Chat API client so it picks up fresh credentials
  cachedChatAuth = null;
  cachedChatClient = null;
  return cachedGoogleCredentials;
}

// Internal API key for calling the Next.js app's /api/agent/* endpoints
// (#1233 account-request). Prefers the direct env var (local/dev), else the
// Secrets Manager value; TTL-cached like getGoogleCredentials. Returns null if
// unconfigured so callers can no-op fail-closed.
let cachedInternalApiKey: string | null = null;
let internalApiKeyCachedAt: number | null = null;
async function getInternalApiKey(): Promise<string | null> {
  if (process.env.AGENT_INTERNAL_API_KEY) return process.env.AGENT_INTERNAL_API_KEY;
  if (
    cachedInternalApiKey &&
    internalApiKeyCachedAt &&
    Date.now() - internalApiKeyCachedAt < CREDENTIALS_TTL_MS
  ) {
    return cachedInternalApiKey;
  }
  if (!AGENT_INTERNAL_API_KEY_SECRET_ID) return null;
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: AGENT_INTERNAL_API_KEY_SECRET_ID })
  );
  cachedInternalApiKey = result.SecretString || '';
  internalApiKeyCachedAt = Date.now();
  return cachedInternalApiKey;
}

// The model-facing runtime never receives this secret. It receives only a
// short-lived signed context that binds actor, owner, mode, session, and
// workspace. The Next.js agent routes verify the token before honoring an
// owner-scoped operation.
let cachedInvocationSigningSecret: string | null = null;
let invocationSigningSecretCachedAt: number | null = null;
async function getInvocationSigningSecret(): Promise<string> {
  if (
    cachedInvocationSigningSecret &&
    invocationSigningSecretCachedAt &&
    Date.now() - invocationSigningSecretCachedAt < CREDENTIALS_TTL_MS
  ) {
    return cachedInvocationSigningSecret;
  }
  if (!AGENT_INVOCATION_SIGNING_SECRET_ID) {
    throw new Error('AGENT_INVOCATION_SIGNING_SECRET_ID not configured');
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: AGENT_INVOCATION_SIGNING_SECRET_ID })
  );
  const secret = result.SecretString || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Agent invocation signing secret is missing or too short');
  }
  cachedInvocationSigningSecret = secret;
  invocationSigningSecretCachedAt = Date.now();
  return secret;
}

async function issueInvocationContext(input: {
  actorEmail: string;
  ownerEmail: string;
  mode: InvocationMode;
  sessionId: string;
  workspacePrefix: string;
}, options: { ttlSeconds?: number } = {}): Promise<{
  token: string;
  requestProofKey: string;
}> {
  const secret = await getInvocationSigningSecret();
  const token = createInvocationContextToken(secret, input, {
    ...(options.ttlSeconds === undefined
      ? {}
      : { ttlSeconds: options.ttlSeconds }),
  });
  return {
    token,
    requestProofKey: deriveInvocationRequestProofKey(secret, token),
  };
}

/**
 * Deterministically ensure the caller's agnt_ Workspace account is provisioned
 * (#1233). Fire-and-forget (`void`): must NOT add latency to the user reply, so
 * it runs off the hot path with a short network timeout and swallows all
 * errors — a failure just retries on a later message.
 *
 * Dedupe/throttle: a conditional UpdateCommand on agentAccountCheckedAt is the
 * gate — only one caller per hour (and only one of N concurrent Lambdas for the
 * same user) proceeds to call the app. Students (numeric-prefix usernames) are
 * marked 'excluded' once and never re-checked.
 */
async function maybeProvisionAgentAccount(
  user: AgentUser,
  senderEmail: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!shouldCheckAgentAccount(user)) return;
  const localPart = (senderEmail.split('@')[0] || '').toLowerCase();
  if (/^\d/.test(localPart)) {
    await markAgentAccountExcluded(user, log);
    return;
  }

  if (!(await claimAgentAccountCheck(user, log))) return;
  const status = await requestAgentAccountStatus(user, senderEmail, log);
  if (status) await persistAgentAccountStatus(user, status, log);
}

function shouldCheckAgentAccount(user: AgentUser): boolean {
  const keyConfigured =
    Boolean(AGENT_INTERNAL_API_KEY_SECRET_ID) ||
    Boolean(process.env.AGENT_INTERNAL_API_KEY);
  const terminalStatus =
    user.agentAccountStatus === 'active' ||
    user.agentAccountStatus === 'excluded';
  return Boolean(USERS_TABLE && APP_BASE_URL && keyConfigured && !terminalStatus);
}

async function markAgentAccountExcluded(
  user: AgentUser,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity: user.googleIdentity },
        UpdateExpression: 'SET agentAccountStatus = :excluded, agentAccountCheckedAt = :now',
        ConditionExpression:
          'attribute_exists(googleIdentity) AND (attribute_not_exists(agentAccountStatus) OR agentAccountStatus <> :excluded)',
        ExpressionAttributeValues: { ':excluded': 'excluded', ':now': new Date().toISOString() },
      })
    );
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') {
      log.error('Failed to mark student username provisioning-excluded', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function claimAgentAccountCheck(
  user: AgentUser,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const cutoff = new Date(Date.now() - AGENT_ACCOUNT_RECHECK_MS).toISOString();
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity: user.googleIdentity },
        UpdateExpression: 'SET agentAccountCheckedAt = :now',
        ConditionExpression:
          'attribute_exists(googleIdentity) AND (attribute_not_exists(agentAccountCheckedAt) OR agentAccountCheckedAt < :cutoff)',
        ExpressionAttributeValues: { ':now': new Date().toISOString(), ':cutoff': cutoff },
      })
    );
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    log.error('Failed to claim agent-account provisioning check', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function requestAgentAccountStatus(
  user: AgentUser,
  senderEmail: string,
  log: ReturnType<typeof createLogger>
): Promise<'active' | 'requested' | null> {
  try {
    const apiKey = await getInternalApiKey();
    if (!apiKey) return null;
    const invocationAuthority = await issueInvocationContext({
      actorEmail: senderEmail,
      ownerEmail: senderEmail,
      mode: 'owner',
      sessionId: `account-provision:${user.googleIdentity}`,
      workspacePrefix: user.workspacePrefix,
    });
    const requestBody = buildAccountRequestBody();
    const resp = await fetch(`${APP_BASE_URL.replace(/\/+$/, '')}/api/agent/account-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Agent-Invocation-Context': invocationAuthority.token,
        ...createAgentRequestProof(invocationAuthority.requestProofKey, {
          method: 'POST',
          route: '/api/agent/account-request',
          body: requestBody,
        }),
      },
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      log.warn('account-request returned non-OK', { httpStatus: resp.status });
      return null;
    }
    const respBody = (await resp.json().catch(() => ({}))) as { status?: string };
    return respBody.status === 'active' || respBody.status === 'requested'
      ? respBody.status
      : null;
  } catch (error) {
    log.warn('account-request call failed (will retry on a later message)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function persistAgentAccountStatus(
  user: AgentUser,
  status: 'active' | 'requested',
  log: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity: user.googleIdentity },
        UpdateExpression: 'SET agentAccountStatus = :s',
        ConditionExpression: 'attribute_exists(googleIdentity)',
        ExpressionAttributeValues: { ':s': status },
      })
    );
  } catch (error) {
    log.error('Failed to persist agent-account status', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

async function getOrCreateUser(
  senderName: string,
  senderEmail: string,
  senderDisplayName: string,
  log: ReturnType<typeof createLogger>
): Promise<AgentUser> {
  // Optimized: single conditional UpdateCommand for existing users instead of
  // Get + Update (saves ~10–30ms per message). Falls back to PutCommand for new users.
  try {
    const updateResult = await dynamoClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity: senderName },
        UpdateExpression: 'SET lastActiveAt = :now',
        ConditionExpression: 'attribute_exists(googleIdentity)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      })
    );
    return updateResult.Attributes as AgentUser;
  } catch (error: unknown) {
    // ConditionalCheckFailedException means user doesn't exist — create new record
    const errorName = (error as { name?: string }).name;
    if (errorName !== 'ConditionalCheckFailedException') {
      throw error;
    }
  }

  // New user — create record with workspace prefix.
  // Use email local part + UUID suffix for guaranteed collision-free prefixes.
  // Previous approach used a custom hash (2.2B values) which had theoretical
  // collision risk; UUID v4 eliminates this entirely.
  const emailNormalized = senderEmail.toLowerCase();
  const localPart = emailNormalized.split('@')[0].replace(/[^a-z0-9-]/g, '-');
  const uuidSuffix = crypto.randomUUID().split('-')[0]; // 8 hex chars
  const workspacePrefix = `${localPart}-${uuidSuffix}`;
  const newUser: AgentUser = {
    googleIdentity: senderName,
    email: senderEmail,
    displayName: senderDisplayName,
    department: 'unknown', // Updated by admin later or via directory sync
    workspacePrefix,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    sessionCount: 0,
    agentAccountStatus: 'none', // #1233 — provisioned automatically on first messages
  };

  // Conditional put prevents race condition: if two messages arrive simultaneously
  // from the same new user, only the first PutCommand succeeds. The second gets
  // ConditionalCheckFailedException and falls through to fetch the existing record.
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: newUser,
        ConditionExpression: 'attribute_not_exists(googleIdentity)',
      })
    );

    log.info('New agent user created', {
      googleIdentity: senderName,
      workspacePrefix,
    });

    return newUser;
  } catch (putError: unknown) {
    const putErrorName = (putError as { name?: string }).name;
    if (putErrorName !== 'ConditionalCheckFailedException') {
      throw putError;
    }
    // Another concurrent invocation created the user first — fetch their record
    log.info('Concurrent user creation detected, fetching existing record', {
      googleIdentity: senderName,
    });
    const retryResult = await dynamoClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity: senderName },
        UpdateExpression: 'SET lastActiveAt = :now',
        ConditionExpression: 'attribute_exists(googleIdentity)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      })
    );
    return retryResult.Attributes as AgentUser;
  }
}

// ---------------------------------------------------------------------------
// Cross-user agent invocation
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a plausible email local part (username).
 * Allows alphanumeric characters, dots, hyphens, and underscores.
 * Must start and end with alphanumeric (single-char usernames like "a" are
 * accepted; punctuation-only inputs like "." or "---" are rejected).
 *
 * Shared between parseCrossUserInvocation() and parseSlashCommandInvocation()
 * to ensure consistent input validation regardless of invocation method.
 */
function isValidUsername(value: string): boolean {
  if (value.length === 0) return false;
  const isAlphaNumeric = (character: string) => /^[a-zA-Z0-9]$/.test(character);
  if (!isAlphaNumeric(value[0]) || !isAlphaNumeric(value.at(-1) ?? '')) {
    return false;
  }
  return [...value].every(
    (character) => isAlphaNumeric(character) || character === '.' || character === '_' || character === '-'
  );
}

/**
 * Parse @agent:username from the beginning of a message (DEPRECATED).
 * Supports formats:
 *   @agent:ashley what's the budget?
 *   @agent:ashley.jones what's the budget?
 *
 * The username is matched against the email local part (before @) of users in
 * DynamoDB. Returns null if no @agent: prefix is found.
 *
 * Deprecated in favor of /ask slash commands (issue #907). Kept for backward
 * compatibility during the sunset window — the caller appends a deprecation
 * notice to responses triggered via this parser.
 */
function parseCrossUserInvocation(text: string): CrossUserInvocation | null {
  // Trim leading whitespace — Google Chat formatting may add spaces.
  // Match @agent: followed by a username (alphanumeric, dots, hyphens, underscores).
  // Must start and end with alphanumeric; rejects punctuation-only inputs like
  // @agent:. or @agent:--- which are not valid email local parts.
  const trimmed = text.trim();
  if (!trimmed.startsWith('@agent:')) return null;

  const invocation = trimmed.slice('@agent:'.length);
  const whitespaceIndex = invocation.search(/\s/);
  const username = whitespaceIndex === -1
    ? invocation
    : invocation.slice(0, whitespaceIndex);
  if (!isValidUsername(username)) return null;

  return {
    targetUsername: username.toLowerCase(),
    strippedMessage: whitespaceIndex === -1
      ? ''
      : invocation.slice(whitespaceIndex).trim(),
    source: 'text-prefix',
  };
}

function slashCommandArgumentText(
  message: NonNullable<GoogleChatEvent['message']>
): string {
  const argumentText = (message.argumentText ?? '').trim();
  if (argumentText) return argumentText;

  const text = (message.text ?? '').trim();
  const firstSpace = text.search(/\s/);
  return firstSpace === -1 ? '' : text.substring(firstSpace).trim();
}

/**
 * Parse the owner-DM /btw sidecar command.
 *
 * Google Chat's registered command id is authoritative. The text-prefix path
 * remains for clients/events that do not populate message.slashCommand.
 */
function parseAsideInvocation(
  message: NonNullable<GoogleChatEvent['message']>
): AsideInvocation | null {
  if (message.slashCommand?.commandId === BTW_SLASH_COMMAND_ID) {
    return {
      messageText: slashCommandArgumentText(message),
      source: 'slash-command',
    };
  }

  if (message.slashCommand) return null;
  const text = (message.argumentText ?? message.text ?? '').trim();
  if (!text.startsWith('/btw')) return null;
  const remainder = text.slice('/btw'.length);
  if (remainder && remainder[0].trim()) return null;
  return {
    messageText: remainder.trim(),
    source: 'text-prefix',
  };
}

/**
 * Parse a /ask (or /consult) slash command invocation from a Google Chat message.
 *
 * Slash commands are the preferred invocation method (issue #907). When a user
 * types `/ask reese what's on the calendar?`, Google Chat delivers:
 *   - message.slashCommand.commandId = "1"
 *   - message.argumentText = "reese what's on the calendar?"
 *
 * The first token of argumentText is the target username; the remainder is the
 * question. Returns null if the message doesn't contain a recognized slash command.
 *
 * Fallback: if `argumentText` is absent (older API versions / edge cases),
 * derives arguments from `message.text` by stripping the leading slash command
 * token (e.g., "/ask reese question" -> "reese question").
 */
function parseSlashCommandInvocation(
  message: NonNullable<GoogleChatEvent['message']>,
): CrossUserInvocation | null {
  const commandId = message.slashCommand?.commandId;
  if (!commandId || !CROSS_USER_SLASH_COMMAND_IDS.has(commandId)) {
    return null;
  }

  const cmdName = SLASH_COMMAND_NAMES[commandId] ?? '/ask';

  // argumentText contains everything after the slash command itself.
  // For "/ask reese what's up?" -> argumentText = "reese what's up?"
  // Google Chat strips bot @mentions from argumentText, so we don't need
  // to worry about mention chips polluting the parse.
  //
  // Fallback: when argumentText is absent (older API versions or edge cases
  // where only message.text is populated), derive arguments from message.text
  // by stripping the leading slash command token.
  const argText = slashCommandArgumentText(message);

  if (!argText) {
    // No arguments — caller should prompt with usage help or a dialog
    return {
      targetUsername: '',
      strippedMessage: '',
      source: 'slash-command',
      commandName: cmdName,
    };
  }

  // Split on whitespace: first token = target username, remainder = question.
  // Using split(/\s+/) handles multiple spaces between username and question
  // without leaving residual whitespace in the question text.
  const parts = argText.split(/\s+/);
  const username = parts[0];
  const question = parts.slice(1).join(' ');

  // Validate the extracted username against the same rules used by the
  // @agent:username parser — prevents arbitrary input reaching DynamoDB queries.
  if (!isValidUsername(username)) {
    return null;
  }

  return {
    targetUsername: username.toLowerCase(),
    strippedMessage: question,
    source: 'slash-command',
    commandName: cmdName,
  };
}

/**
 * Look up a user by their email local part (the portion before @).
 * Uses the email-index GSI to query by full email address, constructed
 * by appending each allowed domain to the username.
 *
 * Returns the first matching user or null if no match is found.
 */
async function resolveUserByEmailPrefix(
  username: string,
  log: ReturnType<typeof createLogger>
): Promise<AgentUser | null> {
  // Query all allowed domains in parallel for faster resolution
  const results = await Promise.allSettled(
    ALLOWED_DOMAINS.map(async (domain) => {
      const email = `${username}@${domain}`;
      const result = await dynamoClient.send(
        new QueryCommand({
          TableName: USERS_TABLE,
          IndexName: 'email-index',
          KeyConditionExpression: 'email = :email',
          ExpressionAttributeValues: { ':email': email },
          Limit: 1,
        })
      );
      if (result.Items && result.Items.length > 0) {
        return { email, item: result.Items[0] };
      }
      return null;
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { email, item } = result.value;
      // Validate required fields before casting — DynamoDB items are
      // Record<string, AttributeValue>, not AgentUser
      const user = item as Record<string, unknown>;
      if (!user.email || !user.workspacePrefix) {
        log.warn('User record missing required fields', {
          username,
          email,
          hasEmail: !!user.email,
          hasWorkspacePrefix: !!user.workspacePrefix,
        });
        continue;
      }
      log.info('Resolved cross-user target', {
        username,
        email,
        targetGoogleIdentity: (item as AgentUser).googleIdentity,
      });
      return item as AgentUser;
    }
    if (result.status === 'rejected') {
      log.error('Failed to query email-index GSI', {
        username,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  log.warn('Cross-user target not found', { username });
  return null;
}

// Thread context fetching is a Phase 2 feature — requires domain-wide
// delegation for spaces.messages.list. For Phase 1, the invoker's message
// alone provides sufficient context. See issue #903 for Phase 2 plan.

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/**
 * Apply Bedrock Guardrails for telemetry only.
 *
 * The guardrail runs in detect-and-log mode: we capture whether the
 * service would have intervened and record it in agent_messages via
 * the guardrailBlocked column, but we never refuse or rewrite the
 * user's message. Product direction from the PSD owner is that
 * guardrails must not block any user message — the K-12 filter stays
 * armed as a diagnostic signal only.
 *
 * Service errors (timeouts, throttles, IAM failures) are logged and
 * treated as "did not intervene" so a Bedrock hiccup cannot bounce
 * a chat turn. GUARDRAIL_FAIL_OPEN env var is deprecated — this
 * function always fails open regardless of its value.
 */
async function applyGuardrails(
  text: string,
  log: ReturnType<typeof createLogger>
): Promise<{ allowed: boolean; wouldHaveBlocked: boolean; blockedReason?: string }> {
  if (!GUARDRAIL_ID) {
    return { allowed: true, wouldHaveBlocked: false };
  }

  try {
    const result = await bedrockClient.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: GUARDRAIL_ID,
        guardrailVersion: GUARDRAIL_VERSION,
        source: 'INPUT',
        content: [{ text: { text } }],
      })
    );

    if (result.action === 'GUARDRAIL_INTERVENED') {
      const outputs = result.outputs?.map((o) => o.text).join(' ') || '';
      log.warn('Guardrail would have blocked — passing through per policy', {
        // Stable marker for the GuardrailDenialRate metric filter (#1161).
        marker: 'GUARDRAIL_DENIAL',
        action: result.action,
        outputPreview: outputs.substring(0, 200),
      });
      return {
        allowed: true,
        wouldHaveBlocked: true,
        blockedReason: outputs || 'guardrail intervened',
      };
    }

    return { allowed: true, wouldHaveBlocked: false };
  } catch (error) {
    // Even a service error does not stop a message from going through.
    log.error('Guardrail invocation failed — passing through per policy', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true, wouldHaveBlocked: false };
  }
}

// ---------------------------------------------------------------------------
// AgentCore invocation
// ---------------------------------------------------------------------------

/**
 * Drain an AgentCore SSE stream, discard heartbeat and start events, and
 * return the last event carrying a `result` field.
 *
 * Stream contract (see infra/agent-image/agentcore_wrapper.py):
 *   - start event:     {"type": "start"} — immediate header flush
 *   - heartbeat event: {"type": "heartbeat", "elapsed_s": int} every ~30s
 *   - final event:     {"result": "...", "metadata": {...}}
 *
 * SYNC: This function is intentionally duplicated in agent-cron/index.ts
 * (function `consumeAgentCoreStream`). The two Lambda bundles compile
 * independently (each has its own tsconfig with rootDir=./), so sharing
 * source files requires build pipeline changes. If you modify the SSE
 * parsing logic here, update `consumeAgentCoreStream` in
 * infra/lambdas/agent-cron/index.ts too, and vice versa.
 *
 * Known differences (intentional):
 *   - agent-cron accepts `Response`, agent-router accepts `{ body: unknown }`
 *   - agent-cron logs `totalElapsedMs` and `mode: 'streaming'`
 */
async function consumeAgentCoreStream(
  response: { body: unknown },
  log: ReturnType<typeof createLogger>,
): Promise<Record<string, unknown> | null> {
  if (!response.body) {
    log.error('AgentCore SSE response has no body');
    return null;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let heartbeats = 0;
  let lastResultEvent: Record<string, unknown> | null = null;

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
      // Ignore non-JSON SSE frames.
    }
  };

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
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
    heartbeats,
    haveResult: lastResultEvent !== null,
  });

  return lastResultEvent;
}

interface AgentInvocationContext {
  displayName?: string;
  workspacePrefix?: string;
  /**
   * OpenClaw transcript identity. This is deliberately distinct from the
   * AgentCore runtime session id: one owner-wide runtime serializes durable
   * workspace writes, while each Google Chat space/thread gets independent
   * conversational memory.
   */
  conversationSessionId?: string;
  invokedBy?: { email: string; displayName: string };
  audience?: 'shared-space';
  threadContext?: string;
  attachments?: AgentAttachment[];
  deadlineS?: number;
  runtimeIdOverride?: string;
}

interface AgentCoreResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  model: string | null;
  latencyMs: number;
  modelCallCount: number;
  durationMs: number;
  nudged: boolean;
  messages: Array<{ role: string; content: string }>;
  toolCalls: Array<{
    name: string;
    args: unknown;
    result: unknown;
    status: 'success' | 'error' | 'timeout';
    error_text: string | null;
    duration_ms: number;
    started_at: string;
    finished_at: string;
  }>;
  failed?: boolean;
  errorClass?: string;
  errorSource?: 'harness' | 'router';
  /**
   * True when deleting the lock is safe. Once a runtime call starts, only
   * terminal metadata explicitly proving OpenClaw shutdown, SQLite checkpoint,
   * and the final workspace push can set it. A local rejection before any
   * runtime call is also safe. Transport failure, missing terminal events,
   * legacy results, and false proof remain conservative.
   */
  workspaceFinalizationConfirmed: boolean;
}

interface FailureRecordParams {
  source: 'router' | 'harness' | 'cron' | 'agent_self_report' | 'tool';
  severity: 'error' | 'warn' | 'empty_response';
  /** False persists a diagnostic without incrementing the failure pager. */
  alert?: boolean;
  userId?: string | null;
  sessionId?: string | null;
  scheduleName?: string | null;
  model?: string | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  stackExcerpt?: string | null;
  context?: Record<string, unknown> | null;
}

function failedAgentCoreResult(
  response: string,
  errorClass: string,
  workspaceFinalizationConfirmed = false
): AgentCoreResult {
  return {
    response,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    model: null,
    latencyMs: 0,
    modelCallCount: 0,
    durationMs: 0,
    nudged: false,
    messages: [],
    toolCalls: [],
    failed: true,
    errorClass,
    errorSource: 'router',
    workspaceFinalizationConfirmed,
  };
}

interface SessionLockRenewalScheduler {
  start(callback: () => void, intervalMs: number): unknown;
  stop(timer: unknown): void;
}

interface SessionLockLeaseDependencies {
  renewSessionLock: typeof renewSessionLock;
  releaseSessionLock: typeof releaseSessionLock;
  scheduler: SessionLockRenewalScheduler;
}

const sessionLockLeaseDependencies: SessionLockLeaseDependencies = {
  renewSessionLock,
  releaseSessionLock,
  scheduler: {
    start: (callback, intervalMs) => setInterval(callback, intervalMs),
    stop: timer =>
      clearInterval(timer as ReturnType<typeof setInterval>),
  },
};

/**
 * Keep the owner-wide workspace mutex alive for the entire AgentCore turn.
 *
 * A confirmed terminal result proves the wrapper already stopped OpenClaw,
 * checkpointed SQLite, and finished its final push, so the row can be deleted.
 * On a disconnect, thrown invocation, or missing terminal result, retain the
 * most recently renewed lease. The remote microVM may still be finalizing
 * after this Lambda has stopped receiving bytes.
 */
async function invokeWithSessionLockLease(
  sessionId: string,
  lockToken: string,
  log: ReturnType<typeof createLogger>,
  invocation: () => Promise<AgentCoreResult>,
  dependencies: SessionLockLeaseDependencies =
    sessionLockLeaseDependencies
): Promise<AgentCoreResult> {
  let renewalInFlight: Promise<void> | undefined;
  const renewOnce = () => {
    if (renewalInFlight) return;
    renewalInFlight = (async () => {
      try {
        const renewed = await dependencies.renewSessionLock(
          sessionId,
          lockToken,
          log
        );
        if (!renewed) {
          log.warn('Workspace lock renewal could not confirm ownership', {
            sessionId,
          });
        }
      } catch (error) {
        log.warn('Workspace lock renewal threw unexpectedly', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        renewalInFlight = undefined;
      }
    })();
  };
  const timer = dependencies.scheduler.start(
    renewOnce,
    SESSION_LOCK_RENEW_INTERVAL_MS
  );
  let result: AgentCoreResult | undefined;
  try {
    result = await invocation();
    return result;
  } finally {
    dependencies.scheduler.stop(timer);
    const pendingRenewal = renewalInFlight;
    if (pendingRenewal) await pendingRenewal;
    if (result?.workspaceFinalizationConfirmed) {
      await dependencies.releaseSessionLock(
        sessionId,
        lockToken,
        log
      );
    } else {
      log.warn(
        'Retaining workspace lock after unconfirmed AgentCore completion',
        { sessionId }
      );
    }
  }
}

function cachedAgentCoreRuntimeId(): string {
  const cacheFresh =
    Boolean(cachedRuntimeId) &&
    Boolean(runtimeIdCachedAt) &&
    Date.now() - (runtimeIdCachedAt ?? 0) < RUNTIME_ID_TTL_MS;
  return cacheFresh ? cachedRuntimeId ?? '' : '';
}

async function resolveAgentCoreRuntimeId(
  userContext: AgentInvocationContext | undefined,
  log: ReturnType<typeof createLogger>
): Promise<string> {
  const configuredRuntimeId =
    userContext?.runtimeIdOverride ||
    process.env.AGENTCORE_RUNTIME_ID ||
    cachedAgentCoreRuntimeId();
  if (configuredRuntimeId) return configuredRuntimeId;

  try {
    const param = await ssmClient.send(
      new GetParameterCommand({
        Name: `/aistudio/${ENVIRONMENT}/agentcore-runtime-id`,
      })
    );
    const runtimeId = param.Parameter?.Value || '';
    if (runtimeId) {
      cachedRuntimeId = runtimeId;
      runtimeIdCachedAt = Date.now();
    }
    return runtimeId;
  } catch {
    log.error('Failed to resolve AgentCore Runtime ID from SSM');
    return '';
  }
}

function invocationTtlOptions(
  deadlineS: number | undefined
): { ttlSeconds?: number } {
  if (deadlineS === undefined) return {};
  return {
    ttlSeconds:
      deadlineS === JOB_DEADLINE_S
        ? JOB_INVOCATION_CONTEXT_TTL_S
        : deadlineS,
  };
}

function addOptionalAgentContext(
  payload: Record<string, unknown>,
  context: AgentInvocationContext
): void {
  if (context.conversationSessionId) {
    payload.conversation_session_id = context.conversationSessionId;
  }
  if (context.invokedBy) {
    payload.invoked_by_email = context.invokedBy.email;
    payload.invoked_by_display_name = context.invokedBy.displayName;
  }
  if (context.audience) payload.audience = context.audience;
  if (context.threadContext) payload.thread_context = context.threadContext;
  if (context.attachments?.length) payload.attachments = context.attachments;
  if (context.deadlineS) payload.deadline_s = context.deadlineS;
}

async function createAgentCoreRequestBody(
  message: string,
  userId: string,
  sessionId: string,
  userContext?: AgentInvocationContext
): Promise<string> {
  const context = userContext ?? {};
  const invokedBy = context.invokedBy;
  const invocationAuthority = await issueInvocationContext(
    {
      actorEmail: (invokedBy?.email ?? userId).trim().toLowerCase(),
      ownerEmail: userId.trim().toLowerCase(),
      mode: invokedBy ? 'consultation' : 'owner',
      sessionId,
      workspacePrefix: context.workspacePrefix ?? '',
    },
    invocationTtlOptions(context.deadlineS)
  );
  const payload: Record<string, unknown> = {
    prompt: message,
    user_email: userId,
    user_display_name: context.displayName ?? '',
    workspace_prefix: context.workspacePrefix ?? '',
    invocation_context: invocationAuthority.token,
    invocation_request_proof_key: invocationAuthority.requestProofKey,
  };
  addOptionalAgentContext(payload, context);
  return JSON.stringify(payload);
}

async function fetchAgentCoreResponse(
  runtimeId: string,
  message: string,
  userId: string,
  sessionId: string,
  userContext?: AgentInvocationContext
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  const region = process.env.AWS_REGION || 'us-east-1';
  const account = process.env.AWS_ACCOUNT_ID || '';
  const runtimeArn = runtimeId.startsWith('arn:')
    ? runtimeId
    : `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeId}`;
  const hostname = `bedrock-agentcore.${region}.amazonaws.com`;
  const body = await createAgentCoreRequestBody(
    message,
    userId,
    sessionId,
    userContext
  );
  const signed = await agentCoreSigner.sign(
    new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname,
      path: `/runtimes/${encodeURIComponent(runtimeArn)}/invocations`,
      headers: {
        'Content-Type': 'application/json',
        host: hostname,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        'X-Amzn-Bedrock-AgentCore-Runtime-User-Id': userId,
      },
      body,
    })
  );
  return undiciFetch(`https://${signed.hostname}${signed.path}`, {
    method: signed.method,
    headers: signed.headers as Record<string, string>,
    body: signed.body as string,
    dispatcher: agentCoreDispatcher,
  });
}

async function agentCoreHttpFailure(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  log: ReturnType<typeof createLogger>
): Promise<AgentCoreResult> {
  const errorBody = await response.text();
  log.error('AgentCore invocation failed', {
    status: response.status,
    body: errorBody.substring(0, 500),
  });
  const throttled = response.status === 503 || response.status === 429;
  return failedAgentCoreResult(
    throttled
      ? "I'm temporarily busy. Please try again in a moment."
      : 'I encountered an error processing your message. Please try again.',
    throttled
      ? `AgentCoreThrottled_${response.status}`
      : `AgentCoreHttpError_${response.status}`
  );
}

async function readAgentCoreResponseBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  log: ReturnType<typeof createLogger>
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return (await consumeAgentCoreStream(response, log)) ?? {};
  }
  return (await response.json()) as Record<string, unknown>;
}

function parseAgentMessages(
  value: unknown
): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>)
    .map(message => ({
      role: typeof message.role === 'string' ? message.role : 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
    }))
    .filter(message => message.content.length > 0);
}

function parseToolCallStatus(
  value: unknown
): 'success' | 'error' | 'timeout' {
  return value === 'error' || value === 'timeout' ? value : 'success';
}

function parseAgentToolCalls(value: unknown): AgentCoreResult['toolCalls'] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).map(toolCall => ({
    name: typeof toolCall.name === 'string' ? toolCall.name : 'unknown',
    args: toolCall.args ?? null,
    result: toolCall.result ?? null,
    status: parseToolCallStatus(toolCall.status),
    error_text:
      typeof toolCall.error_text === 'string' ? toolCall.error_text : null,
    duration_ms:
      typeof toolCall.duration_ms === 'number' ? toolCall.duration_ms : 0,
    started_at:
      typeof toolCall.started_at === 'string'
        ? toolCall.started_at
        : new Date().toISOString(),
    finished_at:
      typeof toolCall.finished_at === 'string'
        ? toolCall.finished_at
        : new Date().toISOString(),
  }));
}

function parseAgentCoreResult(
  responseBody: Record<string, unknown>
): AgentCoreResult {
  const metadata =
    (responseBody.metadata as Record<string, unknown> | undefined) ?? {};
  const failed = metadata.failed === true;
  const workspaceFinalizationConfirmed =
    metadata.workspace_finalization_confirmed === true;
  return {
    response: (responseBody.result as string) || 'No response from agent.',
    inputTokens: (metadata.input_tokens as number) || 0,
    outputTokens: (metadata.output_tokens as number) || 0,
    cacheReadInputTokens: (metadata.cache_read_input_tokens as number) || 0,
    cacheWriteInputTokens: (metadata.cache_write_input_tokens as number) || 0,
    model: (metadata.model as string) || 'unknown',
    latencyMs: (metadata.latency_ms as number) || 0,
    modelCallCount: (metadata.model_call_count as number) || 0,
    durationMs: (metadata.duration_ms as number) || 0,
    nudged: metadata.nudged === true,
    messages: parseAgentMessages(metadata.messages),
    toolCalls: parseAgentToolCalls(metadata.tool_calls),
    failed,
    errorClass:
      typeof metadata.error_class === 'string'
        ? metadata.error_class
        : undefined,
    errorSource: failed ? 'harness' : undefined,
    workspaceFinalizationConfirmed,
  };
}

async function invokeAgentCore(
  message: string,
  userId: string,
  sessionId: string,
  log: ReturnType<typeof createLogger>,
  userContext?: AgentInvocationContext
): Promise<AgentCoreResult> {
  const runtimeId = await resolveAgentCoreRuntimeId(userContext, log);
  if (!runtimeId) {
    return failedAgentCoreResult(
      'Your agent is not yet deployed. An administrator needs to push the agent image and deploy the AgentCore Runtime.',
      'AgentNotDeployed',
      true
    );
  }

  try {
    const response = await fetchAgentCoreResponse(
      runtimeId,
      message,
      userId,
      sessionId,
      userContext
    );
    if (!response.ok) return agentCoreHttpFailure(response, log);
    return parseAgentCoreResult(await readAgentCoreResponseBody(response, log));
  } catch (error) {
    log.error('AgentCore invocation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    const errorClass =
      error instanceof Error
        ? error.name || 'AgentCoreInvocationError'
        : 'AgentCoreInvocationError';
    return failedAgentCoreResult(
      "I'm temporarily unable to help. Please try again shortly.",
      errorClass
    );
  }
}

// ---------------------------------------------------------------------------
// Google Chat response
// ---------------------------------------------------------------------------

/**
 * Build (or reuse) the authenticated Google Chat API client. The `chat.bot`
 * scope covers both message sends AND `media.download` of message
 * attachments, so the same client serves responses and attachment fetches.
 * Cached across warm invocations to avoid an OAuth token round-trip; the
 * cache is invalidated when credentials refresh (TTL expiry or parse error).
 */
async function getChatAuth(): Promise<GoogleChatAuth> {
  const credentialsJson = await getGoogleCredentials();
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(credentialsJson) as Record<string, unknown>;
  } catch {
    // Clear the cache so the next invocation fetches fresh credentials from
    // Secrets Manager in case the secret was recently updated/fixed.
    cachedGoogleCredentials = null;
    credentialsCachedAt = null;
    cachedChatAuth = null;
    cachedChatClient = null;
    throw new Error('Google credentials secret contains invalid JSON');
  }

  if (!cachedChatAuth) {
    cachedChatAuth = createGoogleChatAuth(credentials);
  }

  return cachedChatAuth;
}

async function getChatClient(): Promise<NonNullable<typeof cachedChatClient>> {
  const googleAuth = await getChatAuth();
  if (!cachedChatClient) {
    cachedChatClient = chatPkg.chat({ version: 'v1', auth: googleAuth });
  }
  return cachedChatClient;
}

/**
 * Fetch Chat-uploaded attachment bytes into the agent's S3 workspace
 * (issue #1138 F1 byte-fetch). Drive files are deliberately NOT fetched —
 * the drive.file scope barrier is a design decision; only content the user
 * pushed directly into the conversation with the agent is delivered.
 *
 * For each `chat-upload` attachment, streams `media.download` (authorized by
 * the same `chat.bot` app credential used to send responses) into
 * `s3://$WORKSPACE_BUCKET/<workspacePrefix>/attachments/...` via multipart
 * upload, so even large uploads never buffer fully in Lambda memory (Chat's
 * own per-file ceiling is 200 MB). On success the attachment gains a
 * `workspacePath`; the container pulls exactly that key into the microVM
 * before the turn. Failures are logged and leave the attachment without a
 * `workspacePath` — the prompt header then tells the agent the file could
 * not be downloaded, instead of silently pretending it doesn't exist.
 *
 * Mutates the passed attachments in place. Never throws: a fetch failure
 * must not take down the whole turn — the message text still flows.
 */
async function fetchChatUploads(
  attachments: AgentAttachment[],
  workspacePrefix: string,
  log: ReturnType<typeof createLogger>,
  messageName = '',
  messageCreatedAt = ''
): Promise<void> {
  const uploads = attachments.filter(
    (a) => a.source === 'chat-upload' && a.attachmentResourceName
  );
  if (uploads.length === 0 || !workspacePrefix) return;

  const bucket = process.env.WORKSPACE_BUCKET || '';
  if (!bucket) {
    log.warn('WORKSPACE_BUCKET not configured — Chat uploads not fetched', {
      count: uploads.length,
    });
    return;
  }

  let chatClient: Awaited<ReturnType<typeof getChatClient>>;
  try {
    chatClient = await getChatClient();
  } catch (error) {
    log.error('Chat client unavailable — Chat uploads not fetched', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const [index, att] of uploads.entries()) {
    const startedAt = Date.now();
    try {
      // `alt: 'media'` returns the raw bytes; responseType 'stream' keeps
      // them as a Readable instead of buffering the whole file.
      const download = await chatClient.media.download(
        { resourceName: att.attachmentResourceName as string, alt: 'media' },
        { responseType: 'stream' }
      );
      const parsedCreateTime = new Date(messageCreatedAt);
      const stableCreateTime = Number.isNaN(parsedCreateTime.getTime())
        ? new Date(0)
        : parsedCreateTime;
      const messageIdentity = crypto
        .createHash('sha256')
        .update(
          `${messageName}\0${att.attachmentResourceName ?? ''}\0${index}`
        )
        .digest('hex')
        .slice(0, 16);
      const workspacePath = buildWorkspacePath(
        att.name,
        index,
        stableCreateTime,
        messageIdentity
      );
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: bucket,
          Key: `${workspacePrefix}/${workspacePath}`,
          Body: download.data as unknown as Readable,
          ...(att.mimeType ? { ContentType: att.mimeType } : {}),
        },
      });
      await upload.done();
      att.workspacePath = workspacePath;
      log.info('Chat upload fetched to agent workspace', {
        name: att.name,
        mimeType: att.mimeType,
        workspacePath,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      log.error('Chat upload fetch failed — forwarding metadata only', {
        name: att.name,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Promote a deadline-expired turn to a background ECS job (#1138).
 *
 * Called when a MESSAGE turn returns ChatDeadlineExpired(Partial): instead
 * of posting the failure-framed partial, the router pre-acquires a
 * `kind='job'` session lock, launches the job-runner Fargate task with a
 * JOB_PAYLOAD env override, and posts a background ack. The runner resumes
 * the SAME AgentCore session with a 2-hour deadline and posts the final
 * answer when done.
 *
 * Returns true when the job launched or RunTask acceptance is uncertain, so
 * the caller never starts overlapping fallback work. Returns false only when
 * configuration, lock contention, payload validation, or an explicit service
 * rejection proves no task was accepted.
 */
interface JobPromotionInput {
  /** Immutable source-message identity used for ECS idempotency. */
  promotionId: string;
  reason: PromotionReason;
  /** Build-rotated AgentCore runtime affinity identity. */
  sessionId: string;
  /** Deployment-stable owner workspace mutex. */
  workspaceLockId: string;
  /** OpenClaw transcript identity for the originating Chat space/thread. */
  conversationSessionId?: string;
  userEmail: string;
  googleIdentity: string;
  displayName: string;
  workspacePrefix: string;
  spaceName: string;
  threadName?: string;
  isDM: boolean;
  originalPrompt: string;
  acknowledgementPrefix?: string;
  responsePrefix?: string;
}

interface JobPromotionConfig {
  clusterArn: string;
  taskDefArn: string;
  subnets: string[];
  securityGroup: string;
  containerName: string;
}

function getJobPromotionConfig(): JobPromotionConfig | null {
  const config: JobPromotionConfig = {
    clusterArn: process.env.JOB_CLUSTER_ARN || '',
    taskDefArn: process.env.JOB_TASK_DEF_ARN || '',
    subnets: (process.env.JOB_SUBNETS || '').split(',').filter(Boolean),
    securityGroup: process.env.JOB_SECURITY_GROUP || '',
    containerName: process.env.JOB_CONTAINER_NAME || 'job-runner',
  };
  const requiredValues = [
    config.clusterArn,
    config.taskDefArn,
    config.securityGroup,
  ];
  return requiredValues.some(value => value.length === 0) ||
    config.subnets.length === 0
    ? null
    : config;
}

function promotedJobRunTaskCommand(
  config: JobPromotionConfig,
  payload: string,
  clientToken: string
): RunTaskCommand {
  return new RunTaskCommand({
    clientToken,
    cluster: config.clusterArn,
    taskDefinition: config.taskDefArn,
    launchType: 'FARGATE',
    count: 1,
    startedBy: 'agent-router-promotion',
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
  });
}

async function runPromotedJob(
  config: JobPromotionConfig,
  payload: string,
  clientToken: string
): Promise<string> {
  const result = await ecsClient.send(
    promotedJobRunTaskCommand(config, payload, clientToken)
  );
  const taskArn = result.tasks?.[0]?.taskArn;
  if (taskArn) return taskArn;
  if (result.failures?.length) {
    const failureSummary = result.failures
      .map(failure =>
        `${failure.reason ?? 'unknown'}${
          failure.detail ? ` (${failure.detail})` : ''
        }`
      )
      .join('; ');
    throw new DefiniteRunTaskFailure(
      `RunTask failures: ${failureSummary}`
    );
  }
  throw new AmbiguousRunTaskFailure(
    'RunTask returned without a task ARN or explicit failure'
  );
}

class DefiniteRunTaskFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefiniteRunTaskFailure';
  }
}

class AmbiguousRunTaskFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousRunTaskFailure';
  }
}

type RunTaskFailureCertainty = 'definite' | 'ambiguous';

const DEFINITE_RUN_TASK_ERROR_NAMES = new Set([
  'AccessDeniedException',
  'ClientException',
  'ClusterNotFoundException',
  'InvalidParameterException',
  'PlatformTaskDefinitionIncompatibilityException',
  'PlatformUnknownException',
  'SerializationException',
  'UnsupportedFeatureException',
  'ValidationException',
]);
const DEFINITE_RUN_TASK_HTTP_STATUSES = new Set([401, 403, 404, 429]);
const RUN_TASK_THROTTLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
]);
const RUN_TASK_THROTTLE_HTTP_STATUSES = new Set([400, 429]);
const RUN_TASK_AMBIGUOUS_ATTEMPTS = 2;

function runTaskFailureCertainty(error: unknown): RunTaskFailureCertainty {
  if (error instanceof DefiniteRunTaskFailure) return 'definite';
  if (error instanceof AmbiguousRunTaskFailure) return 'ambiguous';
  const details = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  } | null;
  const name = typeof details?.name === 'string' ? details.name : '';
  if (DEFINITE_RUN_TASK_ERROR_NAMES.has(name)) return 'definite';
  const rawStatus = details?.$metadata?.httpStatusCode;
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const explicitThrottle =
    RUN_TASK_THROTTLE_ERROR_NAMES.has(name) &&
    status !== undefined &&
    RUN_TASK_THROTTLE_HTTP_STATUSES.has(status);
  if (
    explicitThrottle ||
    (status !== undefined &&
      DEFINITE_RUN_TASK_HTTP_STATUSES.has(status))
  ) {
    // These are explicit client/auth/throttling rejections. In particular,
    // a 429 means ECS declined the request; no task was accepted.
    return 'definite';
  }
  // Timeouts, disconnects, conflicts, 5xx responses, and unknown SDK errors
  // cannot prove whether ECS accepted the task before the caller lost contact.
  return 'ambiguous';
}

function jobPromotionIdentity(
  input: Pick<
    JobPromotionInput,
    'promotionId' | 'reason' | 'workspaceLockId'
  >
): { clientToken: string; lockToken: string } {
  const digest = crypto
    .createHash('sha256')
    .update(
      `${input.workspaceLockId}\0${input.promotionId}\0${input.reason}`
    )
    .digest('hex');
  return {
    // ECS RunTask accepts at most 64 visible ASCII characters.
    clientToken: `agent-job-${digest.slice(0, 54)}`,
    // JOB_PAYLOAD is part of RunTask's idempotency comparison, so its DDB
    // token must be stable across delivery retries too.
    lockToken: `job-${digest}`,
  };
}

interface JobPromotionDependencies {
  getConfig(): JobPromotionConfig | null;
  getRuntimeId(): string;
  acquireLock(
    workspaceLockId: string,
    requestedLockToken: string,
    log: ReturnType<typeof createLogger>
  ): Promise<string | null>;
  releaseLock(
    workspaceLockId: string,
    lockToken: string,
    log: ReturnType<typeof createLogger>
  ): Promise<void>;
  runJob(
    config: JobPromotionConfig,
    payload: string,
    clientToken: string
  ): Promise<string>;
  sendResponse: typeof sendGoogleChatResponse;
}

const jobPromotionDependencies: JobPromotionDependencies = {
  getConfig: getJobPromotionConfig,
  getRuntimeId: () =>
    process.env.AGENTCORE_RUNTIME_ID || cachedRuntimeId || '',
  acquireLock: (workspaceLockId, requestedLockToken, log) =>
    tryAcquireSessionLock(
      workspaceLockId,
      log,
      'job',
      undefined,
      requestedLockToken
    ),
  releaseLock: releaseSessionLock,
  runJob: runPromotedJob,
  sendResponse: sendGoogleChatResponse,
};

function promotionAcknowledgement(
  input: JobPromotionInput,
  launchAmbiguous: boolean
): string {
  const prefix =
    input.acknowledgementPrefix ?? input.responsePrefix ?? '';
  return launchAmbiguous
    ? prefix +
        '⏳ The background handoff is still being confirmed. I protected this ' +
        'workspace from overlapping work and will post here if the job started.'
    : prefix +
        '⏳ This is taking longer than one pass allows — I\'ve moved it to a ' +
        'background job and will post the result here when it\'s done.';
}

async function sendPromotionAcknowledgement(
  input: JobPromotionInput,
  launchAmbiguous: boolean,
  log: ReturnType<typeof createLogger>,
  dependencies: JobPromotionDependencies
): Promise<void> {
  try {
    await dependencies.sendResponse(
      input.spaceName,
      input.threadName,
      promotionAcknowledgement(input, launchAmbiguous),
      log,
      jobChatDeliveryContext(input, true)
    );
  } catch (error) {
    // Once RunTask is accepted or uncertain, Chat delivery must not roll back
    // the workspace lock or trigger an overlapping fallback turn.
    log.error('Background promotion acknowledgement delivery failed', {
      launchAmbiguous,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function promoteToJobWithDependencies(
  input: JobPromotionInput,
  log: ReturnType<typeof createLogger>,
  dependencies: JobPromotionDependencies
): Promise<boolean> {
  const config = dependencies.getConfig();
  if (!config) {
    log.warn('Job promotion not configured — falling back to failure frame');
    return false;
  }

  const runtimeId = dependencies.getRuntimeId();
  if (!runtimeId) {
    log.warn('Job promotion aborted — no resolved AgentCore runtime id');
    return false;
  }

  const identity = jobPromotionIdentity(input);
  // Pre-acquire the job lock so there is no unlocked gap between promotion
  // and the runner's first renewal (~60s task cold start). If someone else
  // grabbed the session in the meantime, skip promotion.
  const jobLockToken = await dependencies.acquireLock(
    input.workspaceLockId,
    identity.lockToken,
    log
  );
  if (jobLockToken === null) {
    log.warn('Job promotion aborted — session lock contended');
    return false;
  }

  let payload: string;
  try {
    payload = buildJobPayload({
      reason: input.reason,
      sessionId: input.sessionId,
      workspaceLockId: input.workspaceLockId,
      conversationSessionId: input.conversationSessionId,
      lockToken: jobLockToken,
      runtimeId,
      userEmail: input.userEmail,
      googleIdentity: input.googleIdentity,
      displayName: input.displayName,
      workspacePrefix: input.workspacePrefix,
      spaceName: input.spaceName,
      threadName: input.threadName,
      isDM: input.isDM,
      originalPrompt: input.originalPrompt,
      responsePrefix: input.responsePrefix,
    });
  } catch (error) {
    // Payload/configuration failures happen before RunTask and are therefore
    // safe to roll back.
    await dependencies.releaseLock(
      input.workspaceLockId,
      jobLockToken,
      log
    );
    log.error('Job promotion rejected before RunTask', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  let taskArn: string | undefined;
  let launchError: unknown;
  let sawAmbiguousOutcome = false;
  for (
    let attempt = 1;
    attempt <= RUN_TASK_AMBIGUOUS_ATTEMPTS;
    attempt += 1
  ) {
    try {
      taskArn = await dependencies.runJob(
        config,
        payload,
        identity.clientToken
      );
      launchError = undefined;
      break;
    } catch (error) {
      launchError = error;
      const certainty = runTaskFailureCertainty(error);
      if (certainty === 'definite' && !sawAmbiguousOutcome) {
        await dependencies.releaseLock(
          input.workspaceLockId,
          jobLockToken,
          log
        );
        log.error('Job promotion rejected by RunTask', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      sawAmbiguousOutcome = true;
      if (attempt < RUN_TASK_AMBIGUOUS_ATTEMPTS) {
        log.warn('RunTask completion uncertain; retrying idempotently', {
          attempt,
          clientToken: identity.clientToken,
        });
      }
    }
  }

  if (!taskArn) {
    log.error('RunTask remained uncertain; retaining workspace lock', {
      error:
        launchError instanceof Error
          ? launchError.message
          : String(launchError),
      clientToken: identity.clientToken,
      attempts: RUN_TASK_AMBIGUOUS_ATTEMPTS,
    });
    await sendPromotionAcknowledgement(input, true, log, dependencies);
    return true;
  }

  await sendPromotionAcknowledgement(input, false, log, dependencies);
  log.info('Turn promoted to background job', {
    // Stable marker for the BackgroundPromotion metric filter (#1161). This
    // is a "platform compensating for model behavior" counter — its trend is
    // an input to Loop-2 instruction tuning, so it's a metric without an alarm.
    marker: 'BACKGROUND_PROMOTION',
    reason: input.reason,
    sessionId: input.sessionId,
    taskArn,
    clientToken: identity.clientToken,
  });
  return true;
}

async function promoteToJob(
  input: JobPromotionInput,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  return promoteToJobWithDependencies(
    input,
    log,
    jobPromotionDependencies
  );
}

async function sendGoogleChatResponse(
  spaceName: string,
  threadName: string | undefined,
  text: string,
  log: ReturnType<typeof createLogger>,
  deliveryContext: ChatResponseDeliveryContext = {}
): Promise<ChatResponseDeliveryOutcome> {
  const retryableContext =
    deliveryContext.durableDelivery === true
      ? {
          ...deliveryContext,
          deliveryRequestId:
            deliveryContext.deliveryRequestId ?? crypto.randomUUID(),
        }
      : deliveryContext;
  const input = {
    spaceName,
    threadName,
    text,
    deliveryContext: retryableContext,
  };
  try {
    const chatClient = await getChatClient();
    const outcome = await sendGoogleChatResponseWithDependencies(
      input,
      log,
      {
        createMessage: async request => {
          await chatClient.spaces.messages.create(request);
        },
        recordFailure,
      }
    );
    if (
      outcome !== 'failed' ||
      retryableContext.durableDelivery !== true
    ) {
      return outcome;
    }
    await enqueueDeferredChatDelivery(input, log);
    return 'deferred';
  } catch (error) {
    if (retryableContext.durableDelivery !== true) throw error;
    try {
      await enqueueDeferredChatDelivery(input, log);
      return 'deferred';
    } catch (enqueueError) {
      log.error('Failed to enqueue completed Chat response for retry', {
        error: sanitizeDiagnostic(errorMessage(enqueueError)),
      });
      throw error;
    }
  }
}

interface ChatResponseDeliveryContext {
  isSharedSpace?: boolean;
  /** Queue this exact response for idempotent retry instead of rerunning AgentCore. */
  durableDelivery?: boolean;
  /** Stable Google Chat request id carried across delivery retries. */
  deliveryRequestId?: string;
  userId?: string;
  sessionId?: string;
}

interface ChatResponseInput {
  spaceName: string;
  threadName?: string;
  text: string;
  deliveryContext: ChatResponseDeliveryContext;
}

interface DeferredChatDeliveryEnvelope {
  kind: typeof CHAT_DELIVERY_ENVELOPE_KIND;
  spaceName: string;
  threadName?: string;
  text: string;
  deliveryContext: ChatResponseDeliveryContext;
}

function isBoundedString(
  value: unknown,
  minLength: number,
  maxLength: number
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength
  );
}

function strictObject(value: unknown): Record<string, unknown> | null {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function validOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function validOptionalBoundedString(
  value: unknown,
  maximumLength: number
): boolean {
  return (
    value === undefined ||
    isBoundedString(value, 1, maximumLength)
  );
}

const DEFERRED_CHAT_CONTEXT_KEYS = new Set([
  'isSharedSpace',
  // Accepted only so retry envelopes queued by the preceding deployment can
  // be delivered after rollout. These legacy routing hints are discarded:
  // delivery is always bound to the envelope's exact space + thread.
  'allowDmFallback',
  'durableDelivery',
  'deliveryRequestId',
  'senderGoogleIdentity',
  'userId',
  'sessionId',
]);

function parseDeferredChatDeliveryContext(
  value: unknown
): ChatResponseDeliveryContext | null {
  const rawContext = strictObject(value);
  if (!rawContext) return null;
  if (!hasOnlyKeys(rawContext, DEFERRED_CHAT_CONTEXT_KEYS)) return null;
  if (rawContext.durableDelivery !== false) return null;
  if (!isBoundedString(rawContext.deliveryRequestId, 36, 36)) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(rawContext.deliveryRequestId)
  ) {
    return null;
  }
  if (!validOptionalBoolean(rawContext.isSharedSpace)) return null;
  if (!validOptionalBoolean(rawContext.allowDmFallback)) return null;
  if (!validOptionalBoundedString(rawContext.senderGoogleIdentity, 512)) {
    return null;
  }
  if (!validOptionalBoundedString(rawContext.userId, 512)) return null;
  if (!validOptionalBoundedString(rawContext.sessionId, 256)) return null;
  return {
    isSharedSpace: rawContext.isSharedSpace === true,
    durableDelivery: false,
    deliveryRequestId: rawContext.deliveryRequestId,
    ...(typeof rawContext.userId === 'string'
      ? { userId: rawContext.userId }
      : {}),
    ...(typeof rawContext.sessionId === 'string'
      ? { sessionId: rawContext.sessionId }
      : {}),
  };
}

const DEFERRED_CHAT_ENVELOPE_KEYS = new Set([
  'kind',
  'spaceName',
  'threadName',
  'text',
  'deliveryContext',
]);

function parseDeferredChatDelivery(
  body: string
): DeferredChatDeliveryEnvelope | null {
  if (
    Buffer.byteLength(body, 'utf8') >
    MAX_CHAT_DELIVERY_ENVELOPE_BYTES
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const envelope = strictObject(parsed);
  if (!envelope) return null;
  if (!hasOnlyKeys(envelope, DEFERRED_CHAT_ENVELOPE_KEYS)) return null;
  if (envelope.kind !== CHAT_DELIVERY_ENVELOPE_KIND) return null;
  if (!isBoundedString(envelope.spaceName, 1, 512)) return null;
  if (!validOptionalBoundedString(envelope.threadName, 1024)) return null;
  if (!isBoundedString(envelope.text, 1, 16 * 1024)) return null;
  const deliveryContext = parseDeferredChatDeliveryContext(
    envelope.deliveryContext
  );
  if (!deliveryContext) return null;
  return {
    kind: CHAT_DELIVERY_ENVELOPE_KIND,
    spaceName: envelope.spaceName,
    ...(typeof envelope.threadName === 'string'
      ? { threadName: envelope.threadName }
      : {}),
    text: envelope.text,
    deliveryContext,
  };
}

/**
 * Distinguish a malformed durable-delivery envelope from an ordinary Chat
 * event after strict parsing fails. Reserved envelopes must remain failed SQS
 * records so they can retry and ultimately reach the DLQ instead of being
 * acknowledged as TYPE_UNSPECIFIED Chat events.
 */
function hasDeferredChatDeliveryKind(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return strictObject(parsed)?.kind === CHAT_DELIVERY_ENVELOPE_KIND;
}

function parseDeferredChatDeliveryRecord(
  body: string
): DeferredChatDeliveryEnvelope | null {
  const delivery = parseDeferredChatDelivery(body);
  if (delivery) return delivery;
  if (hasDeferredChatDeliveryKind(body)) {
    throw new ChatDeliveryRetryError(
      'Malformed durable Chat delivery envelope'
    );
  }
  return null;
}

async function enqueueDeferredChatDelivery(
  input: ChatResponseInput,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const queueUrl = process.env.ROUTER_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('ROUTER_QUEUE_URL is not configured');
  }
  const requestId = input.deliveryContext.deliveryRequestId;
  if (!requestId) {
    throw new Error('Durable Chat delivery requires a request id');
  }
  const envelope: DeferredChatDeliveryEnvelope = {
    kind: CHAT_DELIVERY_ENVELOPE_KIND,
    spaceName: input.spaceName,
    ...(input.threadName ? { threadName: input.threadName } : {}),
    text: input.text,
    deliveryContext: {
      ...input.deliveryContext,
      durableDelivery: false,
      deliveryRequestId: requestId,
    },
  };
  const messageBody = JSON.stringify(envelope);
  if (
    Buffer.byteLength(messageBody, 'utf8') >
    MAX_CHAT_DELIVERY_ENVELOPE_BYTES
  ) {
    throw new Error('Durable Chat delivery envelope is too large');
  }
  const request = {
    QueueUrl: queueUrl,
    MessageBody: messageBody,
    DelaySeconds: 15,
  };
  let lastError: unknown;
  for (const delayMs of [0, 250, 750]) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    try {
      await sqsClient.send(new SendMessageCommand(request));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  log.warn('Queued completed Chat response for durable delivery retry', {
    spaceName: input.spaceName,
    hasThread: Boolean(input.threadName),
    deliveryRequestId: requestId,
  });
}

type ChatResponseDeliveryOutcome =
  | 'delivered'
  | 'deferred'
  | 'failed';

interface ChatMessageCreateRequest {
  parent: string;
  requestBody: Record<string, unknown>;
  requestId?: string;
  messageReplyOption?: 'REPLY_MESSAGE_OR_FAIL';
}

interface ChatResponseDependencies {
  createMessage(request: ChatMessageCreateRequest): Promise<void>;
  recordFailure(
    params: FailureRecordParams,
    log: ReturnType<typeof createLogger>
  ): Promise<void>;
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as Record<string, unknown>;
  const response =
    typeof candidate.response === 'object' && candidate.response !== null
      ? (candidate.response as Record<string, unknown>)
      : undefined;
  for (const value of [
    candidate.code,
    candidate.status,
    response?.status,
  ]) {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isChatPostPermissionDenied(error: unknown): boolean {
  return errorStatusCode(error) === 403;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prepareGoogleChatMessage(
  spaceName: string,
  text: string,
  log: ReturnType<typeof createLogger>
): {
  messageBody: Record<string, unknown>;
  hasCards: boolean;
  hasAccessoryWidgets: boolean;
} {
  // Pull a rich-output envelope out of the agent reply, if one is present.
  // The envelope carries cardsV2 / accessoryWidgets the chat-card / chat-chart
  // skills produced. Remaining prose becomes the message's `text` field
  // (notification preview + fallback for clients that don't render cards).
  const { envelope, remaining, malformed } = extractRichEnvelope(text);
  if (malformed) {
    log.warn('rich_envelope_malformed — sending plain text', {
      space: spaceName,
      preview: text.slice(0, 200),
    });
  }

  const messageBody: Record<string, unknown> = {};
  if (envelope) {
    if (envelope.cardsV2) messageBody.cardsV2 = envelope.cardsV2;
    if (envelope.accessoryWidgets) messageBody.accessoryWidgets = envelope.accessoryWidgets;
    if (envelope.actionResponse) messageBody.actionResponse = envelope.actionResponse;
    // Google Chat requires `text` non-empty for notification previews, even
    // when cardsV2 carries the visible payload. Prefer the agent's prose,
    // then the explicit textFallback, then a generic placeholder.
    const fallback = remaining || envelope.textFallback || 'Rich response';
    messageBody.text = fallback;
  } else {
    messageBody.text = remaining || text;
  }
  return {
    messageBody,
    hasCards: Boolean(envelope?.cardsV2),
    hasAccessoryWidgets: Boolean(envelope?.accessoryWidgets),
  };
}

async function recordInPlaceChatDeliveryFailure(
  input: ChatResponseInput,
  error: unknown,
  log: ReturnType<typeof createLogger>,
  dependencies: ChatResponseDependencies
): Promise<void> {
  const permissionDenied = isChatPostPermissionDenied(error);
  const completedResponse =
    typeof input.deliveryContext.deliveryRequestId === 'string';
  const errorClass = permissionDenied
    ? 'ChatPostPermissionDenied'
    : completedResponse
      ? 'ChatResponseDeliveryFailed'
      : 'ChatLifecycleNoticeDeliveryFailed';
  const phase = completedResponse
    ? 'google_chat_response'
    : 'google_chat_lifecycle_notice';
  log[completedResponse ? 'error' : 'warn'](
    'Google Chat delivery failed in its originating space/thread',
    {
    space: input.spaceName,
    ...(input.threadName ? { thread: input.threadName } : {}),
    errorClass,
    retryInPlace: completedResponse,
    channelRebound: false,
    }
  );
  await dependencies.recordFailure(
    {
      source: 'router',
      severity: completedResponse ? 'error' : 'warn',
      ...(completedResponse ? {} : { alert: false }),
      userId: input.deliveryContext.userId,
      sessionId: input.deliveryContext.sessionId,
      errorClass,
      errorMessage: sanitizeDiagnostic(errorMessage(error)),
      context: {
        phase,
        spaceName: input.spaceName,
        ...(input.threadName ? { threadName: input.threadName } : {}),
        retryInPlace: completedResponse,
        channelRebound: false,
      },
    },
    log
  );
}

async function sendGoogleChatResponseWithDependencies(
  input: ChatResponseInput,
  log: ReturnType<typeof createLogger>,
  dependencies: ChatResponseDependencies
): Promise<ChatResponseDeliveryOutcome> {
  const { spaceName, threadName, text, deliveryContext } = input;
  const prepared = prepareGoogleChatMessage(spaceName, text, log);
  const messageBody: Record<string, unknown> = {
    ...prepared.messageBody,
    ...(threadName ? { thread: { name: threadName } } : {}),
  };
  const createRequest: ChatMessageCreateRequest = {
    parent: spaceName,
    requestBody: messageBody,
    ...(deliveryContext.deliveryRequestId
      ? { requestId: deliveryContext.deliveryRequestId }
      : {}),
    ...(threadName
      ? {
          messageReplyOption: 'REPLY_MESSAGE_OR_FAIL',
        }
      : {}),
  };
  try {
    await dependencies.createMessage(createRequest);
  } catch (error) {
    await recordInPlaceChatDeliveryFailure(
      input,
      error,
      log,
      dependencies
    );
    return 'failed';
  }

  log.info('Response sent to Google Chat', {
    space: spaceName,
    responseLength: text.length,
    hasCards: prepared.hasCards,
    hasAccessoryWidgets: prepared.hasAccessoryWidgets,
  });
  return 'delivered';
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Content text cap before truncation — 64KB matches the migration. */
const CONTENT_CHAR_CAP = 64_000;
/** Stringified JSON cap for tool args/result — 16KB matches the migration. */
const TOOL_JSON_CHAR_CAP = 16_000;

function truncateContent(text: string): { value: string; truncated: boolean } {
  if (text.length <= CONTENT_CHAR_CAP) return { value: text, truncated: false };
  return { value: text.slice(0, CONTENT_CHAR_CAP), truncated: true };
}

/**
 * Encode `value` as a JSON string for storage in a jsonb column. postgres.js
 * has a `sql.json()` helper but it expects a typed JSONValue and we're
 * working with `unknown` from the harness — easier to stringify ourselves
 * and let postgres.js pass it through verbatim into the jsonb column.
 */
function truncateJsonValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    return JSON.stringify({ _truncated: true, error: 'JSON.stringify failed' });
  }
  if (s.length <= TOOL_JSON_CHAR_CAP) return s;
  return JSON.stringify({
    _truncated: true,
    preview: s.slice(0, TOOL_JSON_CHAR_CAP - 32),
  });
}

interface TelemetryToolCall {
  name: string;
  args: unknown;
  result: unknown;
  status: 'success' | 'error' | 'timeout';
  error_text: string | null;
  duration_ms: number;
  started_at: string;
  finished_at: string;
}

interface TelemetryParams {
  userId: string;
  sessionId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  latencyMs: number;
  modelCallCount?: number;
  durationMs?: number;
  nudged?: boolean;
  guardrailBlocked: boolean;
  spaceName: string;
  invokedBy?: string;
  agentOwnerId?: string;
  topic?: Topic | null;
  messages?: Array<{ role: string; content: string }>;
  toolCalls?: TelemetryToolCall[];
}

interface TelemetryDefaults {
  invokedBy: string | null;
  agentOwnerId: string | null;
  topic: Topic | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelCallCount: number;
  durationMs: number;
  nudged: boolean;
  totalTokens: number;
}

const MAX_MESSAGES_PER_TURN = 200;
const MAX_TOOLS_PER_TURN = 200;

function normalizeTelemetryParams(params: TelemetryParams): TelemetryDefaults {
  const cacheReadTokens = params.cacheReadInputTokens ?? 0;
  const cacheWriteTokens = params.cacheWriteInputTokens ?? 0;
  return {
    invokedBy: params.invokedBy ?? null,
    agentOwnerId: params.agentOwnerId ?? null,
    topic: params.topic ?? null,
    cacheReadTokens,
    cacheWriteTokens,
    modelCallCount: params.modelCallCount ?? 0,
    durationMs: params.durationMs ?? 0,
    nudged: params.nudged ?? false,
    totalTokens:
      params.inputTokens +
      params.outputTokens +
      cacheReadTokens +
      cacheWriteTokens,
  };
}

async function insertTelemetrySummary(
  sql: postgres.Sql,
  params: TelemetryParams,
  defaults: TelemetryDefaults
): Promise<number | undefined> {
  const [messageRow] = await Promise.all([
    sql<{ id: number }[]>`INSERT INTO agent_messages
        (user_id, session_id, model, input_tokens, output_tokens,
         cache_read_input_tokens, cache_write_input_tokens,
         latency_ms, model_call_count, duration_ms, nudged,
         guardrail_blocked, space_name, invoked_by, agent_owner_id, topic, created_at)
        VALUES (${params.userId}, ${params.sessionId}, ${params.model},
                ${params.inputTokens}, ${params.outputTokens},
                ${defaults.cacheReadTokens}, ${defaults.cacheWriteTokens},
                ${params.latencyMs}, ${defaults.modelCallCount}, ${defaults.durationMs}, ${defaults.nudged},
                ${params.guardrailBlocked},
                ${params.spaceName}, ${defaults.invokedBy}, ${defaults.agentOwnerId}, ${defaults.topic}, NOW())
        RETURNING id`,
    sql`INSERT INTO agent_sessions
        (user_id, session_id, session_start, total_messages, total_tokens, created_at, updated_at)
        VALUES (${params.userId}, ${params.sessionId}, NOW(), 1, ${defaults.totalTokens}, NOW(), NOW())
        ON CONFLICT (session_id) DO UPDATE SET
          total_messages = agent_sessions.total_messages + 1,
          total_tokens = agent_sessions.total_tokens + EXCLUDED.total_tokens,
          session_end = NOW()`,
  ]);
  return messageRow[0]?.id;
}

function buildMessageTelemetryWrites(
  sql: postgres.Sql,
  messageId: number,
  params: TelemetryParams,
  log: ReturnType<typeof createLogger>
): Promise<unknown>[] {
  const messages = params.messages ?? [];
  const cappedMessages = messages.slice(0, MAX_MESSAGES_PER_TURN);
  if (messages.length > MAX_MESSAGES_PER_TURN) {
    log.warn('Deep telemetry message cap hit — truncating', {
      actual: messages.length,
      cap: MAX_MESSAGES_PER_TURN,
      sessionId: params.sessionId,
    });
  }
  return cappedMessages.map(message => {
    const { value, truncated } = truncateContent(message.content);
    return sql`INSERT INTO agent_message_content
        (message_id, session_id, user_email, role, content_text, content_truncated, created_at)
        VALUES (${messageId}, ${params.sessionId}, ${params.userId},
                ${message.role}, ${value}, ${truncated}, NOW())`;
  });
}

function buildToolTelemetryWrites(
  sql: postgres.Sql,
  messageId: number,
  params: TelemetryParams,
  log: ReturnType<typeof createLogger>
): Promise<unknown>[] {
  const toolCalls = params.toolCalls ?? [];
  const cappedToolCalls = toolCalls.slice(0, MAX_TOOLS_PER_TURN);
  if (toolCalls.length > MAX_TOOLS_PER_TURN) {
    log.warn('Deep telemetry tool-call cap hit — truncating', {
      actual: toolCalls.length,
      cap: MAX_TOOLS_PER_TURN,
      sessionId: params.sessionId,
    });
  }
  return cappedToolCalls.map(toolCall =>
    sql`INSERT INTO agent_tool_invocations
        (message_id, session_id, user_email, tool_name, tool_args,
         tool_result, status, error_text, duration_ms, started_at, finished_at, created_at)
        VALUES (${messageId}, ${params.sessionId}, ${params.userId},
                ${toolCall.name},
                ${truncateJsonValue(toolCall.args)}::jsonb,
                ${truncateJsonValue(toolCall.result)}::jsonb,
                ${toolCall.status}, ${toolCall.error_text}, ${toolCall.duration_ms},
                ${toolCall.started_at}, ${toolCall.finished_at}, NOW())`
  );
}

async function writeDeepTelemetry(
  sql: postgres.Sql,
  messageId: number,
  params: TelemetryParams,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const writes = [
    ...buildMessageTelemetryWrites(sql, messageId, params, log),
    ...buildToolTelemetryWrites(sql, messageId, params, log),
  ];
  if (writes.length === 0) return;

  try {
    await Promise.all(writes);
  } catch (error) {
    log.error('Failed to write deep telemetry rows', {
      error: sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
      messageId,
      contentCount: params.messages?.length ?? 0,
      toolCount: params.toolCalls?.length ?? 0,
    });
  }
}

async function logTelemetry(
  params: TelemetryParams,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!DATABASE_HOST || !DATABASE_SECRET_ARN) {
    log.warn('Database not configured, skipping telemetry');
    return;
  }

  try {
    const sql = await getDbClient();
    const defaults = normalizeTelemetryParams(params);
    const messageId = await insertTelemetrySummary(sql, params, defaults);
    if (messageId) await writeDeepTelemetry(sql, messageId, params, log);
  } catch (error) {
    // Telemetry failure should not affect user experience
    log.error('Failed to write telemetry', {
      error: sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}

async function writeScheduledRun(params: ScheduledRunWrite): Promise<void> {
  if (!DATABASE_HOST || !DATABASE_SECRET_ARN) {
    throw new Error('Database not configured for scheduled run telemetry');
  }
  const sql = await getDbClient();
  const errorMessage = params.errorMessage
    ? sanitizeDiagnostic(params.errorMessage, 4000)
    : null;
  if (params.scheduledRunId) {
    const updated = await sql`UPDATE agent_scheduled_runs
      SET schedule_name = ${params.scheduleName ?? null},
          fire_key = COALESCE(fire_key, ${params.fireKey ?? null}),
          input_tokens = input_tokens + ${params.inputTokens},
          output_tokens = output_tokens + ${params.outputTokens},
          latency_ms = latency_ms + ${params.latencyMs},
          status = ${params.status},
          error_message = ${errorMessage}
      WHERE id = CAST(${params.scheduledRunId} AS bigint)
        AND user_id = ${params.userEmail}
        AND schedule_id = ${params.scheduleId}
        AND session_id = ${params.sessionId}
        AND status = 'promoted'
      RETURNING id`;
    if (updated.length !== 1) {
      throw new Error(
        `Promoted scheduled run ${params.scheduledRunId} was not updateable`,
      );
    }
    return;
  }
  await sql`INSERT INTO agent_scheduled_runs
      (user_id, schedule_id, schedule_name, session_id,
       input_tokens, output_tokens, latency_ms, status, error_message, fire_key)
    VALUES (${params.userEmail}, ${params.scheduleId},
            ${params.scheduleName ?? null}, ${params.sessionId},
            ${params.inputTokens}, ${params.outputTokens},
            ${params.latencyMs}, ${params.status},
            ${errorMessage}, ${params.fireKey ?? null})`;
}

// ---------------------------------------------------------------------------
// Failure capture (agent_failures)
// ---------------------------------------------------------------------------

/**
 * Persist a failure row in agent_failures. Never throws — failure-of-the-failure-writer
 * must not affect the user-facing flow. Logs to CloudWatch on insert error so the
 * original failure remains discoverable there.
 */
async function recordFailure(
  params: FailureRecordParams,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const logContext = {
    source: params.source,
    severity: params.severity,
    userId: params.userId ? sanitizeEmailForLog(params.userId) : null,
    sessionId: params.sessionId ?? null,
    errorClass: params.errorClass ?? null,
  };
  if (params.alert === false) {
    // Persist recovered policy outcomes for diagnostics without ticking the
    // AGENT_FAILURE_RECORD metric filter and production failure pager.
    log.warn('AGENT_DIAGNOSTIC_RECORD', logContext);
  } else {
    // Emit a structured CloudWatch line first so the metric filter ticks even
    // when the DB write fails. Keep AGENT_FAILURE_RECORD stable.
    log.error('AGENT_FAILURE_RECORD', logContext);
  }
  if (!DATABASE_HOST || !DATABASE_SECRET_ARN) {
    log.warn('Database not configured, skipping failure record');
    return;
  }
  try {
    const sql = await getDbClient();
    const truncate = (s: string | null | undefined, max: number) =>
      typeof s === 'string' ? s.slice(0, max) : null;
    const ctx = params.context ? JSON.stringify(params.context) : null;
    await sql`INSERT INTO agent_failures
        (source, severity, user_id, session_id, schedule_name, model,
         error_class, error_message, stack_excerpt, context, occurred_at)
        VALUES (${params.source}, ${params.severity},
                ${params.userId ?? null}, ${params.sessionId ?? null},
                ${params.scheduleName ?? null}, ${params.model ?? null},
                ${truncate(params.errorClass, 128)},
                ${truncate(params.errorMessage, 4000)},
                ${truncate(params.stackExcerpt, 4000)},
                ${ctx}::jsonb, NOW())`;
  } catch (error) {
    log.error('Failed to record agent failure', {
      error: sanitizeDiagnostic(
        error instanceof Error ? error.message : String(error),
      ),
      originalSource: params.source,
      originalSeverity: params.severity,
    });
  }
}

/**
 * Observe a failed agent turn without changing the user-facing behavior (the
 * error text is still delivered to Chat by the caller). Fixes the gap where a
 * 0-token error turn — e.g. an OpenClaw session-init conflict — was logged as a
 * clean "Message processed" success and left no alertable signal.
 *
 * Harness-origin failures (errorSource === 'harness') are already persisted in
 * agent_failures by the container, so we only log them here to avoid a
 * double-counted row. Router-origin failures (invocation errors) are persisted
 * here since nothing else recorded them. Returns whether the turn was failed so
 * the caller can suppress its success log.
 */
async function flagFailedTurn(
  agentResult: {
    failed?: boolean;
    errorClass?: string;
    errorSource?: 'harness' | 'router';
    response: string;
    model: string | null;
  },
  ctx: { userId: string; sessionId: string; latencyMs: number },
  log: ReturnType<typeof createLogger>,
): Promise<boolean> {
  if (!agentResult.failed) return false;
  log.warn('Agent returned an error turn', {
    // Stable marker for the ErrorTurnRate metric filter (#1161). The errorClass
    // field carries EmptyAgentResponse for empty-final turns, which the
    // dedicated EmptyAgentResponse filter matches on the same line.
    marker: 'AGENT_ERROR_TURN',
    errorClass: agentResult.errorClass ?? 'unknown',
    errorSource: agentResult.errorSource ?? 'unknown',
    latencyMs: ctx.latencyMs,
  });
  if (agentResult.errorSource === 'router') {
    await recordFailure(
      {
        source: 'router',
        severity: 'error',
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        model: agentResult.model,
        errorClass: agentResult.errorClass ?? 'AgentCoreError',
        errorMessage: agentResult.response,
        context: { phase: 'agentcore_invoke' },
      },
      log,
    );
  }
  return true;
}

function classifyError(err: unknown): { errorClass: string; message: string; stack: string | null } {
  if (err instanceof Error) {
    return {
      errorClass: err.name || 'Error',
      message: err.message,
      stack: err.stack ? err.stack.split('\n').slice(0, 20).join('\n') : null,
    };
  }
  return { errorClass: 'NonError', message: String(err), stack: null };
}

// ---------------------------------------------------------------------------
// Organizational Nervous System — signal store
// ---------------------------------------------------------------------------

/**
 * Record a topic signal in DynamoDB for the Pattern Scanner to analyze.
 *
 * Privacy contract (CRITICAL — see issue #890):
 *   - Writes ONLY: {building, weekTopic, topic, week, count, expiresAt}
 *   - Writes NEVER: user id, email, workspace prefix, message content, model
 *   - Count is increment-only via ADD; no upsert of user-derived fields.
 *
 * The building column uses `department` from the users table as the rollup
 * unit. For K-12 PSD the taxonomy is "building" (physical school); we store
 * whatever aggregation unit is currently populated. When department is
 * missing/unknown we skip the write entirely — a null aggregation key would
 * degenerate into a global bucket that proxies individuals in low-traffic
 * weeks.
 */
async function recordSignal(
  params: {
    building: string;
    topic: Topic;
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!SIGNALS_TABLE) {
    // Not configured — no-op. The admin dashboard will show an empty
    // Patterns tab until the stack is deployed with SIGNALS_TABLE set.
    return;
  }
  if (!params.building || params.building === 'unknown') {
    // Skip rollup when the user's department isn't populated yet.
    return;
  }

  const week = isoWeek();
  const weekTopic = `${week}#${params.topic}`;
  const expiresAt = Math.floor(Date.now() / 1000) + SIGNAL_TTL_DAYS * 86400;

  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: {
          building: params.building,
          weekTopic,
        },
        UpdateExpression:
          'ADD #count :one SET #topic = if_not_exists(#topic, :topic), #week = if_not_exists(#week, :week), #exp = :exp',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#topic': 'topic',
          '#week': 'week',
          '#exp': 'expiresAt',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':topic': params.topic,
          ':week': week,
          ':exp': expiresAt,
        },
      })
    );
  } catch (error) {
    // Signal failure must not affect the user's message — this is pure
    // observability. Log and continue.
    log.error('Failed to record signal', {
      error: error instanceof Error ? error.message : String(error),
      topic: params.topic,
      building: params.building,
    });
  }
}

// ---------------------------------------------------------------------------
// Inter-agent communication
// ---------------------------------------------------------------------------

/**
 * Check if an inter-agent message is rate-limited.
 * Counts messages from a sender bot in the last hour using DynamoDB.
 * Returns true if the rate limit is exceeded.
 */
async function isInterAgentRateLimited(
  senderBotId: string,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  if (!INTERAGENT_TABLE) {
    log.warn('Inter-agent table not configured, allowing message');
    return false;
  }

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { Count: count } = await dynamoClient.send(
      new QueryCommand({
        TableName: INTERAGENT_TABLE,
        KeyConditionExpression: 'senderBotId = :sender AND sentAt > :since',
        ExpressionAttributeValues: {
          ':sender': senderBotId,
          ':since': oneHourAgo,
        },
        Select: 'COUNT',
      })
    );

    const messageCount = count || 0;
    // With write-before-read ordering, the current message is already counted.
    // Use > (not >=) to maintain the same effective limit: N messages allowed,
    // the (N+1)th is blocked.
    if (messageCount > MAX_INTERAGENT_MESSAGES_PER_HOUR) {
      log.warn('Inter-agent rate limit exceeded', {
        senderBotId,
        messageCount,
        limit: MAX_INTERAGENT_MESSAGES_PER_HOUR,
      });
      return true;
    }

    return false;
  } catch (error) {
    // Fail-open: if the check fails we prefer a delivered message over a
    // dropped one. A CloudWatch alarm on this error should trigger ops review.
    log.error('Inter-agent rate check failed; allowing message', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Record an inter-agent message for rate limiting and anti-loop tracking.
 * TTL of 2 hours for automatic cleanup.
 */
async function recordInterAgentMessage(
  senderBotId: string,
  targetBotId: string,
  spaceName: string,
  threadName: string | undefined,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!INTERAGENT_TABLE) return;

  const expiresAt = Math.floor(Date.now() / 1000) + 7200; // 2 hour TTL
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: INTERAGENT_TABLE,
        Item: {
          senderBotId,
          sentAt: new Date().toISOString(),
          targetBotId,
          spaceName,
          // Thread key is already normalized at the call site (real thread name
          // or space-stable `unthreaded-<spaceName>` for top-level messages) so
          // record and anti-loop query agree on the same correlation key.
          threadName: threadName || 'unknown',
          expiresAt,
        },
      })
    );
  } catch (error) {
    log.error('Failed to record inter-agent message', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Anti-loop detection: check if a bot has already sent too many messages
 * in this thread within the last hour. With write-before-read ordering,
 * the current message is already recorded, so the threshold is 3 (allows
 * 2 actual exchanges before blocking the 3rd).
 *
 * This prevents the "ant death spiral" observed at Every.to where agents
 * enter infinite conversation loops.
 *
 * Design: We query by the sender's partition key + thread filter. This
 * works without a GSI because we're checking "has THIS bot talked too
 * much in this thread" rather than tracking specific bot pairs. In a
 * two-bot loop, each bot independently hits the threshold.
 */
async function isAntiLoopTriggered(
  senderBotId: string,
  threadName: string | undefined,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  if (!INTERAGENT_TABLE || !threadName) return false;

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Count messages from this sender in the same thread in the last hour.
    // If the sender already has 2+ messages, a loop is likely forming.
    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: INTERAGENT_TABLE,
        KeyConditionExpression: 'senderBotId = :sender AND sentAt > :since',
        FilterExpression: 'threadName = :thread',
        ExpressionAttributeValues: {
          ':sender': senderBotId,
          ':since': oneHourAgo,
          ':thread': threadName,
        },
        Select: 'COUNT',
      })
    );

    const senderMessageCount = result.Count || 0;

    // Anti-loop: if this bot has sent 3+ messages in this thread (including
    // the one just recorded via write-before-read), block further exchanges.
    // The threshold of 3 allows 2 actual exchanges before blocking the 3rd.
    if (senderMessageCount >= 3) {
      log.warn('Anti-loop triggered — blocking agent-to-agent conversation', {
        senderBotId,
        threadName,
        senderMessageCount,
      });
      return true;
    }

    return false;
  } catch (error) {
    // Fail-open: if the check fails we prefer a delivered message over a
    // dropped one. A CloudWatch alarm on this error should trigger ops review.
    log.error('Anti-loop check failed; allowing message', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(
  event: SQSEvent,
  _context: LambdaContext
): Promise<SQSBatchResponse> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, environment: ENVIRONMENT });

  log.info('Router invoked', { recordCount: event.Records.length });

  // Process records concurrently with partial failure reporting.
  // Uses reportBatchItemFailures so only failed records are retried —
  // prevents duplicate Google Chat messages for records that already succeeded.
  // Safe at any batchSize (currently 1 in CDK, but this handles increases).
  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record, log))
  );

  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    results.map(async (result, idx) => {
      if (result.status === 'rejected') {
        const messageId = event.Records[idx].messageId;
        if (result.reason instanceof ChatDeliveryRetryError) {
          batchItemFailures.push({ itemIdentifier: messageId });
          try {
            await deferChatDeliveryRetry(event.Records[idx], log);
          } catch (error) {
            log.error(
              'Failed to shorten visibility for Chat delivery retry',
              {
                messageId,
                error: error instanceof Error
                  ? error.message
                  : String(error),
              }
            );
          }
          return;
        }
        if (result.reason instanceof WorkspaceTurnDeferredError) {
          if (
            await workspaceDeferredRecordNeedsRetry(
              event.Records[idx],
              result.reason,
              log
            )
          ) {
            batchItemFailures.push({ itemIdentifier: messageId });
          }
          return;
        }
        batchItemFailures.push({ itemIdentifier: messageId });
        const classified = classifyError(result.reason);
        log.error('Record processing failed', {
          messageId,
          error: classified.message,
        });
        await recordFailure(
          {
            source: 'router',
            severity: 'error',
            errorClass: classified.errorClass,
            errorMessage: classified.message,
            stackExcerpt: classified.stack,
            context: { messageId, requestId, attempt: event.Records[idx].attributes?.ApproximateReceiveCount ?? "0" },
          },
          log
        );
      }
    })
  );

  return { batchItemFailures };
}

async function workspaceDeferredRecordNeedsRetry(
  record: SQSRecord,
  error: WorkspaceTurnDeferredError,
  log: ReturnType<typeof createLogger>,
  defer: typeof deferWorkspaceTurn = deferWorkspaceTurn
): Promise<boolean> {
  try {
    // A confirmed SendMessage transfers ownership to a fresh delayed record,
    // so this source record must be acknowledged. Every uncertain transfer
    // leaves the source failed and lets SQS redrive it normally.
    return !(await defer(record, error, log));
  } catch (enqueueError) {
    log.error('Failed to requeue deferred workspace turn', {
      messageId: record.messageId,
      error: enqueueError instanceof Error
        ? enqueueError.message
        : String(enqueueError),
    });
    return true;
  }
}

async function parseChatEventRecord(
  record: SQSRecord,
  log: ReturnType<typeof createLogger>
): Promise<GoogleChatEvent> {
  try {
    const sqsBody = JSON.parse(record.body) as {
      message?: { data?: unknown };
      Message?: unknown;
    };
    const pubsubData =
      sqsBody.message?.data || sqsBody.Message || sqsBody;
    const decoded =
      typeof pubsubData === 'string'
        ? Buffer.from(pubsubData, 'base64').toString('utf-8')
        : JSON.stringify(pubsubData);
    return normalizeChatEvent(
      JSON.parse(decoded) as Record<string, unknown>
    );
  } catch (error) {
    log.error('Failed to parse chat event', {
      error: error instanceof Error ? error.message : String(error),
      body: record.body.substring(0, 500),
    });
    throw error;
  }
}

function cardClickMessageText(
  action: NonNullable<GoogleChatEvent['action']>
): { intent: string; text: string; paramCount: number } {
  const parameters = action.parameters ?? [];
  const intent =
    parameters.find(parameter => parameter.key === 'intent')?.value ??
    action.actionMethodName ??
    'unspecified';
  const otherParameters = parameters
    .filter(parameter => parameter.key !== 'intent')
    .map(parameter => `${parameter.key}=${parameter.value}`)
    .join(' ');
  return {
    intent,
    text: otherParameters
      ? `[button] intent=${intent} ${otherParameters}`
      : `[button] intent=${intent}`,
    paramCount: parameters.length,
  };
}

function convertCardClickToMessage(
  chatEvent: GoogleChatEvent,
  log: ReturnType<typeof createLogger>
): GoogleChatEvent {
  if (chatEvent.type !== 'CARD_CLICKED') return chatEvent;

  const { intent, text, paramCount } = cardClickMessageText(
    chatEvent.action ?? {}
  );
  log.info('CARD_CLICKED — synthesising user message', {
    intent,
    paramCount,
    space: chatEvent.space?.name,
  });
  const sender =
    chatEvent.user ??
    chatEvent.message?.sender ?? {
      name: '',
      displayName: '',
      email: '',
      type: 'HUMAN' as const,
    };
  return {
    ...chatEvent,
    type: 'MESSAGE',
    message: {
      name: chatEvent.message?.name ?? '',
      text,
      argumentText: text,
      sender,
      thread: chatEvent.message?.thread,
      createTime: chatEvent.eventTime,
    },
  };
}

async function handleNonMessageEvent(
  chatEvent: GoogleChatEvent,
  log: ReturnType<typeof createLogger>,
  sendResponse: typeof sendGoogleChatResponse = sendGoogleChatResponse
): Promise<boolean> {
  if (chatEvent.type === 'MESSAGE') return false;

  log.info('Ignoring non-message event', { type: chatEvent.type });
  if (chatEvent.type !== 'ADDED_TO_SPACE') return true;

  const addedByEmail = chatEvent.message?.sender?.email;
  const addedByDomain = addedByEmail?.split('@')[1]?.toLowerCase();
  if (addedByDomain && ALLOWED_DOMAINS.includes(addedByDomain)) {
    const isSharedSpace = isSharedChatSpaceType(chatEvent.space.type);
    await sendResponse(
      chatEvent.space.name,
      undefined,
      "Hello! I'm your PSD AI Agent. Send me a message to get started.",
      log,
      {
        isSharedSpace,
        userId: addedByEmail,
      }
    );
  } else {
    log.warn('ADDED_TO_SPACE from unverified domain, skipping welcome message', {
      space: chatEvent.space.name,
      domain: addedByDomain || 'unknown',
    });
  }
  return true;
}

interface IncomingMessage {
  chatEvent: GoogleChatEvent;
  message: NonNullable<GoogleChatEvent['message']>;
  rawText: string;
  attachments: AgentAttachment[];
  isSharedSpace: boolean;
}

function isSharedChatSpaceType(
  spaceType: GoogleChatEvent['space']['type']
): boolean {
  // Treat unknown future/non-DM types as shared. This keeps privacy and
  // delivery behavior fail-safe and matches the promoted-job `!isDM`
  // classification.
  return spaceType !== 'DM';
}

function extractIncomingMessage(
  chatEvent: GoogleChatEvent,
  log: ReturnType<typeof createLogger>
): IncomingMessage | null {
  const message = chatEvent.message;
  if (!message?.sender) {
    log.warn('Message event missing required fields');
    return null;
  }

  const rawText = (message.argumentText ?? message.text ?? '').trim();
  const attachments = extractAttachments(message);
  const slashCommandId = message.slashCommand?.commandId;
  const hasRecognizedSlashCommand = isSlashCommandAvailable(
    slashCommandId,
    chatEvent.space.type
  );
  if (slashCommandId && !hasRecognizedSlashCommand) {
    logUnavailableSlashCommand(
      slashCommandId,
      chatEvent.space.type,
      log
    );
    return null;
  }
  const hasProcessableContent =
    Boolean(rawText) ||
    hasRecognizedSlashCommand ||
    attachments.length > 0;
  if (!hasProcessableContent) {
    log.warn('Message event missing required fields');
    return null;
  }
  return {
    chatEvent,
    message,
    rawText,
    attachments,
    isSharedSpace: isSharedChatSpaceType(chatEvent.space.type),
  };
}

async function handleBotMessage(
  incoming: IncomingMessage,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const { message, chatEvent, isSharedSpace } = incoming;
  if (message.sender.type !== 'BOT') return false;
  if (!isSharedSpace) return true;

  const senderBotId = message.sender.name;
  const spaceName = chatEvent.space.name;
  const threadName = message.thread?.name || `unthreaded-${spaceName}`;
  const startTime = Date.now();
  log.info('Inter-agent message detected', {
    senderBot: senderBotId,
    senderDisplayName: message.sender.displayName,
    space: spaceName,
    thread: threadName,
  });
  await recordInterAgentMessage(
    senderBotId,
    'broadcast',
    spaceName,
    threadName,
    log
  );

  if (await isInterAgentRateLimited(senderBotId, log)) {
    log.warn('Inter-agent message rate-limited', { senderBot: senderBotId });
    await sendGoogleChatResponse(
      spaceName,
      threadName,
      `⚠️ Rate limit reached: ${message.sender.displayName} has sent too many inter-agent messages this hour. Please wait before continuing this conversation.`,
      log
    );
    return true;
  }
  if (await isAntiLoopTriggered(senderBotId, threadName, log)) {
    await sendGoogleChatResponse(
      spaceName,
      threadName,
      `🔄 Anti-loop protection: This agent conversation in this thread has been paused ` +
        `(too many bot messages detected). A human can continue by replying in this thread — ` +
        `the counter resets after 1 hour.`,
      log
    );
    return true;
  }

  await logTelemetry(
    {
      userId: `bot:${senderBotId}`,
      sessionId: `interagent-${spaceName}-${threadName || 'none'}`,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      guardrailBlocked: false,
      spaceName,
    },
    log
  );
  log.info('Inter-agent message logged', {
    senderBot: senderBotId,
    space: spaceName,
  });
  return true;
}

interface HumanMessage {
  chatEvent: GoogleChatEvent;
  message: NonNullable<GoogleChatEvent['message']>;
  attachments: AgentAttachment[];
  isSharedSpace: boolean;
  senderName: string;
  senderEmail: string;
  senderDisplayName: string;
  messageText: string;
  spaceName: string;
  threadName?: string;
}

function createHumanMessage(incoming: IncomingMessage): HumanMessage {
  const { chatEvent, message, rawText, attachments, isSharedSpace } = incoming;
  return {
    chatEvent,
    message,
    attachments,
    isSharedSpace,
    senderName: message.sender.name,
    senderEmail: message.sender.email,
    senderDisplayName: message.sender.displayName,
    messageText:
      rawText ||
      (attachments.length > 0
        ? '(The user attached a file with no accompanying message.)'
        : rawText),
    spaceName: chatEvent.space.name,
    threadName: message.thread?.name,
  };
}

function humanChatDeliveryContext(
  human: HumanMessage,
  sessionId?: string,
  durableDelivery = false
): ChatResponseDeliveryContext {
  return {
    isSharedSpace: human.isSharedSpace,
    durableDelivery,
    userId: human.senderEmail,
    ...(sessionId ? { sessionId } : {}),
  };
}

function buildAgentInvocationContext(
  human: HumanMessage,
  owner: Pick<AgentUser, 'displayName' | 'workspacePrefix'>,
  invokedBy?: { email: string; displayName: string },
  conversationSessionId?: string
): AgentInvocationContext {
  return {
    displayName: invokedBy ? owner.displayName : human.senderDisplayName,
    workspacePrefix: owner.workspacePrefix,
    ...(conversationSessionId ? { conversationSessionId } : {}),
    ...(invokedBy ? { invokedBy, threadContext: '' } : {}),
    ...(human.isSharedSpace
      ? { audience: 'shared-space' }
      : {}),
    ...(human.attachments.length > 0
      ? { attachments: human.attachments }
      : {}),
  };
}

async function admitHumanMessage(
  human: HumanMessage,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  if (
    human.message.name &&
    (await isDuplicateMessage(human.message.name, log))
  ) {
    log.info('Duplicate Chat message — skipping', {
      messageName: human.message.name,
    });
    return false;
  }

  const emailDomain = human.senderEmail.split('@')[1]?.toLowerCase();
  if (!emailDomain || !ALLOWED_DOMAINS.includes(emailDomain)) {
    log.warn('Sender email not in allowed domains', {
      sender: human.senderName,
      domain: emailDomain,
      allowedDomains: ALLOWED_DOMAINS,
    });
    return false;
  }
  log.info('Processing message', {
    sender: human.senderName,
    space: human.spaceName,
    textLength: human.messageText.length,
    attachmentCount: human.attachments.length,
    attachmentSources: human.attachments.map(attachment => attachment.source),
  });

  if (human.messageText.length <= MAX_MESSAGE_LENGTH) return true;
  log.warn('Message exceeds maximum length', {
    length: human.messageText.length,
    limit: MAX_MESSAGE_LENGTH,
  });
  await sendGoogleChatResponse(
    human.spaceName,
    human.threadName,
    `Your message is too long (${human.messageText.length.toLocaleString()} characters). ` +
      `Please keep messages under ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`,
    log,
    humanChatDeliveryContext(human)
  );
  return false;
}

interface PreparedHumanTurn {
  user: AgentUser;
  guardrailResult: Awaited<ReturnType<typeof applyGuardrails>>;
  topic: Topic | null;
}

async function prepareHumanTurn(
  human: HumanMessage,
  log: ReturnType<typeof createLogger>
): Promise<PreparedHumanTurn> {
  const user = await getOrCreateUser(
    human.senderName,
    human.senderEmail,
    human.senderDisplayName,
    log
  );
  void maybeProvisionAgentAccount(user, human.senderEmail, log);
  const guardrailResult = await applyGuardrails(human.messageText, log);
  const topic = isPrivateMessage(human.messageText)
    ? null
    : classifyTopic(human.messageText);
  if (topic) {
    void recordSignal({ building: user.department, topic }, log);
  }
  return { user, guardrailResult, topic };
}

function agentResultTelemetry(
  result: AgentCoreResult
): Pick<
  TelemetryParams,
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'modelCallCount'
  | 'durationMs'
  | 'nudged'
  | 'messages'
  | 'toolCalls'
> {
  return {
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    cacheWriteInputTokens: result.cacheWriteInputTokens,
    modelCallCount: result.modelCallCount,
    durationMs: result.durationMs,
    nudged: result.nudged,
    messages: result.messages,
    toolCalls: result.toolCalls,
  };
}

function totalAgentTokens(result: AgentCoreResult): number {
  return (
    result.inputTokens +
    result.outputTokens +
    result.cacheReadInputTokens +
    result.cacheWriteInputTokens
  );
}

function findCrossUserInvocation(
  human: HumanMessage
): CrossUserInvocation | null {
  const slashInvocation = parseSlashCommandInvocation(human.message);
  if (slashInvocation) return slashInvocation;
  return human.isSharedSpace
    ? parseCrossUserInvocation(human.messageText)
    : null;
}

function crossUserUsageHelp(invocation: CrossUserInvocation): string {
  const commandLabel = invocation.commandName ?? '/ask';
  return invocation.source === 'slash-command'
    ? `Usage: \`${commandLabel} <username> <question>\`\n\nExample: \`${commandLabel} reese what's on the calendar for today?\``
    : 'Usage: `@agent:<username> <question>`\n\nExample: `@agent:reese what\'s on the calendar for today?`';
}

function emptyCrossUserQuestionHelp(
  invocation: CrossUserInvocation
): string {
  const commandLabel = invocation.commandName ?? '/ask';
  return invocation.source === 'slash-command'
    ? `Please include a question. Example: \`${commandLabel} ${invocation.targetUsername} what's the budget status?\``
    : `Please include a question after @agent:${invocation.targetUsername}. ` +
        `Example: @agent:${invocation.targetUsername} what's the budget status?`;
}

function scopedAgentSessionId(
  user: Pick<AgentUser, 'workspacePrefix'>,
  kind: 'runtime' | 'chat' | 'chat-aside',
  scope: string
): string {
  const scopeHash = crypto
    .createHash('sha256')
    .update(`${user.workspacePrefix}\0${scope}`)
    .digest('hex');
  // AgentCore runtime session ids are capped at 100 characters. Use the
  // compact "rt" discriminator for runtime affinity; the prior
  // "agent-runtime" prefix produced a 103-character id after the build hash
  // was appended and was rejected before the request reached the container.
  const base = `agent-${kind === 'runtime' ? 'rt' : kind}-${scopeHash}`;
  // Runtime affinity must rotate on every deployed image/config revision so
  // AgentCore cannot sticky-route to an obsolete microVM. Conversation keys
  // intentionally do not: their SQLite-backed transcripts must survive that
  // runtime rotation and VM shutdown.
  if (kind !== 'runtime') return base;
  const buildTag = process.env.AGENT_BUILD_TAG || 'unset';
  const buildHash = crypto
    .createHash('sha256')
    .update(buildTag)
    .digest('hex')
    .slice(0, 24);
  return `${base}-${buildHash}`;
}

/**
 * One sticky AgentCore runtime and one DynamoDB lock per owner workspace.
 *
 * Do not add Chat space/thread identity here. Multiple warm microVMs for the
 * same S3 workspace retain stale local SQLite state and can overwrite each
 * other's later checkpoints even when their individual turns do not overlap.
 */
function ownerSessionId(
  _human: HumanMessage,
  user: Pick<AgentUser, 'workspacePrefix'>
): string {
  return scopedAgentSessionId(
    user,
    'runtime',
    `workspace:${user.workspacePrefix}`
  );
}

/**
 * Logical OpenClaw conversation identity for a Google Chat thread.
 *
 * The owner prefix isolates agents, the space isolates DMs/rooms, and the
 * Google thread name isolates parallel conversations within either surface.
 * A stable sentinel preserves continuity for legacy events without a thread.
 */
function ownerConversationSessionId(
  human: HumanMessage,
  user: Pick<AgentUser, 'workspacePrefix'>
): string {
  return scopedAgentSessionId(
    user,
    'chat',
    `space:${human.spaceName}\nthread:${human.threadName ?? '__unthreaded__'}`
  );
}

/**
 * Deployment-stable mutex for every process that can mutate an owner's
 * durable workspace. Cron intentionally duplicates this exact derivation
 * because its independently bundled Lambda cannot import router code.
 */
function ownerWorkspaceLockId(
  user: Pick<AgentUser, 'workspacePrefix'>
): string {
  const workspaceHash = crypto
    .createHash('sha256')
    .update(`owner-workspace-lock\0${user.workspacePrefix}`)
    .digest('hex');
  return `agent-workspace-${workspaceHash}`;
}

function crossUserSessionId(
  human: HumanMessage,
  targetUser: AgentUser
): string {
  return ownerConversationSessionId(human, targetUser);
}

async function invokeCrossUserAgent(
  human: HumanMessage,
  invocation: CrossUserInvocation,
  targetUser: AgentUser,
  log: ReturnType<typeof createLogger>
): Promise<{ result: AgentCoreResult; sessionId: string } | null> {
  const sessionId = ownerSessionId(human, targetUser);
  const conversationSessionId = crossUserSessionId(human, targetUser);
  const workspaceLockId = ownerWorkspaceLockId(targetUser);
  const lockToken = await tryAcquireSessionLock(workspaceLockId, log);
  if (!lockToken) {
    throw new WorkspaceTurnDeferredError(
      human.message.name,
      'workspace-contended'
    );
  }
  const result = await invokeWithSessionLockLease(
    workspaceLockId,
    lockToken,
    log,
    async () => {
      await fetchChatUploads(
        human.attachments,
        targetUser.workspacePrefix,
        log,
        human.message.name,
        human.message.createTime
      );
      return invokeAgentCore(
        invocation.strippedMessage,
        targetUser.email,
        sessionId,
        log,
        buildAgentInvocationContext(
          human,
          targetUser,
          {
            email: human.senderEmail,
            displayName: human.senderDisplayName,
          },
          conversationSessionId
        )
      );
    }
  );
  return { result, sessionId: conversationSessionId };
}

function buildCrossUserResponse(
  invocation: CrossUserInvocation,
  targetUser: AgentUser,
  result: AgentCoreResult,
  log: ReturnType<typeof createLogger>
): string {
  const deprecationNotice =
    invocation.source === 'text-prefix'
      ? `\n\n_Tip: \`/ask ${invocation.targetUsername} ...\` works too (and is faster)_`
      : '';
  const maxLength = 4096;
  const truncationSuffix =
    '\n\n_(Response truncated -- ask me to continue)_';
  const ownerLabel = targetUser.displayName || targetUser.email;
  const prefix = `[${ownerLabel}'s Agent] `;
  const reservedLength = prefix.length + deprecationNotice.length;
  const availableLength = Math.max(maxLength - reservedLength, 0);
  if (availableLength === 0) {
    log.warn(
      'Cross-user response body fully truncated due to long prefix/notice',
      { reservedLength, maxLength, ownerLabel }
    );
  }
  const response =
    result.response.length > availableLength
      ? result.response.substring(
          0,
          Math.max(availableLength - truncationSuffix.length, 0)
        ) + truncationSuffix
      : result.response;
  return `${prefix}${response}${deprecationNotice}`;
}

interface CrossUserTurnContext {
  human: HumanMessage,
  invocation: CrossUserInvocation,
  targetUser: AgentUser,
  topic: Topic | null,
  startTime: number;
}

async function recordCrossUserResult(
  context: CrossUserTurnContext & {
    result: AgentCoreResult;
    sessionId: string;
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const {
    human,
    invocation,
    targetUser,
    result,
    sessionId,
    topic,
    startTime,
  } = context;
  const latencyMs =
    result.latencyMs > 0 ? result.latencyMs : Date.now() - startTime;
  await logTelemetry(
    {
      userId: human.senderEmail,
      sessionId,
      ...agentResultTelemetry(result),
      latencyMs,
      guardrailBlocked: false,
      spaceName: human.spaceName,
      invokedBy: human.senderEmail,
      agentOwnerId: targetUser.email,
      topic,
    },
    log
  );
  const failed = await flagFailedTurn(
    result,
    { userId: human.senderEmail, sessionId, latencyMs },
    log
  );
  if (!failed) {
    log.info('Cross-user invocation processed', {
      invoker: human.senderEmail,
      agentOwner: targetUser.email,
      model: result.model,
      source: invocation.source,
      latencyMs,
    });
  }
}

async function runCrossUserTurn(
  context: CrossUserTurnContext,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const { human, invocation, targetUser } = context;
  if (!invocation.strippedMessage) {
    await sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      emptyCrossUserQuestionHelp(invocation),
      log,
      humanChatDeliveryContext(human)
    );
    return;
  }
  await applyGuardrails(invocation.strippedMessage, log);
  const turn = await invokeCrossUserAgent(human, invocation, targetUser, log);
  if (!turn) return;

  const totalTokens = totalAgentTokens(turn.result);
  if (totalTokens > TOKEN_LIMIT) {
    log.warn('Token usage exceeds alerting threshold (cross-user)', {
      invoker: human.senderEmail,
      agentOwner: targetUser.email,
      totalTokens,
      threshold: TOKEN_LIMIT,
    });
  }
  await sendGoogleChatResponse(
    human.spaceName,
    human.threadName,
    buildCrossUserResponse(invocation, targetUser, turn.result, log),
    log,
    humanChatDeliveryContext(human, turn.sessionId, true)
  );
  await recordCrossUserResult(
    {
      ...context,
      result: turn.result,
      sessionId: turn.sessionId,
    },
    log
  );
}

interface CrossUserRouteResult {
  handled: boolean;
  messageText: string;
}

async function handleCrossUserInvocation(
  human: HumanMessage,
  topic: Topic | null,
  startTime: number,
  log: ReturnType<typeof createLogger>
): Promise<CrossUserRouteResult> {
  const invocation = findCrossUserInvocation(human);
  if (!invocation) return { handled: false, messageText: human.messageText };
  if (!invocation.targetUsername) {
    await sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      crossUserUsageHelp(invocation),
      log,
      humanChatDeliveryContext(human)
    );
    return { handled: true, messageText: human.messageText };
  }

  log.info('Cross-user invocation detected', {
    sender: human.senderEmail,
    targetUsername: invocation.targetUsername,
    source: invocation.source,
    space: human.spaceName,
  });
  const targetUser = await resolveUserByEmailPrefix(
    invocation.targetUsername,
    log
  );
  if (!targetUser) {
    await sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      'Agent not found. If you believe this is an error, contact your workspace admin.',
      log,
      humanChatDeliveryContext(human)
    );
    return { handled: true, messageText: human.messageText };
  }
  if (!canInvokeOwnerAgent(human.senderEmail, targetUser.email)) {
    log.warn('Cross-owner invocation denied: no explicit delegation', {
      actorEmail: human.senderEmail,
      ownerEmail: targetUser.email,
      source: invocation.source,
    });
    await sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      'Cross-user agent consultation is unavailable until the owner grants explicit access.',
      log,
      humanChatDeliveryContext(human)
    );
    return { handled: true, messageText: human.messageText };
  }

  const selfInvocation =
    targetUser.email.toLowerCase() === human.senderEmail.toLowerCase();
  if (selfInvocation && !invocation.strippedMessage) {
    const commandLabel = invocation.commandName ?? '/ask';
    const help =
      invocation.source === 'slash-command'
        ? `You can talk to your own agent by sending a message directly -- no need for \`${commandLabel}\`.`
        : 'Please include a message. You can talk to your agent normally without the @agent: prefix.';
    await sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      help,
      log,
      humanChatDeliveryContext(human)
    );
    return { handled: true, messageText: human.messageText };
  }
  if (selfInvocation) {
    log.info('Self-invocation detected, treating as normal message', {
      sender: human.senderEmail,
    });
    return { handled: false, messageText: invocation.strippedMessage };
  }

  await runCrossUserTurn(
    { human, invocation, targetUser, topic, startTime },
    log
  );
  return { handled: true, messageText: human.messageText };
}

function asideSessionId(human: HumanMessage, user: AgentUser): string {
  return scopedAgentSessionId(
    user,
    'chat-aside',
    `space:${human.spaceName}\nthread:${human.threadName ?? '__unthreaded__'}`
  );
}

interface OwnerAgentTurn {
  result: AgentCoreResult;
  /** Build-rotated AgentCore runtime affinity identity. */
  sessionId: string;
  /** Deployment-stable mutex shared with cron and promoted jobs. */
  workspaceLockId: string;
  /** OpenClaw transcript identity scoped to the originating Chat thread. */
  conversationSessionId: string;
  prompt: string;
  responsePrefix: string;
  isAside: boolean;
}

interface OwnerInvocationDependencies {
  fetchChatUploads: typeof fetchChatUploads;
  isJobLockActive: typeof isJobLockActive;
  tryAcquireSessionLock: typeof tryAcquireSessionLock;
  renewSessionLock: typeof renewSessionLock;
  releaseSessionLock: typeof releaseSessionLock;
  renewalScheduler: SessionLockRenewalScheduler;
  invokeAgentCore: typeof invokeAgentCore;
  sendGoogleChatResponse: typeof sendGoogleChatResponse;
}

const ownerInvocationDependencies: OwnerInvocationDependencies = {
  fetchChatUploads,
  isJobLockActive,
  tryAcquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
  renewalScheduler: sessionLockLeaseDependencies.scheduler,
  invokeAgentCore,
  sendGoogleChatResponse,
};

async function invokeOwnerAgentWithDependencies(
  human: HumanMessage,
  user: AgentUser,
  messageText: string,
  log: ReturnType<typeof createLogger>,
  dependencies: OwnerInvocationDependencies
): Promise<OwnerAgentTurn | null> {
  const mainSessionId = ownerSessionId(human, user);
  const mainConversationSessionId = ownerConversationSessionId(human, user);
  const workspaceLockId = ownerWorkspaceLockId(user);
  const ownerDm = human.chatEvent.space.type === 'DM' && !human.isSharedSpace;
  const asideInvocation = ownerDm
    ? parseAsideInvocation(human.message)
    : null;

  if (asideInvocation && !asideInvocation.messageText) {
    await dependencies.sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      'Usage: `/btw <question>`',
      log,
      humanChatDeliveryContext(human)
    );
    return null;
  }

  const sessionId = mainSessionId;
  let conversationSessionId = mainConversationSessionId;
  let prompt = messageText;
  let responsePrefix = '';
  let isAside = false;

  if (asideInvocation) {
    conversationSessionId = asideSessionId(human, user);
    prompt = asideInvocation.messageText;
    responsePrefix = ASIDE_RESPONSE_PREFIX;
    isAside = true;
    log.info('Explicit aside invocation detected', {
      source: asideInvocation.source,
      sessionId: conversationSessionId,
      workspaceSessionId: sessionId,
    });
  }

  if (await dependencies.isJobLockActive(workspaceLockId, log)) {
    throw new WorkspaceTurnDeferredError(
      human.message.name,
      'background-job-active'
    );
  }

  const lockToken = await dependencies.tryAcquireSessionLock(
    workspaceLockId,
    log
  );
  if (!lockToken) {
    throw new WorkspaceTurnDeferredError(
      human.message.name,
      'workspace-contended'
    );
  }
  const result = await invokeWithSessionLockLease(
    workspaceLockId,
    lockToken,
    log,
    async () => {
      await dependencies.fetchChatUploads(
        human.attachments,
        user.workspacePrefix,
        log,
        human.message.name,
        human.message.createTime
      );
      return dependencies.invokeAgentCore(
        prompt,
        human.senderEmail,
        sessionId,
        log,
        buildAgentInvocationContext(
          human,
          user,
          undefined,
          conversationSessionId
        )
      );
    },
    {
      renewSessionLock: dependencies.renewSessionLock,
      releaseSessionLock: dependencies.releaseSessionLock,
      scheduler: dependencies.renewalScheduler,
    }
  );
  return {
    result,
    sessionId,
    workspaceLockId,
    conversationSessionId,
    prompt,
    responsePrefix,
    isAside,
  };
}

async function invokeOwnerAgent(
  human: HumanMessage,
  user: AgentUser,
  messageText: string,
  log: ReturnType<typeof createLogger>
): Promise<OwnerAgentTurn | null> {
  return invokeOwnerAgentWithDependencies(
    human,
    user,
    messageText,
    log,
    ownerInvocationDependencies
  );
}

interface OwnerTurnContext {
  human: HumanMessage,
  prepared: PreparedHumanTurn,
  turn: OwnerAgentTurn,
  startTime: number;
}

function buildOwnerJobPromotionInput(
  human: HumanMessage,
  user: AgentUser,
  turn: OwnerAgentTurn,
  reason: PromotionReason
): JobPromotionInput {
  return {
    promotionId: human.message.name,
    reason,
    sessionId: turn.sessionId,
    workspaceLockId: turn.workspaceLockId,
    conversationSessionId: turn.conversationSessionId,
    userEmail: human.senderEmail,
    googleIdentity: human.senderName,
    displayName: human.senderDisplayName,
    workspacePrefix: user.workspacePrefix,
    spaceName: human.spaceName,
    threadName: human.threadName,
    isDM: human.chatEvent.space.type === 'DM',
    originalPrompt: turn.prompt,
    acknowledgementPrefix: turn.responsePrefix,
    responsePrefix: turn.isAside
      ? ASIDE_RESPONSE_PREFIX
      : turn.responsePrefix,
  };
}

async function promoteOwnerTurn(
  context: OwnerTurnContext,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const { human, prepared, turn, startTime } = context;
  const reason = promotionReason(turn.result.errorClass);
  if (!reason) return false;
  const promoted = await promoteToJob(
    buildOwnerJobPromotionInput(
      human,
      prepared.user,
      turn,
      reason
    ),
    log
  );
  if (!promoted) return false;

  const latencyMs =
    turn.result.latencyMs > 0
      ? turn.result.latencyMs
      : Date.now() - startTime;
  await logTelemetry(
    {
      userId: human.senderEmail,
      sessionId: turn.conversationSessionId,
      ...agentResultTelemetry(turn.result),
      latencyMs,
      guardrailBlocked: prepared.guardrailResult.wouldHaveBlocked,
      spaceName: human.spaceName,
      topic: prepared.topic,
    },
    log
  );
  return true;
}

function buildOwnerResponse(
  human: HumanMessage,
  result: AgentCoreResult,
  responsePrefix = ''
): string {
  const maxLength = 4096;
  const truncationSuffix =
    '\n\n_(Response truncated — ask me to continue)_';
  const prefix =
    responsePrefix ||
    (human.chatEvent.space.type === 'DM'
      ? ''
      : `[${human.senderDisplayName}'s Agent] `);
  const availableLength = maxLength - prefix.length;
  const response =
    result.response.length > availableLength
      ? result.response.substring(
          0,
          availableLength - truncationSuffix.length
        ) + truncationSuffix
      : result.response;
  return `${prefix}${response}`;
}

async function recordOwnerResult(
  human: HumanMessage,
  prepared: PreparedHumanTurn,
  turn: OwnerAgentTurn,
  startTime: number,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const latencyMs =
    turn.result.latencyMs > 0
      ? turn.result.latencyMs
      : Date.now() - startTime;
  await logTelemetry(
    {
      userId: human.senderEmail,
      sessionId: turn.conversationSessionId,
      ...agentResultTelemetry(turn.result),
      latencyMs,
      guardrailBlocked: prepared.guardrailResult.wouldHaveBlocked,
      spaceName: human.spaceName,
      topic: prepared.topic,
    },
    log
  );
  const failed = await flagFailedTurn(
    turn.result,
    {
      userId: human.senderEmail,
      sessionId: turn.conversationSessionId,
      latencyMs,
    },
    log
  );
  if (!failed) {
    log.info('Message processed', {
      sender: human.senderName,
      model: turn.result.model,
      latencyMs,
      inputTokens: turn.result.inputTokens,
      outputTokens: turn.result.outputTokens,
    });
  }
}

async function handleOwnerTurn(
  human: HumanMessage,
  prepared: PreparedHumanTurn,
  messageText: string,
  startTime: number,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const turn = await invokeOwnerAgent(
    human,
    prepared.user,
    messageText,
    log
  );
  if (!turn) return;

  const totalTokens = totalAgentTokens(turn.result);
  if (totalTokens > TOKEN_LIMIT) {
    log.warn('Token usage exceeds alerting threshold', {
      inputTokens: turn.result.inputTokens,
      outputTokens: turn.result.outputTokens,
      totalTokens,
      threshold: TOKEN_LIMIT,
    });
  }
  if (
    await promoteOwnerTurn(
      { human, prepared, turn, startTime },
      log
    )
  ) {
    return;
  }
  await sendGoogleChatResponse(
    human.spaceName,
    human.threadName,
    buildOwnerResponse(human, turn.result, turn.responsePrefix),
    log,
    humanChatDeliveryContext(
      human,
      turn.conversationSessionId,
      true
    )
  );
  await recordOwnerResult(human, prepared, turn, startTime, log);
}

async function processDeferredChatDelivery(
  delivery: DeferredChatDeliveryEnvelope,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    const outcome = await sendGoogleChatResponse(
      delivery.spaceName,
      delivery.threadName,
      delivery.text,
      log,
      delivery.deliveryContext
    );
    if (outcome === 'failed') {
      throw new Error('Google Chat delivery returned a failed outcome');
    }
  } catch (error) {
    throw new ChatDeliveryRetryError(
      sanitizeDiagnostic(errorMessage(error))
    );
  }
}

async function processRecord(
  record: SQSRecord,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const startTime = Date.now();
  const deferredDelivery = parseDeferredChatDeliveryRecord(record.body);
  if (deferredDelivery) {
    await processDeferredChatDelivery(deferredDelivery, log);
    return;
  }
  const parsedEvent = await parseChatEventRecord(record, log);
  const chatEvent = convertCardClickToMessage(parsedEvent, log);
  if (await handleNonMessageEvent(chatEvent, log)) return;
  const incoming = extractIncomingMessage(chatEvent, log);
  if (!incoming) return;
  if (await handleBotMessage(incoming, log)) return;
  const human = createHumanMessage(incoming);
  if (!(await admitHumanMessage(human, log))) return;
  const prepared = await prepareHumanTurn(human, log);
  const route = await handleCrossUserInvocation(
    human,
    prepared.topic,
    startTime,
    log
  );
  if (route.handled) return;
  await handleOwnerTurn(
    human,
    prepared,
    route.messageText,
    startTime,
    log
  );
}

export const agentRouterTestHelpers = {
  normalizeChatEvent,
  cardClickMessageText,
  parseAgentCoreResult,
  totalAgentTokens,
  tryAcquireSessionLock,
  invokeWithSessionLockLease,
  jobPromotionIdentity,
  promotedJobRunTaskCommand,
  runTaskFailureCertainty,
  promoteToJobWithDependencies,
  parseAsideInvocation,
  ownerSessionId,
  ownerConversationSessionId,
  ownerWorkspaceLockId,
  asideSessionId,
  invokeOwnerAgentWithDependencies,
  buildOwnerResponse,
  buildOwnerJobPromotionInput,
  handleNonMessageEvent,
  extractIncomingMessage,
  addOptionalAgentContext,
  invocationTtlOptions,
  buildAgentInvocationContext,
  sendGoogleChatResponseWithDependencies,
  deferWorkspaceTurn,
  workspaceDeferredRecordNeedsRetry,
  WorkspaceTurnDeferredError,
  isDuplicateMessage,
  parseDeferredChatDelivery,
  parseDeferredChatDeliveryRecord,
  btwSlashCommandId: BTW_SLASH_COMMAND_ID,
};

// ---------------------------------------------------------------------------
// Exports for the async job-runner entrypoint (job-main.ts, issue #1138).
// The runner is the same compiled package running as an ECS Fargate task —
// it reuses the router's AgentCore invocation, Chat delivery, telemetry,
// failure recording, and session-lock helpers outside Lambda.
// ---------------------------------------------------------------------------
export {
  createLogger,
  invokeAgentCore,
  sendGoogleChatResponse,
  logTelemetry,
  writeScheduledRun,
  recordFailure,
  tryAcquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
};
