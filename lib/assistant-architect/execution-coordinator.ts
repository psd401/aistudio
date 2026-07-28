import { and, count, eq, gte, inArray } from "drizzle-orm"
import { AGENT_LIMIT_CEILINGS, AGENT_LIMIT_DEFAULTS } from "@/lib/agents/types"
import { checkUserRole } from "@/lib/db/drizzle/users"
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client"
import {
  assistantArchitects,
  chainPrompts,
  toolExecutions,
} from "@/lib/db/schema"
import { userCanAccessResource } from "@/lib/db/drizzle/resource-access"
import { ErrorFactories } from "@/lib/error-utils"

const PROMPT_CHAIN_DEFAULT_TIMEOUT_SECONDS =
  AGENT_LIMIT_CEILINGS.timeoutSeconds
export const ASSISTANT_EXECUTION_MAX_PROMPTS = 20

export function compareAssistantPromptExecutionOrder(
  left: { id: number; position: number },
  right: { id: number; position: number }
): number {
  return left.position - right.position || left.id - right.id
}

/**
 * Grace after an enforced execution deadline before an abandoned active row is
 * reconciled. The runtime deadline itself is derived by
 * {@link resolveAssistantExecutionTimeoutSeconds}; import/update cleanup uses
 * this same resolver rather than guessing from an unrelated assistant field.
 */
export const ASSISTANT_EXECUTION_STALE_GRACE_SECONDS = 60

export interface AssistantExecutionTimeoutConfig {
  mode: string | null | undefined
  timeoutSeconds: number | null | undefined
  agentTimeoutSeconds: number | null | undefined
}

/**
 * Resolve the wall-clock deadline enforced by every Assistant Architect
 * execution surface.
 *
 * Agentic runs use their agent timeout (default 300s); prompt chains use their
 * assistant timeout and otherwise inherit the route/platform ceiling (900s).
 * Both modes clamp to the same hard platform ceiling.
 */
export function resolveAssistantExecutionTimeoutSeconds(
  config: AssistantExecutionTimeoutConfig
): number {
  const configured =
    config.mode === "agentic"
      ? config.agentTimeoutSeconds
      : config.timeoutSeconds
  const fallback =
    config.mode === "agentic"
      ? AGENT_LIMIT_DEFAULTS.timeoutSeconds
      : PROMPT_CHAIN_DEFAULT_TIMEOUT_SECONDS

  if (
    typeof configured !== "number" ||
    !Number.isFinite(configured) ||
    configured < 1
  ) {
    return fallback
  }
  return Math.min(
    Math.floor(configured),
    AGENT_LIMIT_CEILINGS.timeoutSeconds
  )
}

export function assistantExecutionDeadline(
  startedAt: Date,
  config: AssistantExecutionTimeoutConfig
): Date {
  return new Date(
    startedAt.getTime() +
      resolveAssistantExecutionTimeoutSeconds(config) * 1000
  )
}

export function assistantExecutionDeadlineStaleBefore(
  now: Date
): Date {
  return new Date(
    now.getTime() -
      ASSISTANT_EXECUTION_STALE_GRACE_SECONDS * 1000
  )
}

export function legacyAssistantExecutionStaleBefore(now: Date): Date {
  return new Date(
    now.getTime() -
      (AGENT_LIMIT_CEILINGS.timeoutSeconds +
        ASSISTANT_EXECUTION_STALE_GRACE_SECONDS) *
        1000
  )
}

export function remainingAssistantExecutionTimeoutMs(
  deadline: Date,
  nowMs: number = Date.now()
): number {
  const remaining = deadline.getTime() - nowMs
  if (remaining <= 0) {
    throw ErrorFactories.externalServiceTimeout(
      "assistant execution",
      0,
      {
        userMessage: "Assistant execution timed out",
        technicalMessage:
          "Assistant execution exceeded its coordinated wall-clock deadline",
      }
    )
  }
  return remaining
}

export type CoordinatedAssistantExecutionResult =
  | {
      created: true
      executionId: number
      startedAt: Date
      deadlineAt: Date
    }
  | {
      created: false
      reason: "rate_limited"
      rateCap: number
    }
  | {
      created: false
      reason: "invalid_graph"
      promptCount: number
      maxPromptCount: number
    }

export interface AssistantExecutionCoordinatorDependencies {
  executeTransaction: <T>(
    callback: (transaction: DbTransaction) => Promise<T>,
    operationName: string
  ) => Promise<T>
  checkUserRole: (
    userId: number,
    roleName: string,
    transaction: DbTransaction
  ) => Promise<boolean>
  userCanAccessResource: typeof userCanAccessResource
}

const defaultDependencies: AssistantExecutionCoordinatorDependencies = {
  executeTransaction: (callback, operationName) =>
    executeTransaction(callback, operationName),
  checkUserRole,
  userCanAccessResource,
}

interface LockedAssistant {
  id: number
  userId: number | null
  status: string
  mode: string
  modelRoutingMode: string | null
  timeoutSeconds: number | null
  agentTimeoutSeconds: number
  agentMaxRequestsPerHour: number | null
}

async function requireCurrentExecutionAccess(
  tx: DbTransaction,
  args: {
    assistant: LockedAssistant
    userId: number
    requireApproved: boolean
    modelAccessMode: "configured_graph" | "final_prompt"
  },
  dependencies: AssistantExecutionCoordinatorDependencies
): Promise<number> {
  const { assistant, userId, requireApproved, modelAccessMode } = args
  if (requireApproved && assistant.status !== "approved") {
    throw ErrorFactories.dbRecordNotFound(
      "assistant_architects",
      assistant.id
    )
  }

  if (assistant.userId !== userId && assistant.status !== "approved") {
    const isAdmin = await dependencies.checkUserRole(
      userId,
      "administrator",
      tx
    )
    if (!isAdmin) {
      throw ErrorFactories.dbRecordNotFound(
        "assistant_architects",
        assistant.id
      )
    }
  }

  const canAccessAssistant = await dependencies.userCanAccessResource(
    userId,
    "assistant",
    assistant.id,
    { ownerUserId: assistant.userId },
    tx
  )
  if (!canAccessAssistant) {
    throw ErrorFactories.authzToolAccessDenied("assistant execution", {
      userMessage: "You do not have access to this assistant",
      technicalMessage:
        "Assistant resource grants changed before the execution lock was acquired",
    })
  }

  const promptModels = await tx
    .select({
      id: chainPrompts.id,
      modelId: chainPrompts.modelId,
      position: chainPrompts.position,
    })
    .from(chainPrompts)
    .where(eq(chainPrompts.assistantArchitectId, assistant.id))
  const modelIds =
    modelAccessMode === "final_prompt"
      ? [
          promptModels.reduce<
            { id: number; modelId: number; position: number } | undefined
          >(
            (last, prompt) =>
              !last ||
              compareAssistantPromptExecutionOrder(prompt, last) > 0
                ? prompt
                : last,
            undefined
          )?.modelId,
        ].filter((modelId): modelId is number => Boolean(modelId))
      : (assistant.modelRoutingMode ?? "legacy") === "legacy"
        ? [
      ...new Set(
        promptModels
          .map(({ modelId }) => modelId)
          .filter((modelId): modelId is number => modelId > 0)
      ),
    ]
        : []
  for (const modelId of modelIds) {
    const canAccessModel = await dependencies.userCanAccessResource(
      userId,
      "model",
      modelId,
      {},
      tx
    )
    if (!canAccessModel) {
      throw ErrorFactories.authzToolAccessDenied("assistant execution", {
        userMessage:
          "You do not have access to a model this assistant uses",
        technicalMessage:
          "Assistant model resource grants changed before the execution lock was acquired",
      })
    }
  }
  return promptModels.length
}

async function isAgentRateLimited(
  tx: DbTransaction,
  assistant: LockedAssistant,
  startedAt: Date,
  enforceAgentRateCap: boolean
): Promise<boolean> {
  const rateCap = assistant.agentMaxRequestsPerHour
  if (
    !enforceAgentRateCap ||
    assistant.mode !== "agentic" ||
    typeof rateCap !== "number" ||
    rateCap <= 0
  ) {
    return false
  }

  const windowStart = new Date(startedAt.getTime() - 60 * 60 * 1000)
  const [row] = await tx
    .select({ count: count() })
    .from(toolExecutions)
    .where(
      and(
        eq(toolExecutions.assistantArchitectId, assistant.id),
        gte(toolExecutions.startedAt, windowStart)
      )
    )
  return (row?.count ?? 0) >= rateCap
}

/**
 * Serialize execution start with import/update replacement.
 *
 * The assistant row lock is the shared coordination point. While holding it,
 * this function revalidates assistant visibility plus every pinned legacy
 * prompt model grant, applies the optional web-route agent rate cap, and
 * creates the active execution row. Automatically routed modes authorize the
 * model selected by the router rather than the stored fallback. Import updates
 * take the same lock before checking active rows, so a caller can only load a
 * graph after its execution row protects that graph.
 */
export async function createCoordinatedAssistantExecution(
  args: {
    assistantId: number
    userId: number
    inputs: Record<string, unknown>
    enforceAgentRateCap?: boolean
    requireApproved?: boolean
    modelAccessMode?: "configured_graph" | "final_prompt"
  },
  dependencies: AssistantExecutionCoordinatorDependencies =
    defaultDependencies
): Promise<CoordinatedAssistantExecutionResult> {
  const inputData =
    Object.keys(args.inputs).length > 0
      ? args.inputs
      : { __no_inputs: true }

  return dependencies.executeTransaction(
    async (tx) => {
      const [assistant] = await tx
        .select({
          id: assistantArchitects.id,
          userId: assistantArchitects.userId,
          status: assistantArchitects.status,
          mode: assistantArchitects.mode,
          modelRoutingMode: assistantArchitects.modelRoutingMode,
          timeoutSeconds: assistantArchitects.timeoutSeconds,
          agentTimeoutSeconds: assistantArchitects.agentTimeoutSeconds,
          agentMaxRequestsPerHour:
            assistantArchitects.agentMaxRequestsPerHour,
        })
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, args.assistantId))
        .limit(1)
        .for("update")
      if (!assistant) {
        throw ErrorFactories.dbRecordNotFound(
          "assistant_architects",
          args.assistantId
        )
      }

      const promptCount = await requireCurrentExecutionAccess(
        tx,
        {
          assistant,
          userId: args.userId,
          requireApproved: args.requireApproved === true,
          modelAccessMode: args.modelAccessMode ?? "configured_graph",
        },
        dependencies
      )
      if (
        (promptCount === 0 ||
          promptCount > ASSISTANT_EXECUTION_MAX_PROMPTS)
      ) {
        return {
          created: false,
          reason: "invalid_graph",
          promptCount,
          maxPromptCount: ASSISTANT_EXECUTION_MAX_PROMPTS,
        }
      }
      const startedAt = new Date()
      const deadlineAt = assistantExecutionDeadline(startedAt, assistant)
      if (
        await isAgentRateLimited(
          tx,
          assistant,
          startedAt,
          args.enforceAgentRateCap === true
        )
      ) {
        return {
          created: false,
          reason: "rate_limited",
          rateCap: assistant.agentMaxRequestsPerHour as number,
        }
      }

      const [execution] = await tx
        .insert(toolExecutions)
        .values({
          userId: args.userId,
          inputData,
          status: "running",
          startedAt,
          deadlineAt,
          assistantArchitectId: args.assistantId,
        })
        .returning({ id: toolExecutions.id })
      if (!execution?.id) {
        throw ErrorFactories.sysInternalError(
          "Failed to create execution record"
        )
      }

      return {
        created: true,
        executionId: execution.id,
        startedAt,
        deadlineAt,
      }
    },
    "createToolExecutionWithAssistantLock"
  )
}

export async function settleCoordinatedAssistantExecution(args: {
  executionId: number
  status: "completed" | "failed"
  errorMessage?: string
}): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(toolExecutions)
        .set({
          status: args.status,
          completedAt: new Date(),
          errorMessage:
            args.status === "failed"
              ? (args.errorMessage ?? "Assistant execution failed").slice(
                  0,
                  2000
                )
              : null,
        })
        .where(
          and(
            eq(toolExecutions.id, args.executionId),
            inArray(toolExecutions.status, ["pending", "running"])
          )
        ),
    "settleCoordinatedAssistantExecution"
  )
}
