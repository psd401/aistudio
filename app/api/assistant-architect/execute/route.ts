import { z } from 'zod';
import { UIMessage } from 'ai';
import type { ToolSet } from 'ai';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { getAssistantArchitectByIdAction } from '@/actions/db/assistant-architect-actions';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getAIModelById, getUserById } from '@/lib/db/drizzle';
import { executeQuery } from '@/lib/db/drizzle-client';
import { sql } from 'drizzle-orm';
import { unifiedStreamingService } from '@/lib/streaming/unified-streaming-service';
import {
  retrieveKnowledgeForPrompt,
  formatKnowledgeContext,
  retrieveAtriumKnowledgeForPrompt,
  formatAtriumKnowledgeContext,
} from '@/lib/assistant-architect/knowledge-retrieval';
import { getUserRequester } from '@/actions/db/atrium/requester';
import type { Requester } from '@/lib/content/types';
import { hasCapabilityAccess, hasRole } from '@/utils/roles';
import { ErrorFactories } from '@/lib/error-utils';
import { createRepositoryTools } from '@/lib/tools/repository-tools';
import { getScopesForRoles } from '@/lib/api-keys/scopes';
import {
  resolveAgentTools,
  closeAgentConnectorClients,
  resolveAgentRunLimits,
  AGENT_RATE_LIMIT_WINDOW_MS,
  extractImageInputParts,
} from '@/lib/agents';
import type { ToolInvocationAudit } from '@/lib/agents';
import type { McpConnectorToolsResult } from '@/lib/mcp/connector-types';
import type { AssistantArchitectMode } from '@/lib/db/schema/tables/assistant-architects';
import type { StreamRequest } from '@/lib/streaming/types';
import { ContentSafetyBlockedError } from '@/lib/streaming/types';
import { storeExecutionEvent } from '@/lib/assistant-architect/event-storage';
import { decodeMdxEditorEscapes } from '@/lib/utils/text-sanitizer';
import { createConversation, updateConversation, getConversationById } from '@/lib/db/drizzle/nexus-conversations';
import { createMessageWithStats, updateConversationStats } from '@/lib/db/drizzle/nexus-messages';
import type { AssistantArchitectMessageMetadata } from '@/lib/db/types/jsonb';

// Allow streaming responses up to 15 minutes for long chains
export const maxDuration = 900;

// Constants for resource limits
const MAX_INPUT_SIZE_BYTES = 100000; // 100KB max input size
const MAX_INPUT_FIELDS = 50; // Max 50 input fields
const MAX_PROMPT_CHAIN_LENGTH = 20; // Max 20 prompts per execution
const MAX_PROMPT_CONTENT_SIZE = 10000000; // 10MB max prompt content size (allows large context)
const MAX_VARIABLE_REPLACEMENTS = 50; // Max 50 variable placeholders per prompt (realistic upper bound)

// Request validation schema
const ExecuteRequestSchema = z.object({
  toolId: z.number().positive(),
  inputs: z.record(z.string(), z.unknown())
    .refine(
      (inputs) => {
        const jsonSize = JSON.stringify(inputs).length;
        return jsonSize <= MAX_INPUT_SIZE_BYTES;
      },
      { message: `Input data exceeds maximum size of ${MAX_INPUT_SIZE_BYTES} bytes` }
    )
    .refine(
      (inputs) => Object.keys(inputs).length <= MAX_INPUT_FIELDS,
      { message: `Too many input fields (maximum ${MAX_INPUT_FIELDS})` }
    ),
  conversationId: z.string().uuid().optional(),
  /**
   * Per-run approval for destructive (state-changing) agent tools (Issue #926).
   * When omitted/false, destructive tools are gated behind a confirmation message
   * and not executed. The executing user opts in (e.g. an execution-form checkbox)
   * to allow them to run in this agentic run. Ignored in prompt-chain mode.
   */
  approveDestructiveTools: z.boolean().optional()
});

interface ChainPrompt {
  id: number;
  name: string;
  content: string;
  systemContext: string | null;
  modelId: number | null;
  /**
   * Execution position - prompts execute sequentially by position (0, then 1, then 2...).
   * Multiple prompts at the same position execute in parallel.
   */
  position: number;
  /**
   * Parallel group identifier (reserved for future use).
   * Currently, all prompts at the same position execute in parallel.
   * In future: Could enable multiple parallel groups within same position.
   *
   * TODO: Implement parallelGroup-based execution logic to support multiple
   * parallel groups within same position (e.g., [pos=0, group=A], [pos=0, group=B])
   */
  parallelGroup: number | null;
  inputMapping: Record<string, string> | null;
  repositoryIds: number[] | null;
  enabledTools: string[] | null;
  timeoutSeconds: number | null;
}

interface PromptExecutionContext {
  previousOutputs: Map<number, string>;
  accumulatedMessages: UIMessage[];
  executionId: number;
  userCognitoSub: string;
  assistantOwnerSub?: string;
  userId: number;
  executionStartTime: number;
  /** The executing assistant's id, for the Atrium retrieval-scope gate (§16.4). */
  assistantId: number;
  /**
   * The Atrium content Requester the execution retrieves as (Phase 6, Issue
   * #1056): the session user, so every Atrium hit is bounded by THEIR
   * `canView`. Null when no requester was derivable — Atrium retrieval then
   * skips entirely (fail closed to nothing); repository retrieval is unaffected.
   */
  atriumRequester: Requester | null;
  conversation?: {
    conversationId: string;
    assistantId: number;
    assistantName: string;
  };
  /**
   * Caller identity for agentic-mode tool resolution (Issue #926). Scopes are
   * role-derived; tools the author enabled are intersected with these at
   * execution time so a low-privilege executor cannot invoke a tool they lack
   * the scope for.
   */
  caller?: {
    scopes: string[];
    roleNames: string[];
    idToken?: string;
  };
}

/**
 * Agentic execution config for an assistant (Issue #926). Resolved from the
 * architect row + caller context and passed to the agent runtime.
 */
interface AgenticConfig {
  enabledToolIdentifiers: string[];
  enabledConnectorIds: string[];
  maxSteps: number;
  timeoutSeconds: number;
  costCapCents: number | null;
}

/**
 * Build execution conversation metadata with consistent structure
 */
function buildExecutionMetadata(
  assistantId: number,
  assistantName: string,
  executionId: number,
  executionStatus: 'running' | 'failed' | 'completed'
): Record<string, unknown> {
  return {
    source: 'app',
    assistantId,
    assistantName,
    executionId,
    executionStatus,
  };
}

/**
 * Discriminated result for a POST phase helper: either it produced a value the
 * caller continues with, or it produced an HTTP Response the caller must return
 * immediately (short-circuit). Keeps every early-return response path explicit
 * so POST never accidentally swallows one.
 */
type PhaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

type RouteLogger = ReturnType<typeof createLogger>;
type RouteTimer = ReturnType<typeof startTimer>;
type ValidatedRequest = z.infer<typeof ExecuteRequestSchema>;
type LoadedArchitect = NonNullable<
  Awaited<ReturnType<typeof getAssistantArchitectByIdAction>>['data']
>;
// `architect.prompts` is optional on the row; after `(architect.prompts || [])`
// the value is always a defined array, so the loaded/validated list is non-null.
type LoadedPrompts = NonNullable<LoadedArchitect['prompts']>;
type CurrentUserData = NonNullable<
  Awaited<ReturnType<typeof getCurrentUserAction>>['data']
>;

/**
 * Phase (a): parse + validate the request body. Returns a 400 Response for an
 * empty/malformed body or a schema-validation failure; otherwise the parsed
 * data. Preserves the exact log lines and response shapes of the original POST.
 */
async function parseAndValidateRequest(
  req: Request,
  requestId: string,
  log: RouteLogger
): Promise<PhaseResult<ValidatedRequest>> {
  // Issue #657: Handle empty/malformed request body gracefully
  let body: unknown;
  try {
    body = await req.json();
  } catch (parseError) {
    log.warn('Failed to parse request body', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
      contentLength: req.headers.get('content-length'),
      contentType: req.headers.get('content-type')
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Invalid request body',
          message: 'Request body is empty or not valid JSON. Please try again.',
          requestId
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': requestId
          }
        }
      )
    };
  }

  const validationResult = ExecuteRequestSchema.safeParse(body);

  if (!validationResult.success) {
    log.warn('Invalid request format', {
      errors: validationResult.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Invalid request format',
          details: validationResult.error.issues,
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const { toolId, inputs, conversationId } = validationResult.data;
  log.info('Request parsed', sanitizeForLogging({
    toolId,
    hasInputs: Object.keys(inputs).length > 0,
    inputKeys: Object.keys(inputs),
    conversationId
  }));

  return { ok: true, value: validationResult.data };
}

/**
 * Phase (b): authenticate the user, check tool access + per-architect
 * authorization, load the architect, and validate its prompt chain. Returns the
 * appropriate 401/403/404/400 Response on any failure; otherwise the
 * authenticated user, architect, and sorted prompt list. Behavior (including the
 * unauthorized timer call) is identical to the original inline POST logic.
 */
async function authorizeAndLoadArchitect(
  toolId: number,
  requestId: string,
  log: RouteLogger,
  timer: RouteTimer
): Promise<PhaseResult<{
  session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>;
  currentUserData: CurrentUserData;
  userId: number;
  architect: LoadedArchitect;
  prompts: LoadedPrompts;
}>> {
  // 2. Authenticate user
  const session = await getServerSession();
  if (!session) {
    log.warn('Unauthorized request - no session');
    timer({ status: 'error', reason: 'unauthorized' });
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
  }

  log.debug('User authenticated', sanitizeForLogging({ userId: session.sub }));

  // 3. Check tool access permission
  const hasAccess = await hasCapabilityAccess('assistant-architect');
  if (!hasAccess) {
    log.warn('User does not have assistant-architect tool access', { userId: session.sub });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'You do not have permission to use the Assistant Architect tool',
          requestId
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  // 4. Get current user
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.error('Failed to get current user');
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
  }

  const userId = currentUser.data.user.id;

  // 5. Load assistant architect configuration with prompts
  const architectResult = await getAssistantArchitectByIdAction(toolId.toString());
  if (!architectResult.isSuccess || !architectResult.data) {
    log.error('Assistant architect not found', { toolId });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Assistant architect not found',
          requestId
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const architect = architectResult.data;

  // SECURITY: Verify user has permission to execute this assistant architect
  // Allow execution if:
  // 1. User is the owner (can execute any of their own, regardless of status)
  // 2. User is an admin (can execute any assistant)
  // 3. The assistant is approved (any user with assistant-architect access can execute)
  const isOwner = architect.userId === userId;
  const isAdmin = await hasRole('administrator');
  const isApproved = architect.status === 'approved';

  // Determine access reason for logging
  let accessReason: string | null = null;
  if (isOwner) {
    accessReason = 'owner';
  } else if (isAdmin) {
    accessReason = 'admin';
  } else if (isApproved) {
    accessReason = 'approved';
  }

  if (!accessReason) {
    // No valid access path - deny execution
    log.warn('User does not have access to this assistant architect', {
      userId,
      toolId,
      architectOwnerId: architect.userId,
      status: architect.status,
      isOwner,
      isAdmin,
      isApproved
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'You do not have permission to execute this assistant architect',
          requestId
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  // Log successful authorization for audit trail
  log.info('Authorization granted for assistant architect execution', {
    userId,
    toolId,
    architectOwnerId: architect.userId,
    status: architect.status,
    accessReason
  });

  const prompts = (architect.prompts || []).sort((a, b) => a.position - b.position);

  if (!prompts || prompts.length === 0) {
    log.error('No prompts configured for assistant architect', { toolId });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'No prompts configured for this assistant architect',
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  // Validate prompt chain length to prevent resource exhaustion
  if (prompts.length > MAX_PROMPT_CHAIN_LENGTH) {
    log.warn('Prompt chain too long', { promptCount: prompts.length, toolId, maxAllowed: MAX_PROMPT_CHAIN_LENGTH });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Prompt chain too long',
          message: `Maximum ${MAX_PROMPT_CHAIN_LENGTH} prompts allowed per execution`,
          requestId
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  log.info('Assistant architect loaded', sanitizeForLogging({
    toolId,
    name: architect.name,
    promptCount: prompts.length,
    userId
  }));

  return { ok: true, value: { session, currentUserData: currentUser.data, userId, architect, prompts } };
}

/**
 * Phase (c): create the tool_execution record. For an agentic assistant with a
 * per-assistant hourly cap (Issue #926), the insert is GUARDED atomically:
 * INSERT ... SELECT ... WHERE <window count> < cap. Collapsing the count +
 * insert into ONE statement removes the prior check-then-insert TOCTOU. A
 * guarded insert that returns no row means the cap is reached -> 429. NULL/unset
 * cap => unguarded insert.
 *
 * input_data is bound (${...}::jsonb) — postgres.js is the active driver, which
 * binds parameterized casts correctly (the old sql.raw() JSONB workaround was
 * for the retired RDS Data API driver). See Issue #599.
 */
async function createToolExecutionRecord(args: {
  architect: LoadedArchitect;
  toolId: number;
  userId: number;
  inputs: Record<string, unknown>;
  requestId: string;
  log: RouteLogger;
  timer: RouteTimer;
}): Promise<PhaseResult<{ executionId: number }>> {
  const { architect, toolId, userId, inputs, requestId, log, timer } = args;
  const inputData = Object.keys(inputs).length > 0 ? inputs : { __no_inputs: true };
  const inputDataJson = JSON.stringify(inputData);
  const startedAtIso = new Date().toISOString();

  const rateCap = architect.mode === 'agentic'
    ? (architect as { agentMaxRequestsPerHour?: number | null }).agentMaxRequestsPerHour
    : null;
  const rateCapped = typeof rateCap === 'number' && rateCap > 0;

  const executionResult = await executeQuery(
    (db) => {
      if (rateCapped) {
        const windowStartIso = new Date(Date.now() - AGENT_RATE_LIMIT_WINDOW_MS).toISOString();
        return db.execute(sql`
          INSERT INTO tool_executions (user_id, input_data, status, started_at, assistant_architect_id)
          SELECT ${userId}, ${inputDataJson}::jsonb, 'running', ${startedAtIso}::timestamp, ${toolId}
          WHERE (
            SELECT count(*) FROM tool_executions
            WHERE assistant_architect_id = ${toolId} AND started_at >= ${windowStartIso}::timestamp
          ) < ${rateCap}
          RETURNING id
        `);
      }
      return db.execute(sql`
        INSERT INTO tool_executions (user_id, input_data, status, started_at, assistant_architect_id)
        VALUES (${userId}, ${inputDataJson}::jsonb, 'running', ${startedAtIso}::timestamp, ${toolId})
        RETURNING id
      `);
    },
    'createToolExecution'
  );

  // postgres.js returns result directly as array-like object (no .rows property - Issue #603)
  const rows = executionResult as unknown as Array<{ id: number }>;
  if (!rows || rows.length === 0 || !rows[0]?.id) {
    if (rateCapped) {
      // Guarded insert added no row => the assistant is at/over its hourly cap.
      log.warn('Assistant rate limit exceeded', { toolId, rateCap });
      timer({ status: 'rate_limited' });
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: 'Rate limit exceeded',
            message: `This assistant is limited to ${rateCap} run(s) per hour. Please try again later.`,
            requestId
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '3600',
              'X-Request-Id': requestId
            }
          }
        )
      };
    }
    log.error('Failed to create tool execution', { toolId });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Failed to create execution record',
          requestId
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const executionId = Number(rows[0].id);
  log.info('Tool execution created', { executionId, toolId });
  return { ok: true, value: { executionId } };
}

/**
 * Phase (d): create the nexus conversation for this execution and persist the
 * user inputs as the first message. Non-fatal: any failure is logged and
 * `undefined` is returned so the execution continues without conversation
 * tracking. Mirrors the pattern in
 * /api/v1/assistants/[id]/conversations/route.ts.
 */
async function createNexusConversationForExecution(args: {
  architect: LoadedArchitect;
  toolId: number;
  userId: number;
  inputs: Record<string, unknown>;
  executionId: number;
  log: RouteLogger;
}): Promise<string | undefined> {
  const { architect, toolId, userId, inputs, executionId, log } = args;
  try {
    const conversation = await createConversation({
      userId,
      title: `${architect.name} — ${new Date().toLocaleDateString()}`,
      provider: 'assistant-architect',
      metadata: buildExecutionMetadata(toolId, architect.name, executionId, 'running'),
    });

    // Save user inputs as the first message
    // Sanitize and truncate inputs for safe storage
    const userContent = Object.keys(inputs).length > 0
      ? Object.entries(inputs)
          .map(([key, value]) => {
            const safeKey = String(key).substring(0, 100);
            const safeValue = typeof value === 'string'
              ? value.substring(0, 5000)
              : String(sanitizeForLogging(value)).substring(0, 5000);
            return `${safeKey}: ${safeValue}`;
          })
          .join('\n')
          .substring(0, 10000)
      : '(Assistant executed with default inputs)';

    await createMessageWithStats({
      conversationId: conversation.id,
      role: 'user',
      content: userContent,
      parts: [{ type: 'text', text: userContent }],
      metadata: { inputs, source: 'app' },
    });

    log.info('Nexus conversation created for execution', {
      conversationId: conversation.id,
      executionId,
      toolId,
    });

    return conversation.id;
  } catch (conversationError) {
    // Non-fatal: log and continue execution without conversation tracking
    log.error('Failed to create nexus conversation for execution', {
      error: conversationError instanceof Error ? conversationError.message : String(conversationError),
      executionId,
      toolId,
    });
    return undefined;
  }
}

/**
 * Phase (e): run the execution (agentic or prompt-chain), build the streaming
 * Response, and on a synchronous pre-stream failure roll back the
 * tool_executions row, emit the execution-error event, reconcile the nexus
 * conversation, then re-throw so the outer POST catch maps the error to a
 * Response. The returned Response is the exact SSE stream the original POST
 * produced (identical headers and ordering).
 */
async function runExecutionAndBuildResponse(args: {
  architect: LoadedArchitect;
  prompts: LoadedPrompts;
  inputs: Record<string, unknown>;
  context: PromptExecutionContext;
  executionId: number;
  toolId: number;
  userId: number;
  nexusConversationId: string | undefined;
  approveDestructiveTools: boolean;
  requestId: string;
  log: RouteLogger;
}): Promise<Response> {
  const {
    architect, prompts, inputs, context, executionId, toolId, userId,
    nexusConversationId, approveDestructiveTools, requestId, log,
  } = args;
  try {
    // Issue #926: branch on assistant mode. Agentic assistants run a model loop
    // with tool access; prompt-chain assistants keep the original sequential
    // template execution untouched.
    const isAgentic = architect.mode === 'agentic';
    const streamResponse = isAgentic
      ? await executeAgenticAssistant({ architect, prompts: prompts as ChainPrompt[], inputs, context, requestId, log, approveDestructiveTools })
      : await executePromptChain(prompts as ChainPrompt[], inputs, context, requestId, log);

    // 9. Update execution status to completed on stream completion
    // This is done in the onFinish callback of the last prompt

    // Return SSE stream with headers
    log.info('Returning streaming response', {
      executionId,
      toolId,
      promptCount: prompts.length,
      requestId,
      hasStreamResponse: !!streamResponse
    });

    if (!streamResponse) {
      throw ErrorFactories.sysInternalError('No stream response generated from prompt execution');
    }

    return streamResponse.result.toUIMessageStreamResponse({
      headers: {
        'X-Execution-Id': executionId.toString(),
        'X-Tool-Id': toolId.toString(),
        'X-Prompt-Count': prompts.length.toString(),
        'X-Request-Id': requestId,
        ...(context.conversation?.conversationId && { 'X-Conversation-Id': context.conversation.conversationId }),
      }
    });

  } catch (executionError) {
    // Update execution status to failed
    // CRITICAL: Drizzle's AWS Data API driver has issues with timestamp serialization.
    // Must use raw SQL with db.execute() for reliable parameter binding.
    // See: Issue #599, https://github.com/drizzle-team/drizzle-orm/issues/724
    const errMsg = executionError instanceof Error ? executionError.message : String(executionError);
    await executeQuery(
      (db) => db.execute(sql`
        UPDATE tool_executions
        SET status = 'failed', error_message = ${errMsg}, completed_at = ${new Date().toISOString()}::timestamp
        WHERE id = ${executionId}
      `),
      'updateToolExecutionFailed'
    );

    // Emit execution-error event
    await storeExecutionEvent(executionId, 'execution-error', {
      executionId,
      error: executionError instanceof Error ? executionError.message : String(executionError),
      recoverable: false,
      details: executionError instanceof Error ? executionError.stack : undefined
    }).catch(err => log.error('Failed to store execution-error event', { error: err }));

    // Update nexus conversation executionStatus to failed
    if (nexusConversationId) {
      try {
        // Fetch existing metadata and merge to preserve other fields
        const existing = await getConversationById(nexusConversationId, userId);
        await updateConversation(nexusConversationId, userId, {
          metadata: {
            ...existing.metadata,
            ...buildExecutionMetadata(toolId, architect.name, executionId, 'failed'),
          },
        });
        // Reconcile stats for messages saved before the failure (#719)
        await updateConversationStats(nexusConversationId);
      } catch (err) {
        log.error('Failed to update conversation status to failed', {
          error: err instanceof Error ? err.message : String(err),
          conversationId: nexusConversationId,
          executionId
        });
      }
    }

    throw executionError;
  }
}

/**
 * Assistant Architect Execution API - Native SSE Streaming
 *
 * Replaces polling-based execution with native streaming, supporting:
 * - Multi-prompt sequential execution with state management
 * - Variable substitution between prompts
 * - Repository context injection (vector, keyword, hybrid search)
 * - Per-prompt tool configuration
 * - Database persistence via onFinish callbacks
 */
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const timer = startTimer('api.assistant-architect.execute');
  const log = createLogger({ requestId, route: 'api.assistant-architect.execute' });

  log.info('POST /api/assistant-architect/execute - Processing execution request with streaming');

  try {
    // 1. Parse and validate request (Issue #657: empty/malformed body handled)
    const parsed = await parseAndValidateRequest(req, requestId, log);
    if (!parsed.ok) return parsed.response;
    const { toolId, inputs, approveDestructiveTools } = parsed.value;

    // 2-5. Authenticate, authorize, load architect + validate prompt chain
    const authorized = await authorizeAndLoadArchitect(toolId, requestId, log, timer);
    if (!authorized.ok) return authorized.response;
    const { session, currentUserData, userId, architect, prompts } = authorized.value;

    // 6. Create the tool_execution record (rate-cap guarded for agentic mode)
    const created = await createToolExecutionRecord({ architect, toolId, userId, inputs, requestId, log, timer });
    if (!created.ok) return created.response;
    const { executionId } = created.value;

    // 7. Emit execution-start event
    await storeExecutionEvent(executionId, 'execution-start', {
      executionId,
      totalPrompts: prompts.length,
      toolName: architect.name
    });

    // 7.5. Create nexus conversation for this execution (non-fatal)
    const nexusConversationId = await createNexusConversationForExecution({
      architect, toolId, userId, inputs, executionId, log
    });

    // 7.6. Resolve the Atrium content Requester for permission-aware retrieval
    // (Phase 6, Issue #1056). Resolution failure (e.g. no matching user row)
    // must never fail the execution: Atrium retrieval simply skips (fail closed
    // to nothing) while repository retrieval proceeds unchanged.
    let atriumRequester: Requester | null = null;
    try {
      atriumRequester = await getUserRequester(requestId, session);
    } catch (requesterError) {
      log.warn('Could not resolve Atrium requester; skipping Atrium retrieval', {
        error: requesterError instanceof Error ? requesterError.message : String(requesterError)
      });
    }

    // 8. Execute with streaming. Caller scopes (role-derived) are needed for
    // agentic tool resolution; harmless to compute for prompt-chain mode too.
    const callerRoleNames = currentUserData.roles.map(r => r.name);

    // Resolve the architect owner's Cognito sub (REV-COR-181). assistantOwnerSub is
    // matched against users.cognito_sub by knowledge retrieval / repository tools, so
    // the previous String(architect.userId) (a numeric id) never matched and silently
    // disabled owner-repository access on non-owner executions. Only look it up when
    // the executor is not the owner — owner === executor is already covered by
    // userCognitoSub = session.sub.
    let assistantOwnerSub: string | undefined;
    if (architect.userId != null && architect.userId !== userId) {
      const ownerRow = await getUserById(architect.userId);
      assistantOwnerSub = ownerRow?.cognitoSub ?? undefined;
    }

    const context: PromptExecutionContext = {
      previousOutputs: new Map(),
      accumulatedMessages: [],
      executionId,
      userCognitoSub: session.sub,
      assistantOwnerSub,
      userId,
      executionStartTime: Date.now(),
      assistantId: toolId,
      atriumRequester,
      conversation: nexusConversationId ? {
        conversationId: nexusConversationId,
        assistantId: toolId,
        assistantName: architect.name,
      } : undefined,
      caller: {
        scopes: getScopesForRoles(callerRoleNames),
        roleNames: callerRoleNames,
        idToken: session.idToken,
      },
    };

    // Run execution + build the SSE stream response; on a pre-stream failure the
    // helper rolls back the execution row and re-throws to the outer catch.
    return await runExecutionAndBuildResponse({
      architect,
      prompts,
      inputs,
      context,
      executionId,
      toolId,
      userId,
      nexusConversationId,
      approveDestructiveTools: approveDestructiveTools === true,
      requestId,
      log,
    });

  } catch (error) {
    // Issue #657/#835: Handle ContentSafetyBlockedError at warn level (expected behavior)
    if (error instanceof ContentSafetyBlockedError) {
      log.warn('Content blocked by safety guardrails', {
        error: { message: error.message, name: error.name },
        categories: error.blockedCategories,
        source: error.source
      });
      timer({ status: 'blocked' });
      return new Response(
        JSON.stringify({
          error: error.message,
          code: 'CONTENT_BLOCKED',
          categories: error.blockedCategories,
          source: error.source,
          requestId
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': requestId
          }
        }
      );
    }

    log.error('Assistant architect execution error', {
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });

    timer({ status: 'error' });

    return new Response(
      JSON.stringify({
        error: 'Failed to execute assistant architect',
        message: error instanceof Error ? error.message : 'Unknown error',
        requestId
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      }
    );
  }
}

/** Resolved value of executeSinglePromptWithCompletion (UI stream or undefined). */
type SinglePromptResult = Awaited<ReturnType<typeof executeSinglePromptWithCompletion>>;

/**
 * Execute every prompt at one position IN PARALLEL. On any rejection, logs the
 * failed prompt ids (mapped positionally to the original prompts) and throws a
 * wrapped sysInternalError. On success, returns the UI stream response from the
 * prompt explicitly marked for UI streaming (only one is), or undefined.
 * Behavior matches the original inline `if (isParallel)` branch exactly.
 */
async function executeParallelPositionGroup(args: {
  promptsAtPosition: ChainPrompt[];
  position: number;
  isLastPosition: boolean;
  inputs: Record<string, unknown>;
  context: PromptExecutionContext;
  requestId: string;
  log: ReturnType<typeof createLogger>;
  totalPrompts: number;
}): Promise<SinglePromptResult> {
  const { promptsAtPosition, position, isLastPosition, inputs, context, requestId, log, totalPrompts } = args;

  // Validate parallelGroup field usage
  const uniqueGroups = new Set(promptsAtPosition.map(p => p.parallelGroup).filter(g => g !== null));
  if (uniqueGroups.size > 1) {
    log.warn('Multiple parallel groups at same position - not yet supported', {
      position,
      groups: Array.from(uniqueGroups),
      promptIds: promptsAtPosition.map(p => p.id)
    });
  }

  const parallelPromises = promptsAtPosition.map((prompt, idx) =>
    executeSinglePromptWithCompletion({
      prompt,
      inputs,
      context,
      requestId,
      log,
      totalPrompts,
      // First prompt in last position gets stream response for UI
      isLastPrompt: isLastPosition && idx === 0
    })
  );

  // Wait for ALL prompts at this position to complete
  const results = await Promise.allSettled(parallelPromises);

  // Check for failures
  const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  if (failures.length > 0) {
    const firstError = failures[0].reason;
    // Map failures back to their ORIGINAL prompt by index into `results`
    // (which is positionally aligned with `promptsAtPosition`). Indexing
    // `promptsAtPosition` by the filtered `failures` index would mis-attribute
    // IDs when an earlier prompt succeeded. (Correctness review.)
    const failedPromptIds = results
      .map((r, idx) => (r.status === 'rejected' ? promptsAtPosition[idx]?.id : undefined))
      .filter((id): id is number => typeof id === 'number');

    log.error('Parallel prompt execution failed', {
      position,
      failureCount: failures.length,
      failedPromptIds,
      errors: failures.map(f => {
        const errMsg = f.reason instanceof Error ? f.reason.message : String(f.reason);
        return errMsg.length > 200 ? errMsg.substring(0, 197) + '...' : errMsg;
      })
    });

    // Wrap error in ErrorFactory for consistent error handling
    const firstErrorMsg = firstError instanceof Error ? firstError.message : String(firstError);
    const truncatedMsg = firstErrorMsg.length > 200 ? firstErrorMsg.substring(0, 197) + '...' : firstErrorMsg;

    throw ErrorFactories.sysInternalError(
      `${failures.length} of ${promptsAtPosition.length} parallel prompt(s) failed at position ${position}: ${truncatedMsg}`,
      {
        details: {
          position,
          failureCount: failures.length,
          totalPrompts: promptsAtPosition.length,
          failedPromptIds
        },
        cause: firstError instanceof Error ? firstError : undefined
      }
    );
  }

  // Extract successful stream responses
  const successResults = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<SinglePromptResult>[];
  // Find the result explicitly marked for UI streaming (isLastPosition && idx === 0)
  // Only one parallel prompt gets isLastPrompt=true, so only one result has value !== undefined
  const uiStreamResult = successResults.find(r => r.value !== undefined);
  const lastStreamResponse: SinglePromptResult = uiStreamResult?.value;

  // Verify UI stream was assigned for last position
  if (isLastPosition && !lastStreamResponse) {
    throw ErrorFactories.sysInternalError(
      'Failed to assign UI stream response from last parallel group',
      {
        details: {
          position,
          successfulPrompts: successResults.length,
          totalPrompts: promptsAtPosition.length
        }
      }
    );
  }

  return lastStreamResponse;
}

/**
 * Execute a chain of prompts with support for parallel and sequential execution
 * - Prompts at same position execute in parallel using Promise.all()
 * - Prompts at different positions execute sequentially (position 0, then 1, then 2, etc.)
 * - Includes event emission for fine-grained progress tracking
 */
async function executePromptChain(
  prompts: ChainPrompt[],
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>
) {
  log.info('Starting prompt chain execution', {
    promptCount: prompts.length,
    executionId: context.executionId
  });

  // Group prompts by position for parallel/sequential execution
  const positionGroups = new Map<number, ChainPrompt[]>();
  for (const prompt of prompts) {
    const position = prompt.position;
    if (!positionGroups.has(position)) {
      positionGroups.set(position, []);
    }
    positionGroups.get(position)!.push(prompt);
  }

  // Sort positions to execute in order (0, 1, 2, ...)
  const sortedPositions = Array.from(positionGroups.keys()).sort((a, b) => a - b);

  log.info('Prompt execution plan', {
    totalPrompts: prompts.length,
    positions: sortedPositions.length,
    positionDetails: sortedPositions.map(pos => ({
      position: pos,
      promptCount: positionGroups.get(pos)!.length,
      prompts: positionGroups.get(pos)!.map(p => ({ id: p.id, name: p.name }))
    }))
  });

  let lastStreamResponse;

  // Execute each position sequentially
  for (const position of sortedPositions) {
    const promptsAtPosition = positionGroups.get(position)!;
    const isParallel = promptsAtPosition.length > 1;

    log.info('Executing position group', {
      position,
      promptCount: promptsAtPosition.length,
      isParallel,
      prompts: promptsAtPosition.map(p => ({ id: p.id, name: p.name }))
    });

    if (isParallel) {
      // Execute prompts at this position in parallel (extracted helper preserves
      // the exact failure handling and UI-stream selection).
      const isLastPosition = position === sortedPositions[sortedPositions.length - 1];
      const parallelStreamResponse = await executeParallelPositionGroup({
        promptsAtPosition,
        position,
        isLastPosition,
        inputs,
        context,
        requestId,
        log,
        totalPrompts: prompts.length
      });
      if (parallelStreamResponse) {
        lastStreamResponse = parallelStreamResponse;
      }

    } else {
      // Single prompt at this position - execute sequentially
      const prompt = promptsAtPosition[0];
      const isLastPrompt = position === sortedPositions[sortedPositions.length - 1] && promptsAtPosition.length === 1;

      const streamResponse = await executeSinglePromptWithCompletion({
        prompt,
        inputs,
        context,
        requestId,
        log,
        totalPrompts: prompts.length,
        isLastPrompt
      });

      if (streamResponse) {
        lastStreamResponse = streamResponse;
      }
    }
  }

  if (!lastStreamResponse) {
    throw ErrorFactories.sysInternalError('No stream response generated', {
      details: { promptCount: prompts.length, executionId: context.executionId }
    });
  }

  return lastStreamResponse;
}

/**
 * Derive per-token USD cost rates from a model row's per-1k-token numeric
 * columns (stored as strings). Returns null when either rate is missing/invalid,
 * which makes the cost cap a no-op for that model (the maxSteps bound still
 * applies). (Issue #926.)
 */
function buildCostRates(
  modelData: { inputCostPer1kTokens?: string | null; outputCostPer1kTokens?: string | null }
): { inputPerToken: number; outputPerToken: number } | null {
  // A cost cap needs COMPLETE pricing. Parse each rate; a missing/blank/non-finite/
  // negative column yields null ("unknown"). If EITHER rate is unknown we cannot
  // compute an accurate per-step cost — treating the unknown side as 0 would
  // UNDER-count (e.g. a model with priced input but a null output column would let
  // the cap never trip). Return null so the cap is simply not enforced (the
  // maxSteps/timeout bounds still apply) rather than silently under-counting.
  // (Correctness review — corrects the earlier "missing => 0" behavior.)
  const parseRate = (raw: string | null | undefined): number | null => {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const inPer1k = parseRate(modelData.inputCostPer1kTokens);
  const outPer1k = parseRate(modelData.outputCostPer1kTokens);
  if (inPer1k === null || outPer1k === null) return null;
  // A genuinely free model (both rates 0) has no cost to cap.
  if (inPer1k === 0 && outPer1k === 0) return null;
  return { inputPerToken: inPer1k / 1000, outputPerToken: outPer1k / 1000 };
}

/** The agentic-mode fields read off the architect row (Issue #926). */
interface AgenticArchitectFields {
  name: string;
  mode?: AssistantArchitectMode | null;
  agentEnabledTools?: string[] | null;
  agentEnabledConnectors?: string[] | null;
  agentMaxSteps?: number | null;
  agentTimeoutSeconds?: number | null;
  agentCostCapCents?: number | null;
  agentMaxRequestsPerHour?: number | null;
}

/**
 * Build the initial user message for an agentic run from the form inputs plus
 * any author-defined prompt content (used as upfront context / task framing). The
 * model then decides which tools to call and continues until done.
 */
function buildAgenticInitialMessage(
  prompts: ChainPrompt[],
  inputs: Record<string, unknown>
): { systemPrompt?: string; userText: string } {
  // The lowest-position prompt's systemContext seeds the system prompt; its
  // content frames the task. Remaining prompts are appended as additional
  // context so an author migrating a chain keeps their authored guidance.
  const ordered = [...prompts].sort((a, b) => a.position - b.position);
  const systemPrompt = ordered.find(p => p.systemContext)?.systemContext || undefined;

  const taskParts: string[] = [];
  for (const p of ordered) {
    const substituted = substituteVariables(p.content, inputs, new Map(), (p.inputMapping || {}) as Record<string, string>);
    if (substituted.trim()) taskParts.push(substituted.trim());
  }

  // Format each value for the model. Objects/arrays are JSON-serialized (rather
  // than coerced to the useless "[object Object]") so the model can reason over
  // their structure; everything else is stringified. Values are truncated; keys
  // come from the assistant's own schema (not user-controlled at run time).
  const formatInputValue = (v: unknown): string => {
    if (typeof v === 'string') return v.slice(0, 2000);
    if (v !== null && typeof v === 'object') {
      try {
        return JSON.stringify(v).slice(0, 2000);
      } catch {
        return String(v).slice(0, 2000);
      }
    }
    return String(v).slice(0, 2000);
  };
  const inputLines = Object.entries(inputs)
    .map(([k, v]) => `- ${String(k)}: ${formatInputValue(v)}`)
    .join('\n');

  const userText = [
    taskParts.join('\n\n'),
    inputLines ? `\n\nUser inputs:\n${inputLines}` : '',
  ].join('').trim() || 'Begin.';

  return { systemPrompt, userText };
}

/** Usage shape passed to the streaming onFinish callback. */
interface AgenticFinishUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  totalCost?: number;
}

/**
 * Finalize a completed agentic run: persist the final output as a prompt_result,
 * save the assistant message to the conversation, mark the execution completed,
 * and reconcile conversation stats. Extracted from onFinish to keep that callback
 * lean. Throws on a fatal persistence failure (caller rejects + cleans up).
 */
async function persistAgenticResult(args: {
  context: PromptExecutionContext;
  drivingPromptId: number;
  agentStartTime: number;
  text: string;
  usage?: AgenticFinishUsage;
  finishReason: string;
  steps: Array<{ toolCalls?: unknown[] }>;
  /** Per-token USD rates used by the in-loop cost cap; null = model unpriced. */
  costRates: { inputPerToken: number; outputPerToken: number } | null;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const { context, drivingPromptId, agentStartTime, text, usage, finishReason, steps, costRates, log } = args;
  const executionTimeMs = Date.now() - agentStartTime;
  const toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0);
  // Persist the run's estimated spend (#926 — epic #922 completion audit): the
  // cap was enforced in-loop but the actual cost was never recorded for audit /
  // reconciliation. Same rates and formula as the adapter's cost predicate.
  // Null when the model is unpriced or usage was not reported.
  const estimatedCostCents =
    costRates && usage
      ? Math.round(
          (usage.promptTokens * costRates.inputPerToken +
            usage.completionTokens * costRates.outputPerToken) * 100
        )
      : null;
  log.info('Agentic execution finished', {
    executionId: context.executionId,
    estimatedCostCents,
    finishReason,
    steps: steps.length,
    toolCalls: toolCallCount,
    hasText: !!text,
  });

  // Persist the final output as a single prompt_result attributed to the driving
  // prompt. Per-tool detail lives in the events table (the audit sink).
  const promptInputData = {
    mode: 'agentic',
    toolCalls: toolCallCount,
    steps: steps.length,
    // Estimated run cost in cents (null when unpriceable) — queryable per-run
    // spend for audit/reconciliation (#926).
    estimatedCostCents,
  };
  // Bind every value as a parameter (never sql.raw + manual escaping, which is
  // fragile and bypasses Drizzle's parameterization). The jsonb and enum casts
  // are applied to bound placeholders so untrusted-shaped data can't break out.
  await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, started_at, completed_at, execution_time_ms)
      VALUES (${context.executionId}, ${drivingPromptId}, ${JSON.stringify(promptInputData)}::jsonb, ${text}, ${'completed'}::execution_status, ${new Date(agentStartTime).toISOString()}::timestamp, ${new Date().toISOString()}::timestamp, ${executionTimeMs})
    `),
    'saveAgenticResult'
  );

  // Save the assistant message to the nexus conversation for resumption.
  if (context.conversation) {
    try {
      const metadata: AssistantArchitectMessageMetadata = {
        source: 'assistant-architect-execution',
        executionId: context.executionId,
        promptId: drivingPromptId,
        promptName: 'Agentic run',
        position: 0,
        executionTimeMs,
      };
      await createMessageWithStats({
        conversationId: context.conversation.conversationId,
        role: 'assistant',
        content: text,
        parts: [{ type: 'text', text }],
        tokenUsage: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        } : undefined,
        metadata: metadata as unknown as Record<string, unknown>,
      });
    } catch (msgErr) {
      log.error('Failed to save agentic result as conversation message', {
        error: msgErr instanceof Error ? msgErr.message : String(msgErr),
        executionId: context.executionId,
      });
    }
  }

  // Mark execution completed + emit completion event.
  await executeQuery(
    (db) => db.execute(sql`
      UPDATE tool_executions
      SET status = 'completed', completed_at = ${new Date().toISOString()}::timestamp
      WHERE id = ${context.executionId}
    `),
    'updateAgenticExecutionCompleted'
  );
  await storeExecutionEvent(context.executionId, 'execution-complete', {
    executionId: context.executionId,
    totalTokens: usage?.totalTokens || 0,
    estimatedCostCents,
    duration: Date.now() - context.executionStartTime,
    success: true,
  }).catch(err => log.error('Failed to store agentic execution-complete event', { error: err }));

  if (context.conversation) {
    try {
      const existing = await getConversationById(context.conversation.conversationId, context.userId);
      await updateConversation(context.conversation.conversationId, context.userId, {
        metadata: {
          ...existing.metadata,
          ...buildExecutionMetadata(context.conversation.assistantId, context.conversation.assistantName, context.executionId, 'completed'),
        },
      });
      await updateConversationStats(context.conversation.conversationId);
    } catch (err) {
      log.error('Failed to finalize agentic conversation', {
        error: err instanceof Error ? err.message : String(err),
        executionId: context.executionId,
      });
    }
  }
}

/**
 * Mark an agentic execution as failed when the stream errors after starting.
 * Best-effort: updates tool_executions, emits execution-error, and reconciles
 * the conversation status. Never throws (it runs on an already-failing path).
 */
async function markAgenticExecutionFailed(
  context: PromptExecutionContext,
  error: unknown,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  try {
    await executeQuery(
      (db) => db.execute(sql`
        UPDATE tool_executions
        SET status = 'failed', error_message = ${errMsg}, completed_at = ${new Date().toISOString()}::timestamp
        WHERE id = ${context.executionId}
      `),
      'markAgenticExecutionFailed'
    );
  } catch (dbErr) {
    log.error('Failed to mark agentic execution failed', {
      error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      executionId: context.executionId,
    });
  }
  await storeExecutionEvent(context.executionId, 'execution-error', {
    executionId: context.executionId,
    error: errMsg,
    recoverable: false,
  }).catch(err => log.error('Failed to store agentic execution-error event', { error: err }));
  if (context.conversation) {
    try {
      const existing = await getConversationById(context.conversation.conversationId, context.userId);
      await updateConversation(context.conversation.conversationId, context.userId, {
        metadata: {
          ...existing.metadata,
          ...buildExecutionMetadata(context.conversation.assistantId, context.conversation.assistantName, context.executionId, 'failed'),
        },
      });
      await updateConversationStats(context.conversation.conversationId);
    } catch (convErr) {
      log.error('Failed to mark agentic conversation failed', {
        error: convErr instanceof Error ? convErr.message : String(convErr),
        executionId: context.executionId,
      });
    }
  }
}

/**
 * Persist one tool-invocation audit event (Issue #926). Reuses the existing
 * tool-execution-complete event (no new assistant_event_type enum value —
 * migration 082 deliberately avoided ALTER TYPE). A destructive tool gated for
 * confirmation rides as success:false with a `confirmationRequired` marker in
 * `result`, so the audit/timeline distinguishes it from a real failure.
 */
function storeToolInvocationEvent(
  executionId: number,
  promptId: number,
  event: ToolInvocationAudit
): Promise<void> {
  return storeExecutionEvent(executionId, 'tool-execution-complete', {
    promptId,
    toolName: event.toolName,
    success: event.ok,
    error: event.error,
    result: {
      toolIdentifier: event.toolIdentifier,
      args: event.args,
      durationMs: event.durationMs,
      userId: event.userId,
      ...(event.confirmationRequired ? { confirmationRequired: true } : {}),
    },
  });
}

/**
 * Execute an assistant in AGENTIC mode (Issue #926): a model loop with tool
 * access. Tools are resolved from the unified catalog (#924, internal surface,
 * agentCallable only) + per-user MCP connectors (#774), intersected with the
 * caller's scopes. The loop is bounded by per-run step/timeout/cost limits.
 *
 * Returns the stream response (UI message stream) once streaming starts; result
 * persistence, tool-invocation audit, and connector cleanup happen in onFinish/
 * onError so clients are never closed while tool calls are in flight.
 */
async function executeAgenticAssistant(args: {
  architect: AgenticArchitectFields;
  prompts: ChainPrompt[];
  inputs: Record<string, unknown>;
  context: PromptExecutionContext;
  requestId: string;
  log: ReturnType<typeof createLogger>;
  /** Per-run approval to execute destructive agent tools (Issue #926). */
  approveDestructiveTools: boolean;
}) {
  const { architect, prompts, inputs, context, requestId, log, approveDestructiveTools } = args;
  log.info('Starting agentic assistant execution', {
    executionId: context.executionId,
    approveDestructiveTools,
  });

  if (!context.caller) {
    throw ErrorFactories.sysInternalError('Agentic execution requires caller context', {
      details: { executionId: context.executionId }
    });
  }

  // Resolve run limits (defaults + clamp to ceilings; DB also CHECK-constrains).
  const limits = resolveAgentRunLimits({
    agentMaxSteps: architect.agentMaxSteps,
    agentTimeoutSeconds: architect.agentTimeoutSeconds,
    agentCostCapCents: architect.agentCostCapCents,
  });

  const config: AgenticConfig = {
    enabledToolIdentifiers: Array.isArray(architect.agentEnabledTools) ? architect.agentEnabledTools : [],
    enabledConnectorIds: Array.isArray(architect.agentEnabledConnectors) ? architect.agentEnabledConnectors : [],
    maxSteps: limits.maxSteps,
    timeoutSeconds: limits.timeoutSeconds,
    costCapCents: limits.costCapCents,
  };

  // The model uses the first configured prompt for a model id; agentic mode still
  // requires a model to drive the loop.
  const orderedPrompts = [...prompts].sort((a, b) => a.position - b.position);
  const drivingPrompt = orderedPrompts[0];
  if (!drivingPrompt || !drivingPrompt.modelId) {
    throw ErrorFactories.sysInternalError('Agentic assistant has no model configured', {
      details: { executionId: context.executionId }
    });
  }
  const modelData = await getAIModelById(drivingPrompt.modelId);
  if (!modelData || !modelData.modelId || !modelData.provider) {
    throw ErrorFactories.dbRecordNotFound('ai_models', drivingPrompt.modelId, {
      details: { executionId: context.executionId }
    });
  }

  // Tool-invocation audit sink — persists one tool-execution-complete event per
  // invocation (extracted to a module-level helper to keep this function lean).
  const onToolInvocation = (event: ToolInvocationAudit) =>
    storeToolInvocationEvent(context.executionId, drivingPrompt.id, event);

  // Resolve tools (catalog ∩ caller scopes ∩ author allow-list, + connectors).
  const resolved = await resolveAgentTools({
    enabledToolIdentifiers: config.enabledToolIdentifiers,
    enabledConnectorIds: config.enabledConnectorIds,
    caller: {
      userId: context.userId,
      cognitoSub: context.userCognitoSub,
      scopes: context.caller.scopes,
      roleNames: context.caller.roleNames,
      idToken: context.caller.idToken,
    },
    requestId,
    approveDestructive: approveDestructiveTools,
    onToolInvocation,
  });

  log.info('Agentic tools resolved', {
    executionId: context.executionId,
    granted: resolved.grantedToolIdentifiers.length,
    denied: resolved.deniedToolIdentifiers.length,
    connectorTools: resolved.connectorResults.length,
    maxSteps: config.maxSteps,
  });

  const { systemPrompt, userText } = buildAgenticInitialMessage(orderedPrompts, inputs);
  // Image understanding (#926): attach any image-valued inputs (data:image URIs or
  // image URLs) as file parts so vision-capable models can see them. The author is
  // responsible for selecting a vision-capable model.
  const imageParts = extractImageInputParts(inputs);
  if (imageParts.length > 0) {
    log.info('Attaching image inputs to agentic run', {
      executionId: context.executionId,
      imageCount: imageParts.length,
    });
  }
  const userMessage: UIMessage = {
    id: `agentic-${context.executionId}-${Date.now()}`,
    role: 'user',
    parts: [{ type: 'text', text: userText }, ...imageParts],
  };

  const agentStartTime = Date.now();
  // Hoisted so onFinish can persist the run's estimated cost with the SAME rates
  // the in-loop cap used. When the author configured a cap but the model has no
  // complete pricing, the cap is unenforceable — say so loudly (structured warn →
  // CloudWatch) instead of silently skipping it (epic #922 completion audit).
  const costRates = buildCostRates(modelData);
  if (typeof config.costCapCents === 'number' && config.costCapCents > 0 && costRates === null) {
    log.warn('Agentic cost cap configured but NOT enforceable: model has no complete pricing', {
      executionId: context.executionId,
      assistantName: architect.name,
      modelId: String(modelData.modelId),
      costCapCents: config.costCapCents,
    });
  }
  const connectorResults: McpConnectorToolsResult[] = resolved.connectorResults;
  let cleanedUp = false;
  const cleanupConnectors = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await closeAgentConnectorClients(connectorResults, requestId);
  };

  return new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined>((resolve, reject) => {
    const streamRequest: StreamRequest = {
      messages: [userMessage],
      modelId: String(modelData.modelId),
      provider: String(modelData.provider),
      userId: context.userId.toString(),
      sessionId: context.userCognitoSub,
      source: 'assistant_execution' as const,
      systemPrompt,
      // Pre-resolved tool set (catalog + connectors). maxSteps drives the loop.
      tools: Object.keys(resolved.tools).length > 0 ? resolved.tools : undefined,
      maxSteps: config.maxSteps,
      // Per-run cost cap (#926): the streaming adapter stops the loop once the
      // estimated cost reaches the cap. Rates come from the model row (per-1k →
      // per-token). Skipped when the model has no cost data or no cap is set.
      costCapCents: config.costCapCents,
      costRates,
      timeout: config.timeoutSeconds * 1000,
      callbacks: {
        // onFinish/onError run asynchronously AFTER the HTTP response has already
        // started streaming to the client (the outer promise resolves as soon as
        // the stream starts — see the IIFE below). They finalize persistence and
        // clean up connectors in the background; they must NOT settle the outer
        // promise (doing so blocked the response until the whole loop finished).
        onFinish: async ({ text, usage, finishReason, steps }) => {
          try {
            await persistAgenticResult({
              context, drivingPromptId: drivingPrompt.id, agentStartTime,
              text: text || '', usage, finishReason, steps: steps || [], costRates, log,
            });
          } catch (saveError) {
            log.error('Failed to finalize agentic execution', { error: saveError, executionId: context.executionId });
          } finally {
            // Close MCP clients AFTER the stream finished (never in a sync finally
            // around the stream itself — clients must stay open while tools run).
            await cleanupConnectors();
          }
        },
        onError: async (error) => {
          await cleanupConnectors();
          log.error('Agentic streaming error', { error, executionId: context.executionId });
          // Mark the execution failed so the row doesn't linger as 'running'
          // (the route-level catch only runs for synchronous pre-stream errors;
          // a post-stream onError otherwise left tool_executions stuck). (PR review.)
          await markAgenticExecutionFailed(context, error, log);
        },
      },
    };

    // Resolve the outer promise as soon as the stream STARTS — not when the agent
    // loop finishes. This lets the route return toUIMessageStreamResponse() and
    // stream tokens to the client in real time, and avoids gateway timeouts on
    // long agentic runs. Persistence/cleanup happen later in onFinish/onError.
    (async () => {
      try {
        const streamResponse = await unifiedStreamingService.stream(streamRequest);
        resolve(streamResponse);
      } catch (error) {
        await cleanupConnectors();
        log.error('Failed to start agentic stream', { error, executionId: context.executionId });
        reject(error);
      }
    })().catch(async (error) => {
      await cleanupConnectors();
      reject(error);
    });
  });
}

/** Grouped options for a single prompt-chain execution and its sub-steps. */
interface SinglePromptOptions {
  prompt: ChainPrompt;
  inputs: Record<string, unknown>;
  context: PromptExecutionContext;
  requestId: string;
  log: ReturnType<typeof createLogger>;
  totalPrompts: number;
  isLastPrompt: boolean;
}

/**
 * Steps 4-5: resolve the prompt's AI model row (throwing dbRecordNotFound when
 * missing/invalid) and build the per-prompt tool set (repository search tools
 * when repositories are configured). Returns the model id/provider strings, the
 * enabledTools list, and the resolved tools object. Throws/validates identically
 * to the original inline blocks. Caller guarantees prompt.modelId is non-null.
 */
async function resolvePromptModelAndTools(
  prompt: ChainPrompt,
  modelDbId: number,
  context: PromptExecutionContext,
  log: ReturnType<typeof createLogger>
): Promise<{ modelId: string; provider: string; enabledTools: string[]; promptTools: ToolSet }> {
  // 4. Get AI model configuration
  const modelData = await getAIModelById(modelDbId);

  if (!modelData) {
    throw ErrorFactories.dbRecordNotFound('ai_models', prompt.modelId || 'unknown', {
      details: { promptId: prompt.id, modelId: prompt.modelId }
    });
  }

  // Validate model data
  if (!modelData.modelId || !modelData.provider) {
    throw ErrorFactories.dbRecordNotFound('ai_models', prompt.modelId || 'unknown', {
      details: { promptId: prompt.id, modelId: prompt.modelId, reason: 'Invalid model data' }
    });
  }

  const modelId = String(modelData.modelId);
  const provider = String(modelData.provider);

  // 5. Prepare tools for this prompt
  const enabledTools: string[] = [...(prompt.enabledTools || [])];
  let promptTools = {};

  // Create repository search tools if repositories are configured
  if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
    log.debug('Creating repository search tools', {
      promptId: prompt.id,
      repositoryIds: prompt.repositoryIds
    });

    const repoTools = createRepositoryTools({
      repositoryIds: prompt.repositoryIds,
      userCognitoSub: context.userCognitoSub,
      assistantOwnerSub: context.assistantOwnerSub
    });

    // Merge repository tools
    promptTools = { ...promptTools, ...repoTools };
  }

  log.debug('Tools configured for prompt', {
    promptId: prompt.id,
    enabledTools,
    toolCount: Object.keys(promptTools).length,
    tools: Object.keys(promptTools)
  });

  return { modelId, provider, enabledTools, promptTools };
}

/**
 * Step 1: inject repository context if the prompt has repositories configured.
 * Emits the knowledge-retrieval-start / knowledge-retrieved events and returns
 * the formatted context string ('' when no repositories or no chunks). Logic and
 * event ordering are identical to the original inline block.
 *
 * Also appends Atrium content context (Phase 6, Issue #1056): permission-aware
 * retrieval over published Atrium content, gated by the assistant's stored
 * `retrieval_scope` (null scope = off, so default behavior is unchanged) and
 * bounded by the session user's `canView` via `context.atriumRequester` (null
 * requester = skip, fail closed).
 */
async function injectRepositoryKnowledge(
  prompt: ChainPrompt,
  context: PromptExecutionContext,
  requestId: string,
  log: ReturnType<typeof createLogger>
): Promise<string> {
  let repositoryContext = '';
  if (prompt.repositoryIds && prompt.repositoryIds.length > 0) {
    log.debug('Retrieving repository knowledge', {
      promptId: prompt.id,
      repositoryIds: prompt.repositoryIds
    });

    // Emit knowledge-retrieval-start event
    await storeExecutionEvent(context.executionId, 'knowledge-retrieval-start', {
      promptId: prompt.id,
      repositories: prompt.repositoryIds,
      searchType: 'hybrid'
    });

    const knowledgeChunks = await retrieveKnowledgeForPrompt(
      prompt.content,
      prompt.repositoryIds,
      context.userCognitoSub,
      context.assistantOwnerSub,
      {
        maxChunks: 10,
        maxTokens: 4000,
        similarityThreshold: 0.7,
        searchType: 'hybrid',
        vectorWeight: 0.8
      },
      requestId
    );

    if (knowledgeChunks.length > 0) {
      repositoryContext = '\n\n' + formatKnowledgeContext(knowledgeChunks);
      log.debug('Repository context retrieved', {
        promptId: prompt.id,
        chunkCount: knowledgeChunks.length
      });

      // Emit knowledge-retrieved event
      // NOTE: Token estimation uses rough approximation (character count / 4)
      // For precise token counts, consider using js-tiktoken encoder
      const totalTokens = knowledgeChunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

      // Calculate average similarity score (safe due to length > 0 check above)
      const avgRelevance = knowledgeChunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / knowledgeChunks.length;

      await storeExecutionEvent(context.executionId, 'knowledge-retrieved', {
        promptId: prompt.id,
        documentsFound: knowledgeChunks.length,
        relevanceScore: avgRelevance,
        tokens: totalTokens
      });
    }
  }

  // Atrium content-as-context (Phase 6, Issue #1056). Off unless the assistant
  // has a retrieval_scope; skipped when no requester was derivable. Same caps
  // as the repository block; distinct `atrium:<slug>` source labels.
  const atriumHits = await retrieveAtriumKnowledgeForPrompt(
    context.atriumRequester,
    context.assistantId,
    prompt.content,
    { maxChunks: 10, maxTokens: 4000 },
    requestId
  );
  if (atriumHits.length > 0) {
    repositoryContext += '\n\n' + formatAtriumKnowledgeContext(atriumHits);
    log.debug('Atrium content context retrieved', {
      promptId: prompt.id,
      hitCount: atriumHits.length
    });
  }

  return repositoryContext;
}

/**
 * Step 2 (event side-effect): emit the variable-substitution event when any
 * variables were actually used. Extracted to flatten the per-variable branch
 * nesting. Identical substituted-var extraction and event payload to the
 * original inline block.
 */
async function emitVariableSubstitutionEvent(
  prompt: ChainPrompt,
  inputs: Record<string, unknown>,
  context: PromptExecutionContext,
  inputMapping: Record<string, string>,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const substitutedVars: Record<string, string> = {};
  const sourcePrompts: number[] = [];

  // Extract which variables were substituted
  for (const [varName, mappedPath] of Object.entries(inputMapping)) {
    const promptMatch = mappedPath.match(/^prompt_(\d+)\.output$/);
    if (promptMatch) {
      const sourcePromptId = Number.parseInt(promptMatch[1], 10);
      sourcePrompts.push(sourcePromptId);
      const value = context.previousOutputs.get(sourcePromptId);
      if (value) {
        substitutedVars[varName] = String(sanitizeForLogging(value)).substring(0, 500);
        log.debug('Variable substituted from previous output', {
          varName,
          sourcePromptId,
          fullLength: value.length,
          truncated: value.length > 500
        });
      }
    } else if (varName in inputs) {
      const inputValue = String(inputs[varName]);
      substitutedVars[varName] = String(sanitizeForLogging(inputValue)).substring(0, 500);
      if (inputValue.length > 500) {
        log.debug('Variable substituted from input (truncated)', {
          varName,
          fullLength: inputValue.length
        });
      }
    }
  }

  await storeExecutionEvent(context.executionId, 'variable-substitution', {
    promptId: prompt.id,
    variables: substitutedVars,
    sourcePrompts: Array.from(new Set(sourcePrompts))
  });
}

/**
 * onFinish sub-step: persist the successful prompt_result row. Uses the exact
 * same sql.raw() JSONB/ENUM workaround and parameter ordering as the original
 * inline INSERT.
 */
async function savePromptResultRow(args: {
  prompt: ChainPrompt;
  context: PromptExecutionContext;
  processedContent: string;
  repositoryContext: string;
  text: string;
  startedAt: Date;
  executionTimeMs: number;
}): Promise<void> {
  const { prompt, context, processedContent, repositoryContext, text, startedAt, executionTimeMs } = args;
  // JSONB + enum written via bound parameters (postgres.js binds these correctly).
  // The old sql.raw() + manual single-quote escaping was a retired RDS Data API
  // workaround and injection-adjacent for user-influenced processedContent — matches
  // createToolExecutionRecord / persistAgenticResult. REV-DB-023 / REV-SEC-105.
  const promptInputData = {
    originalContent: prompt.content,
    processedContent,
    repositoryContext: repositoryContext ? 'included' : 'none'
  };
  const inputDataJson = JSON.stringify(promptInputData);
  await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, started_at, completed_at, execution_time_ms)
      VALUES (${context.executionId}, ${prompt.id}, ${inputDataJson}::jsonb, ${text}, ${'completed'}::execution_status, ${startedAt.toISOString()}::timestamp, ${new Date().toISOString()}::timestamp, ${executionTimeMs})
    `),
    'savePromptResult'
  );
}

/** Usage shape passed to the prompt-chain onFinish callback. */
interface PromptFinishUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * onFinish sub-step: persist this prompt's output as a Nexus conversation
 * message (#699). Non-fatal — logs and continues on failure. Only runs when a
 * conversation exists. Identical metadata, tokenUsage, and error handling to the
 * original inline block.
 */
async function savePromptConversationMessage(args: {
  prompt: ChainPrompt;
  context: PromptExecutionContext;
  text: string;
  usage: PromptFinishUsage | undefined;
  executionTimeMs: number;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const { prompt, context, text, usage, executionTimeMs, log } = args;
  if (!context.conversation) return;
  try {
    const metadata: AssistantArchitectMessageMetadata = {
      source: 'assistant-architect-execution',
      executionId: context.executionId,
      promptId: prompt.id,
      promptName: prompt.name,
      position: prompt.position,
      executionTimeMs,
    };

    await createMessageWithStats({
      conversationId: context.conversation.conversationId,
      role: 'assistant',
      content: text || '',
      parts: [{ type: 'text', text: text || '' }],
      tokenUsage: usage ? {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      } : undefined,
      metadata: metadata as unknown as Record<string, unknown>,
    });

    log.info('Prompt result saved as conversation message', {
      promptId: prompt.id,
      promptName: prompt.name,
      conversationId: context.conversation.conversationId,
      executionId: context.executionId,
    });
  } catch (msgErr) {
    // Non-fatal: log and continue — prompt_results table still has the data
    log.error('Failed to save prompt result as conversation message', {
      error: msgErr instanceof Error ? msgErr.message : String(msgErr),
      promptId: prompt.id,
      conversationId: context.conversation.conversationId,
      executionId: context.executionId,
    });
  }
}

/**
 * onFinish sub-step (last prompt only): mark the execution completed, emit the
 * execution-complete event, and finalize the conversation (metadata merge +
 * stats reconciliation). Identical writes/order to the original inline
 * `if (isLastPrompt)` block.
 */
async function finalizeExecutionOnLastPrompt(
  context: PromptExecutionContext,
  usage: PromptFinishUsage | undefined,
  totalPrompts: number,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  // CRITICAL: Drizzle's AWS Data API driver has issues with timestamp serialization.
  // Must use raw SQL with db.execute() for reliable parameter binding.
  // See: Issue #599, https://github.com/drizzle-team/drizzle-orm/issues/724
  await executeQuery(
    (db) => db.execute(sql`
      UPDATE tool_executions
      SET status = 'completed', completed_at = ${new Date().toISOString()}::timestamp
      WHERE id = ${context.executionId}
    `),
    'updateToolExecutionCompleted'
  );

  // Emit execution-complete event
  const totalDuration = Date.now() - context.executionStartTime;
  await storeExecutionEvent(context.executionId, 'execution-complete', {
    executionId: context.executionId,
    totalTokens: usage?.totalTokens || 0,
    duration: totalDuration,
    success: true
  }).catch(err => log.error('Failed to store execution-complete event', { error: err }));

  log.info('Execution completed successfully', {
    executionId: context.executionId,
    totalPrompts
  });

  // Update nexus conversation executionStatus to completed
  if (context.conversation) {
    try {
      // Fetch existing metadata and merge to preserve other fields
      const existing = await getConversationById(context.conversation.conversationId, context.userId);
      await updateConversation(context.conversation.conversationId, context.userId, {
        metadata: {
          ...existing.metadata,
          ...buildExecutionMetadata(
            context.conversation.assistantId,
            context.conversation.assistantName,
            context.executionId,
            'completed'
          ),
        },
      });

      // Reconcile message_count and last_message_at (#719)
      // Intermediate createMessageWithStats calls may have failed silently
      // (errors caught as non-fatal), leaving message_count at 0.
      // This single reconciliation call guarantees correct stats.
      await updateConversationStats(context.conversation.conversationId);

      log.info('Conversation stats reconciled after execution', {
        conversationId: context.conversation.conversationId,
        executionId: context.executionId,
      });
    } catch (err) {
      log.error('Failed to complete conversation updates', {
        error: err instanceof Error ? err.message : String(err),
        conversationId: context.conversation.conversationId,
        executionId: context.executionId
      });
    }
  }
}

/**
 * onFinish tail: resolve the outer prompt promise once persistence is done. The
 * last prompt waits for the stream response (so the route can return it) and
 * resolves with it (or rejects if the stream failed); non-last prompts resolve
 * with undefined. Identical control flow to the original inline tail.
 */
async function resolveOnFinish(args: {
  isLastPrompt: boolean;
  streamResponsePromise: Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>>>;
  resolve: (value: Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined) => void;
  reject: (reason?: unknown) => void;
  prompt: ChainPrompt;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const { isLastPrompt, streamResponsePromise, resolve, reject, prompt, log } = args;
  if (!isLastPrompt) {
    resolve(undefined);
    return;
  }
  try {
    const streamResponse = await streamResponsePromise;
    resolve(streamResponse);
  } catch (streamError) {
    // Stream creation failed, propagate error
    log.error('Stream response promise rejected', {
      error: streamError,
      promptId: prompt.id
    });
    reject(streamError);
  }
}

/**
 * The prompt-chain streaming onFinish callback body. Extracted from the inline
 * arrow to keep both the Promise executor and this callback under the
 * complexity/line limits. CAREFULLY preserves the EXACT order of persistence
 * writes (prompt_result row -> previousOutputs -> accumulatedMessages ->
 * prompt-complete event -> conversation message -> last-prompt finalize) and the
 * resolve/reject control flow. Highest-risk path — see #699/#719.
 */
async function runPromptOnFinish(args: {
  options: SinglePromptOptions;
  finish: { text?: string; usage?: PromptFinishUsage; finishReason: string };
  promptStartTime: number;
  promptTimer: ReturnType<typeof startTimer>;
  processedContent: string;
  repositoryContext: string;
  userMessage: UIMessage;
  streamResponsePromise: Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>>>;
  resolve: (value: Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined) => void;
  reject: (reason?: unknown) => void;
}): Promise<void> {
  const {
    options, finish, promptStartTime, promptTimer, processedContent,
    repositoryContext, userMessage, streamResponsePromise, resolve, reject,
  } = args;
  const { prompt, context, totalPrompts, isLastPrompt, log } = options;
  const { text, usage, finishReason } = finish;
  // Compute once and reuse — identical to the original repeated `text || ''` and
  // `text?.length || 0` expressions (both map undefined/'' to the same value).
  const safeText = text || '';
  const outputLength = text?.length || 0;

  log.info('Prompt execution finished', {
    promptId: prompt.id,
    promptName: prompt.name,
    hasText: !!text,
    textLength: outputLength,
    hasUsage: !!usage,
    finishReason,
    executionId: context.executionId
  });

  try {
    // Calculate execution time as milliseconds
    const executionTimeMs = Date.now() - promptStartTime;

    // Log completion
    promptTimer({
      status: 'success',
      tokensUsed: usage?.totalTokens
    });

    // Save prompt result
    if (!text || text.length === 0) {
      log.warn('No text content from prompt execution', { promptId: prompt.id });
    }

    const startedAt = new Date(Date.now() - executionTimeMs);

    await savePromptResultRow({ prompt, context, processedContent, repositoryContext, text: safeText, startedAt, executionTimeMs });

    // Store output for next prompt's variable substitution
    context.previousOutputs.set(prompt.id, safeText);

    // Accumulate messages for context (only include reasonable text)
    const assistantMessage: UIMessage = {
      id: `assistant-${prompt.id}-${Date.now()}`,
      role: 'assistant',
      parts: [{ type: 'text', text: safeText }]
    };
    context.accumulatedMessages.push(userMessage, assistantMessage);

    log.info('Prompt result saved successfully', {
      promptId: prompt.id,
      executionId: context.executionId,
      outputLength,
      executionTimeMs
    });

    // Emit prompt-complete event
    await storeExecutionEvent(context.executionId, 'prompt-complete', {
      promptId: prompt.id,
      outputTokens: usage?.completionTokens || 0,
      duration: executionTimeMs,
      cached: false // TODO: detect if response was cached
    }).catch(err => log.error('Failed to store prompt-complete event', { error: err }));

    // Save prompt result as a Nexus conversation message (#699)
    // Each prompt in the chain gets its own message for later resumption
    await savePromptConversationMessage({ prompt, context, text: safeText, usage, executionTimeMs, log });

    // If this is the last prompt, update execution status to completed
    if (isLastPrompt) {
      await finalizeExecutionOnLastPrompt(context, usage, totalPrompts, log);
    }

    // CRITICAL: Wait for stream response to be ready, then resolve. This ensures
    // no race condition between stream assignment and onFinish (extracted to keep
    // this callback under the complexity limit; control flow is identical).
    await resolveOnFinish({ isLastPrompt, streamResponsePromise, resolve, reject, prompt, log });

  } catch (saveError) {
    log.error('Failed to save prompt result', {
      error: saveError,
      promptId: prompt.id,
      executionId: context.executionId
    });
    // Reject promise on save error
    reject(saveError);
  }
}

/**
 * Handle a prompt-chain prompt failure: emit the execution-error event, persist
 * a failed prompt_result row, save a failure conversation message (non-fatal),
 * then throw the wrapped sysInternalError. Identical side-effects/order to the
 * original inline catch block. Always throws (never returns normally).
 */
async function handlePromptFailure(
  options: SinglePromptOptions,
  promptTimer: ReturnType<typeof startTimer>,
  promptError: unknown
): Promise<never> {
  const { prompt, context, log } = options;
  promptTimer({ status: 'error' });

  log.error('Prompt execution failed', {
    error: promptError,
    promptId: prompt.id,
    promptName: prompt.name,
    executionId: context.executionId
  });

  // Emit execution-error event for prompt failure
  await storeExecutionEvent(context.executionId, 'execution-error', {
    executionId: context.executionId,
    error: promptError instanceof Error ? promptError.message : String(promptError),
    promptId: prompt.id,
    recoverable: false,
    details: promptError instanceof Error ? promptError.stack : undefined
  }).catch(err => log.error('Failed to store prompt error event', { error: err }));

  // Save failed prompt result — JSONB + enum bound as parameters, not sql.raw
  // (REV-DB-023 / REV-SEC-105).
  const now = new Date();
  const failedInputData = { prompt: prompt.content };
  const failedInputJson = JSON.stringify(failedInputData);
  const errorMsg = promptError instanceof Error ? promptError.message : String(promptError);
  await executeQuery(
    (db) => db.execute(sql`
      INSERT INTO prompt_results (execution_id, prompt_id, input_data, output_data, status, error_message, started_at, completed_at)
      VALUES (${context.executionId}, ${prompt.id}, ${failedInputJson}::jsonb, '', ${'failed'}::execution_status, ${errorMsg}, ${now.toISOString()}::timestamp, ${now.toISOString()}::timestamp)
    `),
    'saveFailedPromptResult'
  );

  // Save failed prompt result as a conversation message (#699)
  if (context.conversation) {
    try {
      // Sanitize error message for safe storage (remove file paths, limit length)
      const sanitizedPromptName = String(prompt.name).substring(0, 100).replace(/["&'<>]/g, '');
      const sanitizedError = String(sanitizeForLogging(errorMsg))
        .substring(0, 500)
        .replace(/\/[a-zA-Z0-9/_-]+\/[a-zA-Z0-9/_-]+\.ts/g, '[file]');

      const failureContent = `⚠️ Prompt "${sanitizedPromptName}" failed: ${sanitizedError}`;

      const failureMetadata: AssistantArchitectMessageMetadata = {
        source: 'assistant-architect-execution',
        executionId: context.executionId,
        promptId: prompt.id,
        promptName: prompt.name,
        position: prompt.position,
        failed: true,
        error: sanitizedError,
      };

      await createMessageWithStats({
        conversationId: context.conversation.conversationId,
        role: 'assistant',
        content: failureContent,
        parts: [{ type: 'text', text: failureContent }],
        metadata: failureMetadata as unknown as Record<string, unknown>,
      });
    } catch (msgErr) {
      log.error('Failed to save failed prompt as conversation message', {
        error: msgErr instanceof Error ? msgErr.message : String(msgErr),
        promptId: prompt.id,
        conversationId: context.conversation.conversationId,
      });
    }
  }

  // For now, stop execution on first error
  // Future enhancement: check prompt.stop_on_error field
  throw ErrorFactories.sysInternalError(
    `Prompt ${prompt.id} (${prompt.name}) failed: ${
      promptError instanceof Error ? promptError.message : String(promptError)
    }`,
    {
      details: { promptId: prompt.id, promptName: prompt.name },
      cause: promptError instanceof Error ? promptError : undefined
    }
  );
}

/**
 * Execute a single prompt and wait for completion
 * Returns Promise that resolves when streaming finishes (onFinish callback completes)
 */
async function executeSinglePromptWithCompletion(
  options: SinglePromptOptions
) {
  const { prompt, inputs, context, requestId, log, totalPrompts, isLastPrompt } = options;
  const promptStartTime = Date.now();
  const promptTimer = startTimer(`prompt.${prompt.id}.execution`);

  log.info('Executing prompt', {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    isLastPrompt,
    executionId: context.executionId
  });

  // Emit prompt-start event
  await storeExecutionEvent(context.executionId, 'prompt-start', {
    promptId: prompt.id,
    promptName: prompt.name,
    position: prompt.position,
    totalPrompts,
    modelId: String(prompt.modelId || 'unknown'),
    hasKnowledge: !!(prompt.repositoryIds && prompt.repositoryIds.length > 0),
    hasTools: !!(prompt.enabledTools && prompt.enabledTools.length > 0)
  });

  try {
    // Validate prompt has a model configured
    if (!prompt.modelId) {
      throw ErrorFactories.validationFailed([{
        field: 'modelId',
        message: `Prompt ${prompt.id} (${prompt.name}) has no model configured`
      }], {
        details: { promptId: prompt.id, promptName: prompt.name }
      });
    }

    // 1. Inject repository context if configured
    const repositoryContext = await injectRepositoryKnowledge(prompt, context, requestId, log);

    // 2. Apply variable substitution
    const inputMapping = (prompt.inputMapping || {}) as Record<string, string>;
    const processedContent = substituteVariables(
      prompt.content,
      inputs,
      context.previousOutputs,
      inputMapping
    );

    log.debug('Variables substituted', {
      promptId: prompt.id,
      originalLength: prompt.content.length,
      processedLength: processedContent.length
    });

    // Emit variable-substitution event if variables were used
    if (Object.keys(inputMapping).length > 0 || processedContent !== prompt.content) {
      await emitVariableSubstitutionEvent(prompt, inputs, context, inputMapping, log);
    }

    // 3. Build messages with accumulated context
    const userMessage: UIMessage = {
      id: `prompt-${prompt.id}-${Date.now()}`,
      role: 'user',
      parts: [{ type: 'text', text: processedContent + repositoryContext }]
    };

    const messages = [...context.accumulatedMessages, userMessage];

    // 4-5. Resolve AI model configuration + prepare per-prompt tools
    // (prompt.modelId is narrowed to a number by the guard above)
    const { modelId, provider, enabledTools, promptTools } =
      await resolvePromptModelAndTools(prompt, prompt.modelId, context, log);

    // 6. Wrap streaming in Promise that resolves on completion
    // Use Promise-based pattern to avoid race condition between stream creation and onFinish
    return new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined>((resolve, reject) => {
      // Promise to track when stream response is ready
      // Must handle both resolve AND reject to prevent hanging if IIFE fails
      let resolveStreamResponse!: (value: Awaited<ReturnType<typeof unifiedStreamingService.stream>>) => void;
      let rejectStreamResponse!: (error: Error) => void;
      const streamResponsePromise = new Promise<Awaited<ReturnType<typeof unifiedStreamingService.stream>>>((res, rej) => {
        resolveStreamResponse = res;
        rejectStreamResponse = rej;
      });

      const streamRequest: StreamRequest = {
        messages,
        modelId: String(modelId),
        provider: String(provider),
        userId: context.userId.toString(),
        sessionId: context.userCognitoSub,
        conversationId: undefined, // Assistant architect doesn't use conversations
        source: 'assistant_execution' as const,
        systemPrompt: prompt.systemContext || undefined,
        enabledTools, // Keep for backward compatibility with other tools
        tools: Object.keys(promptTools).length > 0 ? promptTools : undefined, // Repository search tools
        callbacks: {
          onFinish: ({ text, usage, finishReason }) =>
            // Persistence + resolve/reject extracted to keep this callback under
            // the complexity/line limits; order of writes is preserved exactly.
            runPromptOnFinish({
              options,
              finish: { text, usage, finishReason },
              promptStartTime,
              promptTimer,
              processedContent,
              repositoryContext,
              userMessage,
              streamResponsePromise,
              resolve,
              reject,
            }),
          onError: (error) => {
            promptTimer({ status: 'error' });
            log.error('Prompt streaming error', { error, promptId: prompt.id });
            reject(error);
          }
        }
      };

      // 7. Start streaming and make response available to onFinish via Promise
      // Use IIFE to handle async operations without making Promise executor async
      (async () => {
        try {
          const streamResponse = await unifiedStreamingService.stream(streamRequest);

          log.info('Prompt stream started', {
            promptId: prompt.id,
            promptName: prompt.name,
            position: prompt.position
          });

          // Resolve the stream response promise so onFinish can access it
          resolveStreamResponse(streamResponse);

          // DO NOT resolve main promise here - wait for onFinish callback
          // onFinish will call resolve() when streaming completes
        } catch (error) {
          promptTimer({ status: 'error' });
          log.error('Failed to start prompt stream', {
            error,
            promptId: prompt.id
          });
          // CRITICAL: Reject streamResponsePromise to prevent onFinish from hanging
          rejectStreamResponse(error as Error);
          reject(error);
        }
      })().catch(error => {
        // Fallback for synchronous errors not caught by async try-catch
        promptTimer({ status: 'error' });
        log.error('Synchronous error in stream IIFE', {
          error,
          promptId: prompt.id
        });
        rejectStreamResponse(error as Error);
        reject(error);
      });
    });

  } catch (promptError) {
    // Failure side-effects (events, failed prompt_result, failure message) and
    // the wrapped throw are extracted; order/behavior is identical.
    await handlePromptFailure(options, promptTimer, promptError);
  }
}

/**
 * Substitute variable placeholders in prompt content
 *
 * Supports both ${variable} and {{variable}} syntax:
 * - Direct input mapping: ${userInput} or {{userInput}} -> inputs.userInput
 * - Mapped variables: ${topic} with mapping {"topic": "userInput.subject"}
 * - Previous outputs: ${previousAnalysis} with mapping {"previousAnalysis": "prompt_1.output"}
 *
 * Security: Validates content size and placeholder count to prevent DoS attacks
 */
function substituteVariables(
  content: string,
  inputs: Record<string, unknown>,
  previousOutputs: Map<number, string>,
  mapping: Record<string, string>
): string {
  // Validate content size before processing to prevent resource exhaustion
  if (content.length > MAX_PROMPT_CONTENT_SIZE) {
    throw ErrorFactories.validationFailed([{
      field: 'content',
      message: `Prompt content exceeds maximum size of ${MAX_PROMPT_CONTENT_SIZE} characters`
    }]);
  }

  // Decode MDXEditor escapes (\$ \{ \_ &#x24; &amp;#x24;) so the variable regex can match stored content.
  const decodedContent = decodeMdxEditorEscapes(content);

  // Count variable placeholders to prevent DoS via excessive replacements
  const placeholderMatches = decodedContent.match(/\${([\w-]+)}|{{([\w-]+)}}/g);
  const placeholderCount = placeholderMatches ? placeholderMatches.length : 0;

  if (placeholderCount > MAX_VARIABLE_REPLACEMENTS) {
    throw ErrorFactories.validationFailed([{
      field: 'content',
      message: `Too many variable placeholders (${placeholderCount}, maximum ${MAX_VARIABLE_REPLACEMENTS})`
    }]);
  }

  // Match both ${variable} and {{variable}} patterns ([\w-]+ matches hyphenated slugs like ${student-name})
  return decodedContent.replace(/\${([\w-]+)}|{{([\w-]+)}}/g, (match, dollarVar, braceVar) => {
    const varName = dollarVar || braceVar;

    // 1. Check if there's an input mapping for this variable
    if (mapping[varName]) {
      const mappedPath = mapping[varName];

      // Handle prompt output references: "prompt_X.output"
      const promptMatch = mappedPath.match(/^prompt_(\d+)\.output$/);
      if (promptMatch) {
        const promptId = Number.parseInt(promptMatch[1], 10);
        const output = previousOutputs.get(promptId);
        if (output) {
          return output;
        }
      }

      // Handle nested input paths: "userInput.subject"
      const value = resolvePath(mappedPath, { inputs, previousOutputs });
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }

    // 2. Try direct input lookup
    if (varName in inputs) {
      const value = inputs[varName];
      return value !== undefined && value !== null ? String(value) : match;
    }

    // 3. No match found, return original placeholder
    return match;
  });
}

/**
 * Resolve a dot-notation path like "userInput.subject" or "prompt_1.output"
 */
function resolvePath(
  path: string,
  context: { inputs: Record<string, unknown>; previousOutputs: Map<number, string> }
): unknown {
  const parts = path.split('.');
  let current: unknown = context;

  for (const part of parts) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}
