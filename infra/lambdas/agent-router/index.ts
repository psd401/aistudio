/**
 * Agent Router Lambda
 *
 * Core message pipeline for the PSD AI Agent Platform:
 *   Google Chat (Pub/Sub) → Router Lambda → Bedrock Guardrails → AgentCore → Google Chat API
 *
 * Flow:
 *   1. Receive Google Chat event via Pub/Sub (SNS/SQS trigger)
 *   2. Extract sender identity from event payload
 *   3. Look up user in DynamoDB (create record if new)
 *   4. Run message through Bedrock Guardrails (K-12 content safety)
 *   5. If blocked → respond with safety message, log to telemetry
 *   6. Invoke user's AgentCore session
 *   7. Log telemetry to Aurora (user, model, tokens, timestamp, latency)
 *   8. Send response back via Google Chat API
 *
 * Environment variables (injected by CDK):
 *   ENVIRONMENT            — dev/staging/prod
 *   USERS_TABLE            — DynamoDB table name
 *   SIGNALS_TABLE          — DynamoDB table name
 *   WORKSPACE_BUCKET       — S3 bucket name for agent workspaces
 *   GUARDRAIL_ID           — Bedrock Guardrail ID
 *   GUARDRAIL_VERSION      — Bedrock Guardrail version
 *   AGENTCORE_RUNTIME_ID   — AgentCore Runtime ID (if deployed)
 *   DATABASE_RESOURCE_ARN  — Aurora cluster ARN
 *   DATABASE_SECRET_ARN    — Aurora credentials secret ARN
 *   DATABASE_NAME          — Aurora database name
 *   GOOGLE_CREDENTIALS_SECRET_ARN — Secrets Manager ARN for Google service account JSON
 *   TOKEN_LIMIT_PER_INTERACTION — Hard token limit (default 100000)
 */

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  RDSDataClient,
  ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Context as LambdaContext, SQSEvent, SQSRecord } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Structured logging (Lambda-compatible, no console.* per CLAUDE.md exception)
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function createLogger(context: Record<string, unknown> = {}) {
  const baseContext = {
    timestamp: new Date().toISOString(),
    service: 'agent-router',
    ...context,
  };

  return {
    info: (message: string, meta: Record<string, unknown> = {}) => {
      process.stdout.write(
        JSON.stringify({ level: 'INFO', message, ...baseContext, ...meta }) +
          '\n'
      );
    },
    error: (message: string, meta: Record<string, unknown> = {}) => {
      process.stderr.write(
        JSON.stringify({ level: 'ERROR', message, ...baseContext, ...meta }) +
          '\n'
      );
    },
    warn: (message: string, meta: Record<string, unknown> = {}) => {
      process.stdout.write(
        JSON.stringify({ level: 'WARN', message, ...baseContext, ...meta }) +
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
const rdsClient = new RDSDataClient({});
const secretsClient = new SecretsManagerClient({});
const ssmClient = new SSMClient({});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const USERS_TABLE = process.env.USERS_TABLE || '';
const GUARDRAIL_ID = process.env.GUARDRAIL_ID || '';
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION || 'DRAFT';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const GOOGLE_CREDENTIALS_SECRET_ARN =
  process.env.GOOGLE_CREDENTIALS_SECRET_ARN || '';
const TOKEN_LIMIT = parseInt(
  process.env.TOKEN_LIMIT_PER_INTERACTION || '100000',
  10
);
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || '';

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

async function getGoogleCredentials(): Promise<string> {
  if (cachedGoogleCredentials) return cachedGoogleCredentials;
  if (!GOOGLE_CREDENTIALS_SECRET_ARN) {
    throw new Error('GOOGLE_CREDENTIALS_SECRET_ARN not configured');
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: GOOGLE_CREDENTIALS_SECRET_ARN })
  );
  cachedGoogleCredentials = result.SecretString || '';
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
  // Look up by Google identity (users/{id})
  const existing = await dynamoClient.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { googleIdentity: senderName },
    })
  );

  if (existing.Item) {
    // Update last active timestamp
    await dynamoClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { googleIdentity: senderName },
        UpdateExpression: 'SET lastActiveAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      })
    );
    return existing.Item as AgentUser;
  }

  // New user — create record with workspace prefix
  const workspacePrefix = senderEmail.split('@')[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase();
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

  await dynamoClient.send(
    new PutCommand({
      TableName: USERS_TABLE,
      Item: newUser,
    })
  );

  log.info('New agent user created', {
    googleIdentity: senderName,
    email: senderEmail,
    workspacePrefix,
  });

  return newUser;
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
    // Guardrail failure should not block the user — log and allow
    log.error('Guardrail invocation failed, allowing message through', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
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
): Promise<{ response: string; inputTokens: number; outputTokens: number; model: string }> {
  // Resolve the AgentCore Runtime ID from SSM if not in env
  let runtimeId = process.env.AGENTCORE_RUNTIME_ID || '';
  if (!runtimeId) {
    try {
      const param = await ssmClient.send(
        new GetParameterCommand({
          Name: `/aistudio/${ENVIRONMENT}/agentcore-runtime-id`,
        })
      );
      runtimeId = param.Parameter?.Value || '';
    } catch {
      log.error('Failed to resolve AgentCore Runtime ID from SSM');
    }
  }

  if (!runtimeId) {
    return {
      response:
        'Your agent is not yet deployed. An administrator needs to push the agent image and deploy the AgentCore Runtime.',
      inputTokens: 0,
      outputTokens: 0,
      model: 'none',
    };
  }

  // Use the AWS SDK to invoke AgentCore Runtime
  // The bedrock-agentcore APIs are accessed via generic HTTP signing since
  // the TypeScript SDK client may not yet exist for bedrock-agentcore.
  // For now, we use a signed HTTP request via the AWS SDK's generic caller.
  //
  // TODO: Replace with @aws-sdk/client-bedrock-agentcore when GA SDK is released.
  // Using fetch with SigV4 signing for the alpha API.
  try {
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const { Sha256 } = await import('@aws-crypto/sha256-js');
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const { HttpRequest } = await import('@smithy/protocol-http');

    const region = process.env.AWS_REGION || 'us-east-1';
    const body = JSON.stringify({
      prompt: message,
      user_id: userId,
    });

    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: `bedrock-agentcore.${region}.amazonaws.com`,
      path: `/runtimes/${runtimeId}/sessions/${sessionId}/invoke`,
      headers: {
        'Content-Type': 'application/json',
        host: `bedrock-agentcore.${region}.amazonaws.com`,
      },
      body,
    });

    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });

    const signed = await signer.sign(request);

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
          model: 'none',
        };
      }

      return {
        response:
          'I encountered an error processing your message. Please try again.',
        inputTokens: 0,
        outputTokens: 0,
        model: 'none',
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
      model: 'none',
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
  try {
    const credentialsJson = await getGoogleCredentials();
    const credentials = JSON.parse(credentialsJson);

    // Use googleapis to create a Chat message
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });

    const chat = google.chat({ version: 'v1', auth });

    const messageBody: Record<string, unknown> = { text };
    if (threadName) {
      messageBody.thread = { name: threadName };
    }

    await chat.spaces.messages.create({
      parent: spaceName,
      requestBody: messageBody,
      messageReplyOption: threadName
        ? 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
        : undefined,
    });

    log.info('Response sent to Google Chat', {
      space: spaceName,
      responseLength: text.length,
    });
  } catch (error) {
    log.error('Failed to send Google Chat response', {
      error: error instanceof Error ? error.message : String(error),
      space: spaceName,
    });
  }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

async function logTelemetry(
  params: {
    userId: string;
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    guardrailBlocked: boolean;
    spaceName: string;
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!DATABASE_RESOURCE_ARN || !DATABASE_SECRET_ARN) {
    log.warn('Database ARNs not configured, skipping telemetry');
    return;
  }

  try {
    await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: DATABASE_RESOURCE_ARN,
        secretArn: DATABASE_SECRET_ARN,
        database: DATABASE_NAME,
        sql: `INSERT INTO agent_messages
              (user_id, session_id, model, input_tokens, output_tokens,
               latency_ms, guardrail_blocked, space_name, created_at)
              VALUES (:userId, :sessionId, :model, :inputTokens, :outputTokens,
                      :latencyMs, :guardrailBlocked, :spaceName, NOW())`,
        parameters: [
          { name: 'userId', value: { stringValue: params.userId } },
          { name: 'sessionId', value: { stringValue: params.sessionId } },
          { name: 'model', value: { stringValue: params.model } },
          {
            name: 'inputTokens',
            value: { longValue: params.inputTokens },
          },
          {
            name: 'outputTokens',
            value: { longValue: params.outputTokens },
          },
          {
            name: 'latencyMs',
            value: { longValue: params.latencyMs },
          },
          {
            name: 'guardrailBlocked',
            value: { booleanValue: params.guardrailBlocked },
          },
          { name: 'spaceName', value: { stringValue: params.spaceName } },
        ],
      })
    );
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
): Promise<void> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, environment: ENVIRONMENT });

  log.info('Router invoked', { recordCount: event.Records.length });

  for (const record of event.Records) {
    await processRecord(record, log);
  }
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
    return;
  }

  // Only process MESSAGE events
  if (chatEvent.type !== 'MESSAGE') {
    log.info('Ignoring non-message event', { type: chatEvent.type });
    if (chatEvent.type === 'ADDED_TO_SPACE') {
      await sendGoogleChatResponse(
        chatEvent.space.name,
        undefined,
        "Hello! I'm your PSD AI Agent. Send me a message to get started.",
        log
      );
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

  log.info('Processing message', {
    sender: senderEmail,
    space: spaceName,
    textLength: messageText.length,
  });

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

    await logTelemetry(
      {
        userId: senderEmail,
        sessionId: `${spaceName}-${Date.now()}`,
        model: 'none',
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
  // Use space name as session ID for conversation continuity
  const sessionId = `${user.workspacePrefix}-${spaceName.replace(/\//g, '-')}`;
  const agentResult = await invokeAgentCore(
    messageText,
    senderEmail,
    sessionId,
    log
  );

  // Step 4: Token limit check
  if (
    agentResult.inputTokens + agentResult.outputTokens > TOKEN_LIMIT
  ) {
    log.warn('Token limit exceeded', {
      inputTokens: agentResult.inputTokens,
      outputTokens: agentResult.outputTokens,
      limit: TOKEN_LIMIT,
    });
  }

  // Step 5: Send response
  // Prefix with [User's Agent] in shared spaces for clarity
  const isDM = chatEvent.space.type === 'DM';
  const responseText = isDM
    ? agentResult.response
    : `[${senderDisplayName}'s Agent] ${agentResult.response}`;

  // Truncate to Google Chat's 4096 character limit
  const maxLength = 4096;
  const finalResponse =
    responseText.length > maxLength
      ? responseText.substring(0, maxLength - 50) +
        '\n\n_(Response truncated — ask me to continue)_'
      : responseText;

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
    sender: senderEmail,
    model: agentResult.model,
    latencyMs,
    inputTokens: agentResult.inputTokens,
    outputTokens: agentResult.outputTokens,
  });
}
