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
  shouldPromoteToJob,
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
 *   /btw -> commandId "3" -> "Ask a concurrent question while your agent works"
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
const AUTO_ASIDE_RESPONSE_PREFIX =
  '[aside] _Your main task is still running._ ';
const OWNER_BUSY_RESPONSE =
  "I'm currently busy processing another request. Please try again in a moment.";

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

// Sentinel token for pass-through lock scenarios (lock table missing or DDB
// error). Used instead of a real UUID so `releaseSessionLock` can short-circuit
// without attempting a conditional DynamoDB delete that would fail by coincidence.
const LOCK_PASS_THROUGH = '__lock-pass-through__';

/**
 * Try to acquire the per-session lock. Returns the unique lock token on
 * success, `null` if another holder already has it, or `LOCK_PASS_THROUGH`
 * when locking is disabled or DynamoDB is unavailable (fail-open).
 *
 * Each acquisition writes a random `lockToken` into the DynamoDB row. The
 * token is required by `releaseSessionLock` so that a stale holder (whose
 * lock expired and was re-acquired by a different invocation) cannot
 * accidentally delete a newer holder's lock.
 *
 * Serialization is best-effort for turns longer than 14 min: the DynamoDB
 * TTL backstop expires at that point and a new holder can re-acquire the
 * lock while the first turn is still in-flight. The conditional-delete
 * token mechanism prevents the first holder from releasing the second
 * holder's lock, but the serialization guarantee itself is broken in
 * that 14–15 min window. This is acceptable given the tail probability.
 */
async function tryAcquireSessionLock(
  sessionId: string,
  log: ReturnType<typeof createLogger>,
  kind: 'turn' | 'job' = 'turn'
): Promise<string | null> {
  const tableName = process.env.SESSION_LOCKS_TABLE;
  if (!tableName) return LOCK_PASS_THROUGH; // Lock disabled (e.g. local) — pass through.

  const lockToken = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 14 * 60;
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: tableName,
        // `kind: 'job'` marks a lock held by the async job-runner (#1138) —
        // the router replies "still working on your earlier task" instantly
        // instead of making the user wait out the 13-min lock poll. The
        // runner renews expiresAt every ~10 min (renewSessionLock).
        Item: { sessionId, expiresAt, lockToken, kind, claimedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(sessionId) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
      })
    );
    return lockToken;
  } catch (error) {
    const errName = (error as { name?: string } | null)?.name;
    if (errName === 'ConditionalCheckFailedException') return null;
    log.warn('Session lock acquire failed; proceeding without lock', {
      error: error instanceof Error ? error.message : String(error),
    });
    return LOCK_PASS_THROUGH; // Conservative — let the message through if DDB is broken.
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
 * Renew a held session lock by extending expiresAt another 14 minutes,
 * conditioned on still owning it (lockToken match). The async job-runner
 * (#1138) calls this every ~10 min for up to the 2h job ceiling so the
 * `kind='job'` marker stays live while the job runs. Returns false when the
 * lock was lost (expired + re-acquired by someone else) — the runner keeps
 * going regardless (losing the lock affects messaging UX, not correctness;
 * OpenClaw serializes the session itself).
 */
async function renewSessionLock(
  sessionId: string,
  lockToken: string,
  log: ReturnType<typeof createLogger>
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
          ':exp': Math.floor(Date.now() / 1000) + 14 * 60,
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
    return true; // Transient DDB error — keep renewing.
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
 * Acquire-or-wait. Polls the lock with exponential backoff (1s -> 2s -> 4s,
 * capped at 8s) up to maxWaitMs. Returns the lock token on success, or `null`
 * if the wait times out. Caller MUST check the return value and only release
 * when non-null. Bounded to leave headroom under the 15-min Lambda timeout —
 * agent turns regularly take 1–4 min, so 13 min is the upper bound.
 */
async function waitForSessionLock(
  sessionId: string,
  log: ReturnType<typeof createLogger>,
  maxWaitMs = 13 * 60 * 1000,
): Promise<string | null> {
  const start = Date.now();
  let attempt = 0;
  let backoffMs = 1000;
  while (Date.now() - start < maxWaitMs) {
    const token = await tryAcquireSessionLock(sessionId, log);
    if (typeof token === "string") {
      if (attempt > 0) {
        log.info('Session lock acquired after wait', {
          waitedMs: Date.now() - start,
          attempts: attempt + 1,
        });
      }
      return token;
    }
    attempt += 1;
    await new Promise((r) => setTimeout(r, backoffMs));
    // Exponential backoff capped at 8s — reduces DDB read volume by ~75%
    // for long waits (1s -> 2s -> 4s -> 8s -> 8s…) with negligible impact
    // on response latency since agent turns take minutes.
    backoffMs = Math.min(backoffMs * 2, 8000);
  }
  log.warn('Session lock wait timed out — returning busy message', {
    waitedMs: Date.now() - start,
  });
  return null;
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
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const tableName = process.env.MESSAGE_DEDUP_TABLE;
  if (!tableName) {
    return false; // Dedup not configured (e.g., local tests) — pass through
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          messageName,
          expiresAt,
          claimedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(messageName)',
      })
    );
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
  invokedBy?: { email: string; displayName: string };
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
}

function failedAgentCoreResult(
  response: string,
  errorClass: string
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
  };
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
  return deadlineS === undefined ? {} : { ttlSeconds: deadlineS };
}

function addOptionalAgentContext(
  payload: Record<string, unknown>,
  context: AgentInvocationContext
): void {
  if (context.invokedBy) {
    payload.invoked_by_email = context.invokedBy.email;
    payload.invoked_by_display_name = context.invokedBy.displayName;
  }
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
      'AgentNotDeployed'
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
async function getChatClient(): Promise<NonNullable<typeof cachedChatClient>> {
  const credentialsJson = await getGoogleCredentials();
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(credentialsJson) as Record<string, unknown>;
  } catch {
    // Clear the cache so the next invocation fetches fresh credentials from
    // Secrets Manager in case the secret was recently updated/fixed.
    cachedGoogleCredentials = null;
    credentialsCachedAt = null;
    cachedChatClient = null;
    throw new Error('Google credentials secret contains invalid JSON');
  }

  if (!cachedChatClient) {
    const googleAuth = new chatPkg.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
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
  log: ReturnType<typeof createLogger>
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
      const workspacePath = buildWorkspacePath(att.name, index, new Date());
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
 * Returns true when the job launched (caller returns; nothing more to send).
 * Returns false on ANY failure — missing config, no runtime id, lock
 * contention, RunTask error — and the caller falls through to today's
 * behavior (post the failure frame). Promotion must never make things
 * worse than the status quo.
 */
interface JobPromotionInput {
  sessionId: string;
  userEmail: string;
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

async function runPromotedJob(
  config: JobPromotionConfig,
  payload: string
): Promise<string | undefined> {
  const result = await ecsClient.send(
    new RunTaskCommand({
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
    })
  );
  if (result.failures?.length) {
    const failureSummary = result.failures
      .map(failure =>
        `${failure.reason ?? 'unknown'}${
          failure.detail ? ` (${failure.detail})` : ''
        }`
      )
      .join('; ');
    throw new Error(`RunTask failures: ${failureSummary}`);
  }
  return result.tasks?.[0]?.taskArn;
}

async function promoteToJob(
  input: JobPromotionInput,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const config = getJobPromotionConfig();
  if (!config) {
    log.warn('Job promotion not configured — falling back to failure frame');
    return false;
  }

  const runtimeId = process.env.AGENTCORE_RUNTIME_ID || cachedRuntimeId || '';
  if (!runtimeId) {
    log.warn('Job promotion aborted — no resolved AgentCore runtime id');
    return false;
  }

  // Pre-acquire the job lock so there is no unlocked gap between promotion
  // and the runner's first renewal (~60s task cold start). If someone else
  // grabbed the session in the meantime, skip promotion.
  const jobLockToken = await tryAcquireSessionLock(input.sessionId, log, 'job');
  if (jobLockToken === null) {
    log.warn('Job promotion aborted — session lock contended');
    return false;
  }

  try {
    const payload = buildJobPayload({
      sessionId: input.sessionId,
      lockToken: jobLockToken,
      runtimeId,
      userEmail: input.userEmail,
      displayName: input.displayName,
      workspacePrefix: input.workspacePrefix,
      spaceName: input.spaceName,
      threadName: input.threadName,
      isDM: input.isDM,
      originalPrompt: input.originalPrompt,
      responsePrefix: input.responsePrefix,
    });

    const taskArn = await runPromotedJob(config, payload);

    await sendGoogleChatResponse(
      input.spaceName,
      input.threadName,
      (input.acknowledgementPrefix ?? input.responsePrefix ?? '') +
        '⏳ This is taking longer than one pass allows — I\'ve moved it to a ' +
        'background job and will post the result here when it\'s done.',
      log
    );

    log.info('Turn promoted to background job', {
      // Stable marker for the BackgroundPromotion metric filter (#1161). This
      // is a "platform compensating for model behavior" counter — its trend is
      // an input to Loop-2 instruction tuning, so it's a metric without an alarm.
      marker: 'BACKGROUND_PROMOTION',
      sessionId: input.sessionId,
      taskArn: taskArn ?? 'unknown',
    });
    return true;
  } catch (error) {
    // Roll back the job lock so the fallback path (and the user's next
    // message) isn't blocked behind a job that never started.
    await releaseSessionLock(input.sessionId, jobLockToken, log);
    log.error('Job promotion failed — falling back to failure frame', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function sendGoogleChatResponse(
  spaceName: string,
  threadName: string | undefined,
  text: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  // Throw on failure so SQS marks the message as failed and retries (or DLQs).
  // Callers must let the error propagate for retry semantics to work.
  const chatClient = await getChatClient();

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
  if (threadName) {
    messageBody.thread = { name: threadName };
  }

  await chatClient.spaces.messages.create({
    parent: spaceName,
    requestBody: messageBody,
  });

  log.info('Response sent to Google Chat', {
    space: spaceName,
    responseLength: text.length,
    hasCards: !!envelope?.cardsV2,
    hasAccessoryWidgets: !!envelope?.accessoryWidgets,
  });
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
      error: error instanceof Error ? error.message : String(error),
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeScheduledRun(params: ScheduledRunWrite): Promise<void> {
  if (!DATABASE_HOST || !DATABASE_SECRET_ARN) {
    throw new Error('Database not configured for scheduled run telemetry');
  }
  const sql = await getDbClient();
  if (params.scheduledRunId) {
    const updated = await sql`UPDATE agent_scheduled_runs
      SET schedule_name = ${params.scheduleName ?? null},
          input_tokens = input_tokens + ${params.inputTokens},
          output_tokens = output_tokens + ${params.outputTokens},
          latency_ms = latency_ms + ${params.latencyMs},
          status = ${params.status},
          error_message = ${params.errorMessage ?? null}
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
       input_tokens, output_tokens, latency_ms, status, error_message)
    VALUES (${params.userEmail}, ${params.scheduleId},
            ${params.scheduleName ?? null}, ${params.sessionId},
            ${params.inputTokens}, ${params.outputTokens},
            ${params.latencyMs}, ${params.status},
            ${params.errorMessage ?? null})`;
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
  params: {
    source: 'router' | 'harness' | 'cron' | 'agent_self_report' | 'tool';
    severity: 'error' | 'warn' | 'empty_response';
    userId?: string | null;
    sessionId?: string | null;
    scheduleName?: string | null;
    model?: string | null;
    errorClass?: string | null;
    errorMessage?: string | null;
    stackExcerpt?: string | null;
    context?: Record<string, unknown> | null;
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  // Emit a structured CloudWatch line first so the metric filter ticks even
  // when the DB write fails. The string AGENT_FAILURE_RECORD is matched by a
  // CloudWatch MetricFilter — keep it stable.
  log.error('AGENT_FAILURE_RECORD', {
    source: params.source,
    severity: params.severity,
    userId: params.userId ?? null,
    sessionId: params.sessionId ?? null,
    errorClass: params.errorClass ?? null,
  });
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
      error: error instanceof Error ? error.message : String(error),
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
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  if (chatEvent.type === 'MESSAGE') return false;

  log.info('Ignoring non-message event', { type: chatEvent.type });
  if (chatEvent.type !== 'ADDED_TO_SPACE') return true;

  const addedByEmail = chatEvent.message?.sender?.email;
  const addedByDomain = addedByEmail?.split('@')[1]?.toLowerCase();
  if (addedByDomain && ALLOWED_DOMAINS.includes(addedByDomain)) {
    await sendGoogleChatResponse(
      chatEvent.space.name,
      undefined,
      "Hello! I'm your PSD AI Agent. Send me a message to get started.",
      log
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
    isSharedSpace: chatEvent.space.type === 'ROOM',
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
    log
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

function crossUserSessionId(
  human: HumanMessage,
  targetUser: AgentUser
): string {
  const spaceHash = crypto
    .createHash('sha256')
    .update(human.spaceName)
    .digest('hex');
  const invokerHash = crypto
    .createHash('sha256')
    .update(human.senderEmail)
    .digest('hex')
    .slice(0, 8);
  const buildTag = process.env.AGENT_BUILD_TAG || 'unset';
  return `xuser-${targetUser.workspacePrefix}-${spaceHash}-${invokerHash}-${buildTag}`;
}

async function invokeCrossUserAgent(
  human: HumanMessage,
  invocation: CrossUserInvocation,
  targetUser: AgentUser,
  log: ReturnType<typeof createLogger>
): Promise<{ result: AgentCoreResult; sessionId: string } | null> {
  const sessionId = crossUserSessionId(human, targetUser);
  await fetchChatUploads(human.attachments, targetUser.workspacePrefix, log);
  const lockToken = await waitForSessionLock(sessionId, log);
  if (!lockToken) {
    const ownerLabel = targetUser.displayName || targetUser.email;
    await sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      `[${ownerLabel}'s Agent] I'm currently busy processing another request. Please try again in a moment.`,
      log
    );
    return null;
  }
  const result = await invokeAgentCore(
    invocation.strippedMessage,
    targetUser.email,
    sessionId,
    log,
    {
      displayName: targetUser.displayName,
      workspacePrefix: targetUser.workspacePrefix,
      invokedBy: {
        email: human.senderEmail,
        displayName: human.senderDisplayName,
      },
      threadContext: '',
      ...(human.attachments.length > 0
        ? { attachments: human.attachments }
        : {}),
    }
  ).finally(() => releaseSessionLock(sessionId, lockToken, log));
  return { result, sessionId };
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
      log
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
    log
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
      log
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
      log
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
      log
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
      log
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

function ownerSessionId(human: HumanMessage, user: AgentUser): string {
  const spaceHash = crypto
    .createHash('sha256')
    .update(human.spaceName)
    .digest('hex');
  const buildTag = process.env.AGENT_BUILD_TAG || 'unset';
  return `${user.workspacePrefix}-${spaceHash}-${buildTag}`;
}

function asideSessionId(human: HumanMessage, user: AgentUser): string {
  const spaceHash = crypto
    .createHash('sha256')
    .update(human.spaceName)
    .digest('hex');
  const buildTag = process.env.AGENT_BUILD_TAG || 'unset';
  return `${user.workspacePrefix}-${spaceHash}-aside-${buildTag}`;
}

interface OwnerAgentTurn {
  result: AgentCoreResult;
  sessionId: string;
  prompt: string;
  responsePrefix: string;
  isAside: boolean;
  autoRouted: boolean;
}

interface OwnerInvocationDependencies {
  fetchChatUploads: typeof fetchChatUploads;
  isJobLockActive: typeof isJobLockActive;
  tryAcquireSessionLock: typeof tryAcquireSessionLock;
  waitForSessionLock: typeof waitForSessionLock;
  releaseSessionLock: typeof releaseSessionLock;
  invokeAgentCore: typeof invokeAgentCore;
  sendGoogleChatResponse: typeof sendGoogleChatResponse;
}

const ownerInvocationDependencies: OwnerInvocationDependencies = {
  fetchChatUploads,
  isJobLockActive,
  tryAcquireSessionLock,
  waitForSessionLock,
  releaseSessionLock,
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
  const ownerDm = human.chatEvent.space.type === 'DM' && !human.isSharedSpace;
  const asideInvocation = ownerDm
    ? parseAsideInvocation(human.message)
    : null;

  if (asideInvocation && !asideInvocation.messageText) {
    await dependencies.sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      'Usage: `/btw <question>`',
      log
    );
    return null;
  }

  // Preserve the existing owner-turn contract: uploaded files are persisted
  // even when a busy main job means a shared-space turn cannot run yet.
  await dependencies.fetchChatUploads(
    human.attachments,
    user.workspacePrefix,
    log
  );

  let sessionId = mainSessionId;
  let prompt = messageText;
  let responsePrefix = '';
  let isAside = false;
  let autoRouted = false;

  if (asideInvocation) {
    sessionId = asideSessionId(human, user);
    prompt = asideInvocation.messageText;
    responsePrefix = ASIDE_RESPONSE_PREFIX;
    isAside = true;
    log.info('Explicit aside invocation detected', {
      source: asideInvocation.source,
      sessionId,
    });
  } else {
    const mainJobActive = await dependencies.isJobLockActive(
      mainSessionId,
      log
    );
    if (mainJobActive && ownerDm) {
      sessionId = asideSessionId(human, user);
      responsePrefix = AUTO_ASIDE_RESPONSE_PREFIX;
      isAside = true;
      autoRouted = true;
      log.info('Main job active; auto-routing owner DM to aside session', {
        mainSessionId,
        asideSessionId: sessionId,
      });
    } else if (mainJobActive) {
      await dependencies.sendGoogleChatResponse(
        human.spaceName,
        human.threadName,
        "I'm still working on your earlier task in the background — I'll post " +
          "the result here when it's done.",
        log
      );
      return null;
    }
  }

  const lockToken = isAside
    ? await dependencies.tryAcquireSessionLock(sessionId, log)
    : await dependencies.waitForSessionLock(sessionId, log);
  if (!lockToken) {
    await dependencies.sendGoogleChatResponse(
      human.spaceName,
      human.threadName,
      OWNER_BUSY_RESPONSE,
      log
    );
    return null;
  }
  const result = await dependencies.invokeAgentCore(
    prompt,
    human.senderEmail,
    sessionId,
    log,
    {
      displayName: human.senderDisplayName,
      workspacePrefix: user.workspacePrefix,
      ...(human.attachments.length > 0
        ? { attachments: human.attachments }
        : {}),
    }
  ).finally(() =>
    dependencies.releaseSessionLock(sessionId, lockToken, log)
  );
  return {
    result,
    sessionId,
    prompt,
    responsePrefix,
    isAside,
    autoRouted,
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
  turn: OwnerAgentTurn
): JobPromotionInput {
  return {
    sessionId: turn.sessionId,
    userEmail: human.senderEmail,
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
  if (!shouldPromoteToJob(turn.result.errorClass)) return false;
  const promoted = await promoteToJob(
    buildOwnerJobPromotionInput(
      human,
      prepared.user,
      turn
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
      sessionId: turn.sessionId,
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
      sessionId: turn.sessionId,
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
      sessionId: turn.sessionId,
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
    log
  );
  await recordOwnerResult(human, prepared, turn, startTime, log);
}

async function processRecord(
  record: SQSRecord,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const startTime = Date.now();
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
  parseAsideInvocation,
  ownerSessionId,
  asideSessionId,
  invokeOwnerAgentWithDependencies,
  buildOwnerResponse,
  buildOwnerJobPromotionInput,
  extractIncomingMessage,
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
  renewSessionLock,
  releaseSessionLock,
};
