import { z } from 'zod';
import { UIMessage } from 'ai';
import type { ToolSet } from 'ai';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { getAssistantArchitectByIdAction } from '@/actions/db/assistant-architect-actions';
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from '@/lib/logger';
import { getUserById } from '@/lib/db/drizzle';
import { userCanAccessResource, filterAccessibleResourceIds } from '@/lib/db/drizzle/resource-access';
import { executeQuery } from '@/lib/db/drizzle-client';
import { eq, sql } from 'drizzle-orm';
import { assistantArchitects } from '@/lib/db/schema';
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
import { getRoomAssistantAccessContext } from '@/lib/rooms/membership';
import { hasAssistantExecutionFeatureAccess } from '@/lib/rooms/assistant-execution-policy';
import { createRepositoryTools } from '@/lib/tools/repository-tools';
import { getScopesForRoles } from '@/lib/api-keys/scopes';
import {
  resolveAgentTools,
  closeAgentConnectorClients,
  resolveAgentRunLimits,
  extractImageInputParts,
} from '@/lib/agents';
import type { ToolInvocationAudit } from '@/lib/agents';
import type { McpConnectorToolsResult } from '@/lib/mcp/connector-types';
import { createAssistantExecutionConversation } from '@/lib/assistant-architect/execution-conversation';
import { INTERNAL_ASSISTANT_LOOKUP } from '@/lib/assistant-architect/internal-access';
import type {
  AssistantArchitectMode,
  AssistantModelFamily,
  AssistantModelRoutingMode,
} from '@/lib/db/schema/tables/assistant-architects';
import {
  routeAssistantArchitectModel,
  type AssistantArchitectRoutingMetadata,
} from '@/lib/assistant-architect/model-router';
import type { StreamRequest } from '@/lib/streaming/types';
import { ContentSafetyBlockedError } from '@/lib/streaming/types';
import { storeExecutionEvent } from '@/lib/assistant-architect/event-storage';
import { decodeMdxEditorEscapes } from '@/lib/utils/text-sanitizer';
import {
  preflightAssistantRepositoryAccess,
  REPOSITORY_ACCESS_CHANGED_MESSAGE,
} from '@/lib/assistant-architect/repository-access-preflight';
import { resolveAssistantRuntimeRepositoryInputs } from '@/lib/assistant-architect/runtime-repository-inputs';
import { createAgenticRepositoryContext } from '@/lib/assistant-architect/agentic-repository-context';
import { updateConversation, getConversationById } from '@/lib/db/drizzle/nexus-conversations';
import { createMessageWithStats, updateConversationStats } from '@/lib/db/drizzle/nexus-messages';
import type { AssistantArchitectMessageMetadata } from '@/lib/db/types/jsonb';
import {
  buildCostRates,
  conservativeAgenticReservationCents,
  estimateUsageCostCents,
  resolveTrustedAgenticTokenLimits,
} from '@/lib/agents/cost-rates';
import {
  reconcileAgenticCost,
  releaseAgenticCost,
  reserveAgenticCost,
} from '@/lib/agents/cost-budget';
import {
  AGENT_LIMIT_CEILINGS,
} from '@/lib/agents/types';
import {
  createCoordinatedAssistantExecution,
  remainingAssistantExecutionTimeoutMs,
} from '@/lib/assistant-architect/execution-coordinator';

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
  /** Ephemeral repositories resolved from opaque file-input references. */
  runtimeRepositoryIds: number[];
  /** Non-sensitive attachment labels that improve retrieval query relevance. */
  runtimeRepositoryQuery: string;
  executionStartTime: number;
  /** Shared wall-clock deadline established with the execution row. */
  executionDeadlineAt: Date;
  /** The executing assistant's id, for the Atrium retrieval-scope gate (§16.4). */
  assistantId: number;
  modelRoutingMode: AssistantModelRoutingMode;
  modelRoutingFamily: AssistantModelFamily | null;
  modelRoutes: Map<number, AssistantArchitectRoutingMetadata>;
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
  costCapCents: number;
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
type ArchitectAccessSnapshot = Pick<
  LoadedArchitect,
  'id' | 'userId' | 'status'
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

async function loadArchitectPrincipal(
  toolId: number,
  requestId: string,
  log: RouteLogger,
  timer: RouteTimer
): Promise<PhaseResult<{
  session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>;
  currentUserData: CurrentUserData;
  userId: number;
  architect: ArchitectAccessSnapshot;
}>> {
  const session = await getServerSession();
  if (!session) {
    log.warn('Unauthorized request - no session');
    timer({ status: 'error', reason: 'unauthorized' });
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
  }
  log.debug('User authenticated', sanitizeForLogging({ userId: session.sub }));
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess) {
    log.error('Failed to get current user');
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) };
  }
  const [architect] = await executeQuery(
    (db) =>
      db
        .select({
          id: assistantArchitects.id,
          userId: assistantArchitects.userId,
          status: assistantArchitects.status,
        })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, toolId))
        .limit(1),
    'getAssistantExecutionAccessSnapshot'
  );
  if (!architect) {
    log.error('Assistant architect not found', { toolId });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Assistant architect not found', requestId }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  return {
    ok: true,
    value: {
      session,
      currentUserData: currentUser.data,
      userId: currentUser.data.user.id,
      architect,
    },
  };
}

async function authorizeArchitectResource(params: {
  architect: ArchitectAccessSnapshot;
  userId: number;
  toolId: number;
  requestId: string;
  log: RouteLogger;
  sessionSub: string;
}): Promise<
  PhaseResult<{
    accessReason: string;
    featureAccessReason: 'capability' | 'room-assignment';
  }>
> {
  const isOwner = params.architect.userId === params.userId;
  const isAdmin = await hasRole('administrator');
  const isApproved = params.architect.status === 'approved';
  const accessReason = isOwner
    ? 'owner'
    : isAdmin
      ? 'admin'
      : isApproved
        ? 'approved'
        : null;
  if (!accessReason) {
    params.log.warn('User does not have access to this assistant architect', {
      userId: params.userId,
      toolId: params.toolId,
      architectOwnerId: params.architect.userId,
      status: params.architect.status,
      isOwner,
      isAdmin,
      isApproved,
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Access denied',
          message:
            'You do not have permission to execute this assistant architect',
          requestId: params.requestId,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  const [hasCapability, roomAccess] = await Promise.all([
    hasCapabilityAccess('assistant-architect', params.sessionSub),
    getRoomAssistantAccessContext(params.userId, [params.architect.id]),
  ]);
  const hasFeatureAccess = hasAssistantExecutionFeatureAccess({
    hasCapability,
    assistantId: params.architect.id,
    roomAccess,
  });
  if (!hasFeatureAccess) {
    params.log.warn('User does not have assistant-architect feature access', {
      userId: params.userId,
      toolId: params.toolId,
      roomAssigned: roomAccess.assignedAssistantIds.has(
        String(params.architect.id)
      ),
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Access denied',
          message:
            'You do not have permission to use the Assistant Architect tool',
          requestId: params.requestId,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  const canAccessAssistant = await userCanAccessResource(
    params.userId,
    'assistant',
    params.architect.id,
    { ownerUserId: params.architect.userId }
  );
  if (!canAccessAssistant) {
    params.log.warn('User lacks shared resource access for assistant architect', {
      userId: params.userId,
      toolId: params.toolId,
      architectId: params.architect.id,
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'You do not have access to this assistant',
          requestId: params.requestId,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  return {
    ok: true,
    value: {
      accessReason,
      featureAccessReason: hasCapability ? 'capability' : 'room-assignment',
    },
  };
}

async function validateArchitectPrompts(params: {
  architect: LoadedArchitect;
  sessionSub: string;
  userId: number;
  toolId: number;
  requestId: string;
  log: RouteLogger;
}): Promise<PhaseResult<{ prompts: LoadedPrompts }>> {
  const prompts = (params.architect.prompts || []).sort(
    (left, right) => left.position - right.position
  );
  if (prompts.length === 0) {
    params.log.error('No prompts configured for assistant architect', {
      toolId: params.toolId,
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'No prompts configured for this assistant architect',
          requestId: params.requestId,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  if (prompts.length > MAX_PROMPT_CHAIN_LENGTH) {
    params.log.warn('Prompt chain too long', {
      promptCount: prompts.length,
      toolId: params.toolId,
      maxAllowed: MAX_PROMPT_CHAIN_LENGTH,
    });
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Prompt chain too long',
          message: `Maximum ${MAX_PROMPT_CHAIN_LENGTH} prompts allowed per execution`,
          requestId: params.requestId,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  const repositoryAccess = await preflightAssistantRepositoryAccess(
    prompts,
    params.sessionSub
  );
  if (!repositoryAccess.isAllowed) {
    params.log.warn(
      'Assistant execution blocked because repository access changed',
      {
        userId: params.userId,
        toolId: params.toolId,
        repositoryCount: repositoryAccess.repositoryIds.length,
      }
    );
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Access denied',
          message: REPOSITORY_ACCESS_CHANGED_MESSAGE,
          requestId: params.requestId,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  const distinctModelIds =
    (params.architect.modelRoutingMode ?? 'legacy') === 'legacy'
      ? [
          ...new Set(
            prompts
              .map((prompt) => prompt.modelId)
              .filter((id): id is number => typeof id === 'number')
          ),
        ]
      : [];
  if (distinctModelIds.length > 0) {
    const accessibleModelIds = await filterAccessibleResourceIds(
      params.userId,
      'model',
      distinctModelIds
    );
    if (accessibleModelIds.size !== distinctModelIds.length) {
      params.log.warn('User lacks access to a model used by this assistant', {
        userId: params.userId,
        toolId: params.toolId,
        distinctModelIds,
        accessibleModelIds: Array.from(accessibleModelIds),
      });
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: 'Access denied',
            message: 'You do not have access to a model this assistant uses',
            requestId: params.requestId,
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }
  }
  return { ok: true, value: { prompts } };
}

/**
 * Phase (b): authenticate the user and perform the ordinary feature/access
 * preflight. The prompt graph is deliberately not returned as executable state:
 * it is reloaded only after the coordinated execution row has taken the shared
 * assistant lock.
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
  architect: ArchitectAccessSnapshot;
}>> {
  const principal = await loadArchitectPrincipal(
    toolId,
    requestId,
    log,
    timer
  );
  if (!principal.ok) return principal;
  const { session, currentUserData, userId, architect } = principal.value;
  const access = await authorizeArchitectResource({
    architect,
    userId,
    toolId,
    requestId,
    log,
    sessionSub: session.sub,
  });
  if (!access.ok) return access;
  log.info('Authorization granted for assistant architect execution', {
    userId,
    toolId,
    architectOwnerId: architect.userId,
    status: architect.status,
    accessReason: access.value.accessReason,
    featureAccessReason: access.value.featureAccessReason,
  });
  return {
    ok: true,
    value: {
      session,
      currentUserData,
      userId,
      architect,
    },
  };
}

/**
 * Phase (c): lock the assistant, recheck current resource/model grants, apply
 * the agentic rate cap, and create the active execution row in one transaction.
 * Import updates use the same assistant row lock before replacing the graph.
 */
async function createToolExecutionRecord(args: {
  toolId: number;
  userId: number;
  inputs: Record<string, unknown>;
  requestId: string;
  log: RouteLogger;
  timer: RouteTimer;
}): Promise<
  PhaseResult<{ executionId: number; startedAt: Date; deadlineAt: Date }>
> {
  const { toolId, userId, inputs, requestId, log, timer } = args;
  const coordinated = await createCoordinatedAssistantExecution({
    assistantId: toolId,
    userId,
    inputs,
    enforceAgentRateCap: true,
  });
  if (!coordinated.created) {
    const { rateCap } = coordinated;
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

  const { executionId, startedAt, deadlineAt } = coordinated;
  log.info('Tool execution created', { executionId, toolId });
  return {
    ok: true,
    value: { executionId, startedAt, deadlineAt },
  };
}

async function failExecutionDuringSetup(
  executionId: number,
  errorMessage: string
): Promise<void> {
  await executeQuery(
    (db) => db.execute(sql`
      UPDATE tool_executions
         SET status = 'failed',
             completed_at = ${new Date().toISOString()}::timestamp,
             error_message = ${errorMessage}
       WHERE id = ${executionId}
         AND status IN ('pending', 'running')
    `),
    'failToolExecutionDuringSetup'
  );
}

async function loadProtectedExecutionGraph(args: {
  executionId: number;
  toolId: number;
  sessionSub: string;
  userId: number;
  requestId: string;
  log: RouteLogger;
}): Promise<
  PhaseResult<{ architect: LoadedArchitect; prompts: LoadedPrompts }>
> {
  const currentArchitect = await getAssistantArchitectByIdAction(
    args.toolId.toString(),
    INTERNAL_ASSISTANT_LOOKUP
  );
  if (!currentArchitect.isSuccess || !currentArchitect.data) {
    await failExecutionDuringSetup(
      args.executionId,
      'Assistant configuration unavailable after execution start'
    );
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: 'Assistant architect not found',
          requestId: args.requestId,
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  const architect = currentArchitect.data;
  const promptResult = await validateArchitectPrompts({
    architect,
    sessionSub: args.sessionSub,
    userId: args.userId,
    toolId: args.toolId,
    requestId: args.requestId,
    log: args.log,
  });
  if (!promptResult.ok) {
    await failExecutionDuringSetup(
      args.executionId,
      'Assistant configuration failed post-lock validation'
    );
    return promptResult;
  }
  args.log.info(
    'Assistant architect loaded after execution coordination',
    sanitizeForLogging({
      toolId: args.toolId,
      name: architect.name,
      promptCount: promptResult.value.prompts.length,
      userId: args.userId,
    })
  );
  return {
    ok: true,
    value: { architect, prompts: promptResult.value.prompts },
  };
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
 * Resolve the architect owner's Cognito sub (REV-COR-181 / REV-COR-511).
 * assistantOwnerSub is matched against users.cognito_sub by knowledge
 * retrieval / repository tools, so a numeric users.id here never matched and
 * silently disabled owner-repository access on non-owner executions. Only
 * looked up when the executor is not the owner — owner === executor is
 * already covered by userCognitoSub = session.sub. getUserById throws if the
 * owner row is gone (e.g. deleted user) — treat that as no owner sub rather
 * than failing the execution.
 */
async function resolveAssistantOwnerSub(
  architectUserId: number | null | undefined,
  executorUserId: number,
  log: ReturnType<typeof createLogger>
): Promise<string | undefined> {
  if (architectUserId == null || architectUserId === executorUserId) {
    return undefined;
  }
  try {
    return (await getUserById(architectUserId))?.cognitoSub ?? undefined;
  } catch (error) {
    log.warn('Failed to resolve assistant owner sub', {
      userId: architectUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function buildExecuteRouteErrorResponse(
  error: unknown,
  requestId: string,
  log: RouteLogger,
  timer: RouteTimer
): Response {
  if (error instanceof ContentSafetyBlockedError) {
    log.warn('Content blocked by safety guardrails', {
      error: { message: error.message, name: error.name },
      categories: error.blockedCategories,
      source: error.source,
    });
    timer({ status: 'blocked' });
    return new Response(
      JSON.stringify({
        error: error.message,
        code: 'CONTENT_BLOCKED',
        categories: error.blockedCategories,
        source: error.source,
        requestId,
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        },
      }
    );
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    (error.statusCode === 403 || error.statusCode === 404)
  ) {
    const message =
      'userMessage' in error && typeof error.userMessage === 'string'
        ? error.userMessage
        : 'You do not have permission to execute this assistant';
    log.warn('Assistant execution access changed during coordination', {
      statusCode: error.statusCode,
    });
    timer({ status: 'error', reason: 'access_changed' });
    return new Response(
      JSON.stringify({
        error: error.statusCode === 404 ? 'Assistant architect not found' : 'Access denied',
        message,
        requestId,
      }),
      {
        status: error.statusCode,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        },
      }
    );
  }
  log.error('Assistant architect execution error', {
    error:
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : String(error),
  });
  timer({ status: 'error' });
  return new Response(
    JSON.stringify({
      error: 'Failed to execute assistant architect',
      message: error instanceof Error ? error.message : 'Unknown error',
      requestId,
    }),
    {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
    }
  );
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
    const { session, currentUserData, userId } = authorized.value;

    // Runtime file inputs are opaque references to caller-owned ephemeral
    // repositories. Resolve them before creating an execution record so forged,
    // expired, or cross-user references fail without invoking retrieval or a
    // model. Static prompt bindings were already checked above.
    let runtimeRepositoryInputs: Awaited<
      ReturnType<typeof resolveAssistantRuntimeRepositoryInputs>
    >;
    try {
      runtimeRepositoryInputs = await resolveAssistantRuntimeRepositoryInputs(inputs, userId);
    } catch (error) {
      log.warn('Assistant execution blocked by unavailable temporary repository input', {
        userId,
        toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(
        JSON.stringify({
          error: 'Access denied',
          message: 'A temporary repository input is unavailable',
          requestId,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const modelInputs = runtimeRepositoryInputs.modelInputs;

    // 6. Create the tool_execution record (rate-cap guarded for agentic mode)
    const created = await createToolExecutionRecord({
      toolId,
      userId,
      inputs: modelInputs,
      requestId,
      log,
      timer,
    });
    if (!created.ok) return created.response;
    const { executionId, startedAt, deadlineAt } = created.value;

    // The coordinated row now protects this graph from import replacement.
    // Reload after the lock transaction commits so an update that won the race
    // is reflected here; an update that lost observes this active row and
    // returns 409 without mutating the graph.
    const protectedGraph = await loadProtectedExecutionGraph({
      executionId,
      toolId,
      sessionSub: session.sub,
      userId,
      requestId,
      log,
    });
    if (!protectedGraph.ok) return protectedGraph.response;
    const { architect, prompts } = protectedGraph.value;

    // 7. Emit execution-start event
    await storeExecutionEvent(executionId, 'execution-start', {
      executionId,
      totalPrompts: prompts.length,
      toolName: architect.name
    });

    // 7.5. Create nexus conversation for this execution (non-fatal)
    const nexusConversationId = await createAssistantExecutionConversation({
      assistantId: toolId,
      assistantName: architect.name,
      ownerId: userId,
      inputs: modelInputs,
      executionId,
      runtimeRepositoryIds: runtimeRepositoryInputs.repositoryIds,
      references: runtimeRepositoryInputs.references,
      log,
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

    // Owner's cognito_sub for owner-based repository access on non-owner runs
    // (REV-COR-181 / REV-COR-511) — see resolveAssistantOwnerSub.
    const assistantOwnerSub = await resolveAssistantOwnerSub(architect.userId, userId, log);

    const context: PromptExecutionContext = {
      previousOutputs: new Map(),
      accumulatedMessages: [],
      executionId,
      userCognitoSub: session.sub,
      assistantOwnerSub,
      userId,
      runtimeRepositoryIds: runtimeRepositoryInputs.repositoryIds,
      runtimeRepositoryQuery: runtimeRepositoryInputs.queryContext,
      executionStartTime: startedAt.getTime(),
      executionDeadlineAt: deadlineAt,
      assistantId: toolId,
      modelRoutingMode: architect.modelRoutingMode ?? 'legacy',
      modelRoutingFamily: architect.modelRoutingFamily ?? null,
      modelRoutes: new Map(),
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
      inputs: modelInputs,
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
    return buildExecuteRouteErrorResponse(error, requestId, log, timer);
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

/** The agentic-mode fields read off the architect row (Issue #926). */
interface AgenticArchitectFields {
  name: string;
  mode?: AssistantArchitectMode | null;
  modelRoutingMode: AssistantModelRoutingMode;
  modelRoutingFamily: AssistantModelFamily | null;
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
  estimatedCostCents: number;
  modelRouting: AssistantArchitectRoutingMetadata;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const {
    context,
    drivingPromptId,
    agentStartTime,
    text,
    usage,
    finishReason,
    steps,
    estimatedCostCents,
    modelRouting,
    log,
  } = args;
  const executionTimeMs = Date.now() - agentStartTime;
  const toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0);
  // Persist the run's estimated spend (#926 — epic #922 completion audit): the
  // cap was enforced in-loop but the actual cost was never recorded for audit /
  // reconciliation. Same rates and formula as the adapter's cost predicate.
  // Null when the model is unpriced or usage was not reported.
  log.info('Agentic execution finished', {
    executionId: context.executionId,
    estimatedCostCents,
    modelRouting,
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
    modelRouting,
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
        modelRouting: modelRouting as unknown as Record<string, unknown>,
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
        modelId: modelRouting.selectedModelDbId,
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
          modelRouting: [...context.modelRoutes.values()],
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

interface PreparedAgenticRun {
  config: AgenticConfig;
  drivingPrompt: ChainPrompt;
  resolved: Awaited<ReturnType<typeof resolveAgentTools>>;
  effectiveTools: ToolSet;
  effectiveSystemPrompt?: string;
  userMessage: UIMessage;
  modelRoute: Awaited<ReturnType<typeof routeAssistantArchitectModel>>;
}

interface AgenticCostReservation {
  costRates: NonNullable<ReturnType<typeof buildCostRates>>;
  maxOutputTokens: number;
  conservativeReservationCents: number;
  costLeaseId: string;
}

async function prepareAgenticRun(args: {
  architect: AgenticArchitectFields;
  prompts: ChainPrompt[];
  inputs: Record<string, unknown>;
  context: PromptExecutionContext;
  requestId: string;
  log: ReturnType<typeof createLogger>;
  approveDestructiveTools: boolean;
}): Promise<PreparedAgenticRun> {
  if (!args.context.caller) {
    throw ErrorFactories.sysInternalError(
      'Agentic execution requires caller context',
      { details: { executionId: args.context.executionId } }
    );
  }
  const limits = resolveAgentRunLimits({
    agentMaxSteps: args.architect.agentMaxSteps,
    agentTimeoutSeconds: args.architect.agentTimeoutSeconds,
    agentCostCapCents: args.architect.agentCostCapCents,
  });
  const config: AgenticConfig = {
    enabledToolIdentifiers: Array.isArray(args.architect.agentEnabledTools)
      ? args.architect.agentEnabledTools
      : [],
    enabledConnectorIds: Array.isArray(args.architect.agentEnabledConnectors)
      ? args.architect.agentEnabledConnectors
      : [],
    maxSteps: limits.maxSteps,
    timeoutSeconds: limits.timeoutSeconds,
    costCapCents: limits.costCapCents,
  };
  const orderedPrompts = [...args.prompts].sort(
    (left, right) => left.position - right.position
  );
  const drivingPrompt = orderedPrompts[0];
  if (!drivingPrompt?.modelId) {
    throw ErrorFactories.sysInternalError(
      'Agentic assistant has no model configured',
      { details: { executionId: args.context.executionId } }
    );
  }
  const resolved = await resolveAgentTools({
    enabledToolIdentifiers: config.enabledToolIdentifiers,
    enabledConnectorIds: config.enabledConnectorIds,
    caller: {
      userId: args.context.userId,
      cognitoSub: args.context.userCognitoSub,
      scopes: args.context.caller.scopes,
      roleNames: args.context.caller.roleNames,
      idToken: args.context.caller.idToken,
    },
    requestId: args.requestId,
    approveDestructive: args.approveDestructiveTools,
    onToolInvocation: (event) =>
      storeToolInvocationEvent(
        args.context.executionId,
        drivingPrompt.id,
        event
      ),
  });
  const repositoryContext = createAgenticRepositoryContext({
    prompts: orderedPrompts,
    runtimeRepositoryIds: args.context.runtimeRepositoryIds,
    userCognitoSub: args.context.userCognitoSub,
  });
  const effectiveTools: ToolSet = {
    ...resolved.tools,
    ...repositoryContext.tools,
  };
  args.log.info('Agentic tools resolved', {
    executionId: args.context.executionId,
    granted: resolved.grantedToolIdentifiers.length,
    denied: resolved.deniedToolIdentifiers.length,
    connectorTools: resolved.connectorResults.length,
    repositoryCount: repositoryContext.repositoryIds.length,
    maxSteps: config.maxSteps,
  });
  const { systemPrompt, userText } = buildAgenticInitialMessage(
    orderedPrompts,
    args.inputs
  );
  const effectiveSystemPrompt =
    [systemPrompt, repositoryContext.systemGuidance]
      .filter(Boolean)
      .join('\n\n') || undefined;
  const imageParts = extractImageInputParts(args.inputs);
  if (imageParts.length > 0) {
    args.log.info('Attaching image inputs to agentic run', {
      executionId: args.context.executionId,
      imageCount: imageParts.length,
    });
  }
  const userMessage: UIMessage = {
    id: `agentic-${args.context.executionId}-${Date.now()}`,
    role: 'user',
    parts: [{ type: 'text', text: userText }, ...imageParts],
  };
  const modelRoute = await routeAssistantArchitectModel({
    text: userText,
    userId: args.context.userId,
    fallbackModelDbId: drivingPrompt.modelId,
    routingMode: args.context.modelRoutingMode,
    requestedFamily: args.context.modelRoutingFamily,
    requirements: {
      requiredTools: config.enabledToolIdentifiers,
      requiresFunctionCalling: Object.keys(effectiveTools).length > 0,
      requiresVision: imageParts.length > 0,
    },
  });
  args.context.modelRoutes.set(drivingPrompt.id, modelRoute.metadata);
  return {
    config,
    drivingPrompt,
    resolved,
    effectiveTools,
    effectiveSystemPrompt,
    userMessage,
    modelRoute,
  };
}

async function reserveAgenticRunCost(args: {
  run: PreparedAgenticRun;
  architect: AgenticArchitectFields;
  context: PromptExecutionContext;
  requestId: string;
  log: ReturnType<typeof createLogger>;
}): Promise<AgenticCostReservation> {
  const modelData = args.run.modelRoute.model;
  const costRates = buildCostRates(modelData);
  if (costRates === null) {
    args.log.error('Agentic cost cap rejected unpriced model', {
      executionId: args.context.executionId,
      assistantName: args.architect.name,
      modelId: String(modelData.modelId),
      costCapCents: args.run.config.costCapCents,
    });
    await closeAgentConnectorClients(
      args.run.resolved.connectorResults,
      args.requestId
    );
    throw ErrorFactories.invalidInput(
      'modelId',
      String(modelData.modelId),
      'A model with complete input and output pricing is required for agentic execution'
    );
  }
  const tokenLimits = resolveTrustedAgenticTokenLimits(
    modelData,
    AGENT_LIMIT_CEILINGS.maxOutputTokens
  );
  if (tokenLimits === null) {
    await closeAgentConnectorClients(
      args.run.resolved.connectorResults,
      args.requestId
    );
    throw ErrorFactories.invalidInput(
      'modelId',
      String(modelData.modelId),
      'A trusted model context-token ceiling is required for agentic execution'
    );
  }
  const conservativeReservationCents = conservativeAgenticReservationCents(
    args.run.config.costCapCents,
    tokenLimits.contextTokens,
    tokenLimits.maxOutputTokens,
    costRates
  );
  const reservation = await reserveAgenticCost(
    args.context.userId,
    args.context.executionId,
    conservativeReservationCents
  );
  if (!reservation.allowed) {
    await closeAgentConnectorClients(
      args.run.resolved.connectorResults,
      args.requestId
    );
    throw ErrorFactories.invalidInput(
      'costCapCents',
      args.run.config.costCapCents,
      `Agentic Assistant ${reservation.reason.replace('_', ' ')} is exhausted`
    );
  }
  return {
    costRates,
    maxOutputTokens: tokenLimits.maxOutputTokens,
    conservativeReservationCents,
    costLeaseId: reservation.leaseId,
  };
}

function createAgenticCleanup(args: {
  connectorResults: McpConnectorToolsResult[];
  costLeaseId: string;
  executionId: number;
  requestId: string;
  log: ReturnType<typeof createLogger>;
}): () => Promise<void> {
  let cleanedUp = false;
  return async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await closeAgentConnectorClients(
        args.connectorResults,
        args.requestId
      );
    } finally {
      await releaseAgenticCost(args.costLeaseId).catch((error: unknown) => {
        args.log.error('Failed to release agentic cost reservation', {
          executionId: args.executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };
}

function startAgenticStream(args: {
  run: PreparedAgenticRun;
  cost: AgenticCostReservation;
  context: PromptExecutionContext;
  agentStartTime: number;
  requestId: string;
  log: ReturnType<typeof createLogger>;
}) {
  const cleanup = createAgenticCleanup({
    connectorResults: args.run.resolved.connectorResults,
    costLeaseId: args.cost.costLeaseId,
    executionId: args.context.executionId,
    requestId: args.requestId,
    log: args.log,
  });
  const modelData = args.run.modelRoute.model;
  return new Promise<
    Awaited<ReturnType<typeof unifiedStreamingService.stream>> | undefined
  >((resolve, reject) => {
    const streamRequest: StreamRequest = {
      messages: [args.run.userMessage],
      modelId: String(modelData.modelId),
      provider: String(modelData.provider),
      userId: args.context.userId.toString(),
      sessionId: args.context.userCognitoSub,
      source: 'assistant_execution' as const,
      systemPrompt: args.run.effectiveSystemPrompt,
      tools:
        Object.keys(args.run.effectiveTools).length > 0
          ? args.run.effectiveTools
          : undefined,
      maxSteps: args.run.config.maxSteps,
      maxTokens: args.cost.maxOutputTokens,
      costCapCents: args.run.config.costCapCents,
      costRates: args.cost.costRates,
      timeout: Math.min(
        args.run.config.timeoutSeconds * 1000,
        remainingAssistantExecutionTimeoutMs(
          args.context.executionDeadlineAt
        )
      ),
      callbacks: {
        onFinish: async ({ text, usage, finishReason, steps }) => {
          try {
            const estimatedCostCents = usage
              ? estimateUsageCostCents(args.cost.costRates, usage)
              : args.cost.conservativeReservationCents;
            const reconciliation = await reconcileAgenticCost(
              args.cost.costLeaseId,
              estimatedCostCents
            );
            if (!reconciliation.withinDeploymentBudget) {
              args.log.error(
                'Agentic actual cost exceeded the hourly platform budget',
                {
                  executionId: args.context.executionId,
                  deploymentHourlyCostCents:
                    reconciliation.deploymentHourlyCostCents,
                  deploymentBudgetCents: reconciliation.deploymentBudgetCents,
                }
              );
            }
            await persistAgenticResult({
              context: args.context,
              drivingPromptId: args.run.drivingPrompt.id,
              agentStartTime: args.agentStartTime,
              text: text || '',
              usage,
              finishReason,
              steps: steps || [],
              estimatedCostCents,
              modelRouting: args.run.modelRoute.metadata,
              log: args.log,
            });
          } catch (error) {
            args.log.error('Failed to finalize agentic execution', {
              error,
              executionId: args.context.executionId,
            });
          } finally {
            await cleanup();
          }
        },
        onError: async (error) => {
          await cleanup();
          args.log.error('Agentic streaming error', {
            error,
            executionId: args.context.executionId,
          });
          await markAgenticExecutionFailed(args.context, error, args.log);
        },
      },
    };
    void unifiedStreamingService
      .stream(streamRequest)
      .then(resolve)
      .catch(async (error) => {
        await cleanup();
        args.log.error('Failed to start agentic stream', {
          error,
          executionId: args.context.executionId,
        });
        reject(error);
      });
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
  approveDestructiveTools: boolean;
}) {
  args.log.info('Starting agentic assistant execution', {
    executionId: args.context.executionId,
    approveDestructiveTools: args.approveDestructiveTools,
  });
  const run = await prepareAgenticRun(args);
  const cost = await reserveAgenticRunCost({
    run,
    architect: args.architect,
    context: args.context,
    requestId: args.requestId,
    log: args.log,
  });
  return startAgenticStream({
    run,
    cost,
    context: args.context,
    agentStartTime: Date.now(),
    requestId: args.requestId,
    log: args.log,
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

function getPromptRepositoryIds(
  prompt: ChainPrompt,
  context: PromptExecutionContext
): number[] {
  return [
    ...new Set([
      ...(prompt.repositoryIds ?? []),
      ...context.runtimeRepositoryIds,
    ]),
  ];
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
  routingText: string,
  context: PromptExecutionContext,
  log: ReturnType<typeof createLogger>
): Promise<{ modelId: string; provider: string; enabledTools: string[]; promptTools: ToolSet }> {
  // 4. Prepare tools and their capability requirements before routing.
  const enabledTools: string[] = [...(prompt.enabledTools || [])];
  let promptTools = {};
  const repositoryIds = getPromptRepositoryIds(prompt, context);

  // Create repository search tools if repositories are configured
  if (repositoryIds.length > 0) {
    log.debug('Creating repository search tools', {
      promptId: prompt.id,
      repositoryIds
    });

    const repoTools = createRepositoryTools({
      repositoryIds,
      userCognitoSub: context.userCognitoSub,
      assistantOwnerSub: context.assistantOwnerSub
    });

    // Merge repository tools
    promptTools = { ...promptTools, ...repoTools };
  }

  const route = await routeAssistantArchitectModel({
    text: routingText,
    userId: context.userId,
    fallbackModelDbId: modelDbId,
    routingMode: context.modelRoutingMode,
    requestedFamily: context.modelRoutingFamily,
    requirements: {
      requiredTools: enabledTools,
      requiresFunctionCalling: enabledTools.length > 0 || Object.keys(promptTools).length > 0,
    },
  });
  context.modelRoutes.set(prompt.id, route.metadata);

  log.debug('Tools configured for prompt', {
    promptId: prompt.id,
    enabledTools,
    toolCount: Object.keys(promptTools).length,
    tools: Object.keys(promptTools)
  });

  return {
    modelId: route.modelId,
    provider: route.provider,
    enabledTools,
    promptTools,
  };
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
  const repositoryIds = getPromptRepositoryIds(prompt, context);
  if (repositoryIds.length > 0) {
    log.debug('Retrieving repository knowledge', {
      promptId: prompt.id,
      repositoryIds
    });

    // Emit knowledge-retrieval-start event
    await storeExecutionEvent(context.executionId, 'knowledge-retrieval-start', {
      promptId: prompt.id,
      repositories: repositoryIds,
      searchType: 'hybrid'
    });

    const knowledgeChunks = await retrieveKnowledgeForPrompt(
      [prompt.content, context.runtimeRepositoryQuery].filter(Boolean).join('\n'),
      repositoryIds,
      context.userCognitoSub,
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
    repositoryContext: repositoryContext ? 'included' : 'none',
    modelRouting: context.modelRoutes.get(prompt.id),
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
      modelRouting: context.modelRoutes.get(prompt.id) as unknown as Record<string, unknown>,
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
      modelId: context.modelRoutes.get(prompt.id)?.selectedModelDbId,
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
          modelRouting: [...context.modelRoutes.values()],
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
    hasKnowledge: getPromptRepositoryIds(prompt, context).length > 0,
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
      await resolvePromptModelAndTools(prompt, prompt.modelId, processedContent, context, log);

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
        timeout: remainingAssistantExecutionTimeoutMs(
          context.executionDeadlineAt
        ),
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
