import { and, count, eq, gte } from "drizzle-orm"
import { AGENT_LIMIT_CEILINGS, AGENT_LIMIT_DEFAULTS } from "@/lib/agents/types"
import { checkUserRole } from "@/lib/db/drizzle/users"
import {
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
  timeoutSeconds: number | null
  agentTimeoutSeconds: number
  agentMaxRequestsPerHour: number | null
}

async function requireCurrentExecutionAccess(
  tx: DbTransaction,
  assistant: LockedAssistant,
  userId: number,
  dependencies: AssistantExecutionCoordinatorDependencies
): Promise<void> {
  if (assistant.userId !== userId && assistant.status !== "approved") {
    const isAdmin = await dependencies.checkUserRole(
      userId,
      "administrator",
      tx
    )
    if (!isAdmin) {
      throw ErrorFactories.authzToolAccessDenied("assistant execution", {
        userMessage: "You do not have permission to access this assistant",
        technicalMessage:
          "Assistant visibility changed before the execution lock was acquired",
      })
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
    .select({ modelId: chainPrompts.modelId })
    .from(chainPrompts)
    .where(eq(chainPrompts.assistantArchitectId, assistant.id))
  const modelIds = [
    ...new Set(
      promptModels
        .map(({ modelId }) => modelId)
        .filter((modelId): modelId is number => modelId > 0)
    ),
  ]
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
 * this function revalidates assistant visibility plus every prompt model grant,
 * applies the optional web-route agent rate cap, and creates the active
 * execution row. Import updates take the same lock before checking active rows,
 * so a caller can only load a graph after its execution row protects that graph.
 */
export async function createCoordinatedAssistantExecution(
  args: {
    assistantId: number
    userId: number
    inputs: Record<string, unknown>
    enforceAgentRateCap?: boolean
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

      await requireCurrentExecutionAccess(
        tx,
        assistant,
        args.userId,
        dependencies
      )
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
