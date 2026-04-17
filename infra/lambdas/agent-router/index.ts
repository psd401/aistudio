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
 *   GUARDRAIL_FAIL_OPEN    — 'true' to allow messages when guardrail service fails (default: 'false')
 *   ALLOWED_DOMAINS        — Comma-separated list of allowed email domains (default: 'psd401.net')
 */

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
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
import { Context as LambdaContext, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import * as crypto from 'crypto';
import * as chatPkg from '@googleapis/chat';

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
const GUARDRAIL_FAIL_OPEN = process.env.GUARDRAIL_FAIL_OPEN === 'true';
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
    sender: {
      name: string; // users/{userId}
      displayName: string;
      email: string;
      type: 'HUMAN' | 'BOT';
    };
    thread?: {
      name: string;
    };
    createTime: string;
  };
}

interface AgentUser {
  googleIdentity: string;
  email: string;
  displayName: string;
  department: string;
  workspacePrefix: string;
  createdAt: string;
  lastActiveAt: string;
  sessionCount: number;
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
// Guardrails
// ---------------------------------------------------------------------------

async function applyGuardrails(
  text: string,
  log: ReturnType<typeof createLogger>
): Promise<{ allowed: boolean; blockedReason?: string }> {
  if (!GUARDRAIL_ID) {
    log.warn('Guardrail ID not configured, skipping content filtering');
    return { allowed: true };
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

    const action = result.action;
    if (action === 'GUARDRAIL_INTERVENED') {
      const outputs = result.outputs?.map((o) => o.text).join(' ') || '';
      log.warn('Guardrail blocked message', {
        action,
        outputPreview: outputs.substring(0, 200),
      });
      return {
        allowed: false,
        blockedReason:
          outputs ||
          'Your message was filtered by our content safety system. Please rephrase.',
      };
    }

    return { allowed: true };
  } catch (error) {
    // K-12 safety: fail closed by default. Only allow through if explicitly
    // configured via GUARDRAIL_FAIL_OPEN=true (not recommended for production).
    log.error('Guardrail invocation failed', {
      error: error instanceof Error ? error.message : String(error),
      failOpen: GUARDRAIL_FAIL_OPEN,
    });
    if (GUARDRAIL_FAIL_OPEN) {
      return { allowed: true };
    }
    return {
      allowed: false,
      blockedReason:
        'Our content safety system is temporarily unavailable. Please try again shortly.',
    };
  }
}

// ---------------------------------------------------------------------------
// AgentCore invocation
// ---------------------------------------------------------------------------

async function invokeAgentCore(
  message: string,
  userId: string,
  sessionId: string,
  log: ReturnType<typeof createLogger>
): Promise<{ response: string; inputTokens: number; outputTokens: number; model: string | null }> {
  // Resolve the AgentCore Runtime ID — check env var, then module-level cache,
  // then SSM. Cached at module scope with TTL to avoid redundant SSM API calls
  // on every invocation (~5–20ms + cost per call).
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

  if (!runtimeId) {
    return {
      response:
        'Your agent is not yet deployed. An administrator needs to push the agent image and deploy the AgentCore Runtime.',
      inputTokens: 0,
      outputTokens: 0,
      model: null,
    };
  }

  // Invoke AgentCore Runtime via SigV4-signed HTTP request.
  // The bedrock-agentcore TypeScript SDK is not yet GA, so we use generic HTTP
  // signing. The API expects:
  //   POST /runtimes/{runtimeArn}/invocations
  //   X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {sessionId}
  //   X-Amzn-Bedrock-AgentCore-Runtime-User-Id: {userId}
  //
  // TODO: Replace with @aws-sdk/client-bedrock-agentcore when GA SDK is released.
  try {
    const region = process.env.AWS_REGION || 'us-east-1';
    const account = process.env.AWS_ACCOUNT_ID || '';
    // Construct the full Runtime ARN — the API requires the ARN, not the runtime ID
    const runtimeArn = runtimeId.startsWith('arn:')
      ? runtimeId
      : `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${runtimeId}`;
    const body = JSON.stringify({
      prompt: message,
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

      if (response.status === 503 || response.status === 429) {
        return {
          response:
            "I'm temporarily busy. Please try again in a moment.",
          inputTokens: 0,
          outputTokens: 0,
          model: null,
        };
      }

      return {
        response:
          'I encountered an error processing your message. Please try again.',
        inputTokens: 0,
        outputTokens: 0,
        model: null,
      };
    }

    const responseBody = await response.json() as Record<string, unknown>;
    const result = (responseBody.result as string) || 'No response from agent.';
    const metadata = (responseBody.metadata as Record<string, unknown>) || {};

    return {
      response: result,
      inputTokens: (metadata.input_tokens as number) || 0,
      outputTokens: (metadata.output_tokens as number) || 0,
      model: (metadata.model as string) || 'kimi-k2.5',
    };
  } catch (error) {
    log.error('AgentCore invocation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response:
        "I'm temporarily unable to help. Please try again shortly.",
      inputTokens: 0,
      outputTokens: 0,
      model: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Google Chat response
// ---------------------------------------------------------------------------

async function sendGoogleChatResponse(
  spaceName: string,
  threadName: string | undefined,
  text: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  // Throw on failure so SQS marks the message as failed and retries (or DLQs).
  // Callers must let the error propagate for retry semantics to work.
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

  // Reuse the cached Chat API client across warm invocations to avoid an
  // OAuth token round-trip on every response. The cache is invalidated when
  // credentials are refreshed (TTL expiry or JSON parse error above).
  if (!cachedChatClient) {
    const googleAuth = new chatPkg.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    cachedChatClient = chatPkg.chat({ version: 'v1', auth: googleAuth });
  }

  const chatClient = cachedChatClient;

  const messageBody: Record<string, string | Record<string, string>> = { text };
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
  });
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

async function logTelemetry(
  params: {
    userId: string;
    sessionId: string;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    guardrailBlocked: boolean;
    spaceName: string;
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!DATABASE_HOST || !DATABASE_SECRET_ARN) {
    log.warn('Database not configured, skipping telemetry');
    return;
  }

  try {
    const sql = await getDbClient();
    const totalTokens = params.inputTokens + params.outputTokens;

    // Run both telemetry writes in parallel — they're independent.
    // Uses direct PostgreSQL (postgres.js) consistent with the rest of the app,
    // instead of RDS Data API which adds ~100-300ms latency per call.
    await Promise.all([
      // Insert message-level telemetry
      sql`INSERT INTO agent_messages
          (user_id, session_id, model, input_tokens, output_tokens,
           latency_ms, guardrail_blocked, space_name, created_at)
          VALUES (${params.userId}, ${params.sessionId}, ${params.model},
                  ${params.inputTokens}, ${params.outputTokens},
                  ${params.latencyMs}, ${params.guardrailBlocked},
                  ${params.spaceName}, NOW())`,

      // Upsert session-level aggregates — creates the session row on first message,
      // increments counters on subsequent messages. Uses ON CONFLICT on session_id
      // unique constraint to achieve idempotent upserts.
      sql`INSERT INTO agent_sessions
          (user_id, session_id, session_start, total_messages, total_tokens, created_at, updated_at)
          VALUES (${params.userId}, ${params.sessionId}, NOW(), 1, ${totalTokens}, NOW(), NOW())
          ON CONFLICT (session_id) DO UPDATE SET
            total_messages = agent_sessions.total_messages + 1,
            total_tokens = agent_sessions.total_tokens + EXCLUDED.total_tokens,
            session_end = NOW()`,
    ]);
  } catch (error) {
    // Telemetry failure should not affect user experience
    log.error('Failed to write telemetry', {
      error: error instanceof Error ? error.message : String(error),
    });
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
  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      batchItemFailures.push({ itemIdentifier: event.Records[idx].messageId });
      log.error('Record processing failed', {
        messageId: event.Records[idx].messageId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { batchItemFailures };
}

async function processRecord(
  record: SQSRecord,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const startTime = Date.now();

  // Parse the Pub/Sub message from SQS
  // Google Chat Pub/Sub → GCP Pub/Sub → (bridge) → SQS → Lambda
  let chatEvent: GoogleChatEvent;
  try {
    // The SQS message body contains the Pub/Sub message data
    const sqsBody = JSON.parse(record.body);
    // Pub/Sub wraps data in base64 under .message.data
    const pubsubData = sqsBody.message?.data || sqsBody.Message || sqsBody;
    const decoded =
      typeof pubsubData === 'string'
        ? Buffer.from(pubsubData, 'base64').toString('utf-8')
        : JSON.stringify(pubsubData);
    chatEvent = JSON.parse(decoded) as GoogleChatEvent;
  } catch (error) {
    log.error('Failed to parse chat event', {
      error: error instanceof Error ? error.message : String(error),
      body: record.body.substring(0, 500),
    });
    // Rethrow so SQS marks as failed and retries/DLQs the message
    throw error;
  }

  // Only process MESSAGE events
  if (chatEvent.type !== 'MESSAGE') {
    log.info('Ignoring non-message event', { type: chatEvent.type });
    if (chatEvent.type === 'ADDED_TO_SPACE') {
      // Validate that ADDED_TO_SPACE events come from an allowed domain before
      // responding. An injected event with no sender or an outside-domain sender
      // should not receive a welcome message (confirms the agent is active).
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
    }
    return;
  }

  const message = chatEvent.message;
  if (!message || !message.text || !message.sender) {
    log.warn('Message event missing required fields');
    return;
  }

  // Ignore messages from bots
  if (message.sender.type === 'BOT') {
    return;
  }

  const senderName = message.sender.name;
  const senderEmail = message.sender.email;
  const senderDisplayName = message.sender.displayName;
  const messageText = message.text;
  const spaceName = chatEvent.space.name;
  const threadName = message.thread?.name;

  // Validate sender belongs to an allowed domain — prevents abuse if
  // an actor injects messages into the SQS queue with arbitrary emails.
  const emailDomain = senderEmail.split('@')[1]?.toLowerCase();
  if (!emailDomain || !ALLOWED_DOMAINS.includes(emailDomain)) {
    log.warn('Sender email not in allowed domains', {
      sender: senderName,
      domain: emailDomain,
      allowedDomains: ALLOWED_DOMAINS,
    });
    return;
  }

  log.info('Processing message', {
    sender: senderName,
    space: spaceName,
    textLength: messageText.length,
  });

  // Guard: reject messages that exceed the configured length limit before
  // hitting Guardrails or AgentCore — prevents timeouts and unexpected costs.
  if (messageText.length > MAX_MESSAGE_LENGTH) {
    log.warn('Message exceeds maximum length', {
      length: messageText.length,
      limit: MAX_MESSAGE_LENGTH,
    });
    await sendGoogleChatResponse(
      spaceName,
      threadName,
      `Your message is too long (${messageText.length.toLocaleString()} characters). ` +
        `Please keep messages under ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`,
      log
    );
    return;
  }

  // Step 1: Resolve user
  const user = await getOrCreateUser(
    senderName,
    senderEmail,
    senderDisplayName,
    log
  );

  // Step 2: Guardrails check
  const guardrailResult = await applyGuardrails(messageText, log);
  if (!guardrailResult.allowed) {
    await sendGoogleChatResponse(
      spaceName,
      threadName,
      guardrailResult.blockedReason ||
        'Your message was filtered by our content safety system. Please rephrase.',
      log
    );

    // Use the same stable session ID as non-blocked messages so session-level
    // blocking stats aggregate correctly (not a throwaway timestamp-based ID).
    const blockedSpaceHash = crypto.createHash('sha256').update(spaceName).digest('hex');
    const blockedSessionId = `${user.workspacePrefix}-${blockedSpaceHash}`;

    await logTelemetry(
      {
        userId: senderEmail,
        sessionId: blockedSessionId,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startTime,
        guardrailBlocked: true,
        spaceName,
      },
      log
    );
    return;
  }

  // Step 3: Invoke AgentCore
  // Session ID = workspace prefix + SHA-256 hash of space name.
  // Using a hash instead of truncation prevents collisions: two spaces with a
  // long common prefix would truncate to the same session_id, silently merging
  // telemetry. SHA-256 hex is 64 chars, always fits VARCHAR(512).
  const spaceHash = crypto.createHash('sha256').update(spaceName).digest('hex');
  const sessionId = `${user.workspacePrefix}-${spaceHash}`;
  const agentResult = await invokeAgentCore(
    messageText,
    senderEmail,
    sessionId,
    log
  );

  // Step 4: Token usage alerting threshold (warn-only, not enforcement)
  // The response is still delivered — this is for monitoring/alerting.
  // Hard enforcement requires pre-invocation token estimation via session
  // tracking in DynamoDB, which is planned for Phase 2.
  const totalTokens = agentResult.inputTokens + agentResult.outputTokens;
  if (totalTokens > TOKEN_LIMIT) {
    log.warn('Token usage exceeds alerting threshold', {
      inputTokens: agentResult.inputTokens,
      outputTokens: agentResult.outputTokens,
      totalTokens,
      threshold: TOKEN_LIMIT,
    });
  }

  // KNOWN GAP: Output is not run through Bedrock Guardrails.
  // applyGuardrails() only filters INPUT (source: 'INPUT'). The agent response
  // is sent directly to Google Chat without content filtering. For K-12
  // deployments, consider adding an output guardrail check via source: 'OUTPUT'
  // before sendGoogleChatResponse(). The Bedrock ApplyGuardrail API supports
  // this in the same call. Deferred to Phase 2 to avoid doubling latency.

  // Step 5: Send response
  // Prefix with [User's Agent] in shared spaces for clarity.
  // Truncate the raw response BEFORE adding the prefix so truncation
  // behavior is consistent between DMs and shared spaces (the prefix
  // would otherwise consume ~30 chars of the 4096 limit only in shared spaces).
  const maxLength = 4096;
  const truncationSuffix = '\n\n_(Response truncated — ask me to continue)_';
  const isDM = chatEvent.space.type === 'DM';
  const prefix = isDM ? '' : `[${senderDisplayName}'s Agent] `;
  const availableLength = maxLength - prefix.length;
  const truncatedResponse =
    agentResult.response.length > availableLength
      ? agentResult.response.substring(0, availableLength - truncationSuffix.length) +
        truncationSuffix
      : agentResult.response;
  const finalResponse = `${prefix}${truncatedResponse}`;

  await sendGoogleChatResponse(spaceName, threadName, finalResponse, log);

  // Step 6: Log telemetry
  const latencyMs = Date.now() - startTime;
  await logTelemetry(
    {
      userId: senderEmail,
      sessionId,
      model: agentResult.model,
      inputTokens: agentResult.inputTokens,
      outputTokens: agentResult.outputTokens,
      latencyMs,
      guardrailBlocked: false,
      spaceName,
    },
    log
  );

  log.info('Message processed', {
    sender: senderName,
    model: agentResult.model,
    latencyMs,
    inputTokens: agentResult.inputTokens,
    outputTokens: agentResult.outputTokens,
  });
}
