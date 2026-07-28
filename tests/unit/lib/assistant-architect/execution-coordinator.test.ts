import { beforeEach, describe, expect, it, jest } from "@jest/globals"
import type { DbTransaction } from "@/lib/db/drizzle-client"

import {
  assistantExecutionDeadline,
  assistantExecutionDeadlineStaleBefore,
  createCoordinatedAssistantExecution,
  legacyAssistantExecutionStaleBefore,
  resolveAssistantExecutionTimeoutSeconds,
  type AssistantExecutionCoordinatorDependencies,
} from "@/lib/assistant-architect/execution-coordinator"

const mockCheckUserRole =
  jest.fn<AssistantExecutionCoordinatorDependencies["checkUserRole"]>()
const mockUserCanAccessResource =
  jest.fn<
    AssistantExecutionCoordinatorDependencies["userCanAccessResource"]
  >()

interface AssistantRow {
  id: number
  userId: number | null
  status: string
  mode: string
  modelRoutingMode: string | null
  timeoutSeconds: number | null
  agentTimeoutSeconds: number
  agentMaxRequestsPerHour: number | null
}

function createTransaction(
  assistant: AssistantRow,
  modelIds: number[],
  recentExecutionCount?: number
) {
  const values = jest.fn<
    (input: Record<string, unknown>) => {
      returning: jest.Mock<() => Promise<Array<{ id: number }>>>
    }
  >(() => ({
    returning: jest.fn(async () => [{ id: 123 }]),
  }))
  const insert = jest.fn(() => ({ values }))
  const select = jest
    .fn()
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => [assistant],
          }),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: async () =>
          modelIds.map((modelId, position) => ({ modelId, position })),
      }),
    })
  if (recentExecutionCount !== undefined) {
    select.mockReturnValueOnce({
      from: () => ({
        where: async () => [{ count: recentExecutionCount }],
      }),
    })
  }

  return {
    tx: {
      select,
      insert,
      execute: jest.fn(),
    },
    insert,
    values,
  }
}

function coordinatorDependencies(
  transaction: ReturnType<typeof createTransaction>["tx"]
): AssistantExecutionCoordinatorDependencies {
  return {
    executeTransaction: async <T>(
      callback: (tx: DbTransaction) => Promise<T>
    ): Promise<T> =>
      callback(transaction as unknown as DbTransaction),
    checkUserRole: mockCheckUserRole,
    userCanAccessResource: mockUserCanAccessResource,
  }
}

const approvedAssistant: AssistantRow = {
  id: 5,
  userId: 99,
  status: "approved",
  mode: "prompt_chain",
  modelRoutingMode: "legacy",
  timeoutSeconds: 600,
  agentTimeoutSeconds: 300,
  agentMaxRequestsPerHour: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCheckUserRole.mockResolvedValue(false)
  mockUserCanAccessResource.mockResolvedValue(true)
})

describe("createCoordinatedAssistantExecution", () => {
  it("rechecks assistant and every current prompt model in the lock transaction", async () => {
    const { tx, insert, values } = createTransaction(
      approvedAssistant,
      [3, 4, 3]
    )
    const dependencies = coordinatorDependencies(tx)

    const result = await createCoordinatedAssistantExecution({
      assistantId: 5,
      userId: 7,
      inputs: { topic: "safe" },
    }, dependencies)

    expect(result).toMatchObject({
      created: true,
      executionId: 123,
    })
    expect(mockCheckUserRole).not.toHaveBeenCalled()
    const accessCalls = mockUserCanAccessResource.mock.calls as unknown[][]
    expect(accessCalls).toEqual([
      [7, "assistant", 5, { ownerUserId: 99 }, tx],
      [7, "model", 3, {}, tx],
      [7, "model", 4, {}, tx],
    ])
    expect(insert).toHaveBeenCalledTimes(1)
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        deadlineAt: expect.any(Date),
      })
    )
  })

  it("fails before insert when a model grant was revoked while waiting for the lock", async () => {
    const { tx, insert } = createTransaction(approvedAssistant, [3])
    const dependencies = coordinatorDependencies(tx)
    mockUserCanAccessResource
      .mockResolvedValue(false)
      .mockResolvedValueOnce(true)

    await expect(
      createCoordinatedAssistantExecution({
        assistantId: 5,
        userId: 7,
        inputs: {},
      }, dependencies)
    ).rejects.toMatchObject({
      userMessage:
        "You do not have access to a model this assistant uses",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("leaves fallback authorization to the model router outside legacy mode", async () => {
    const automaticallyRoutedAssistant = {
      ...approvedAssistant,
      modelRoutingMode: "standard",
    }
    const { tx, insert } = createTransaction(
      automaticallyRoutedAssistant,
      [3],
    )
    mockUserCanAccessResource
      .mockResolvedValue(false)
      .mockResolvedValueOnce(true)

    await expect(
      createCoordinatedAssistantExecution({
        assistantId: 5,
        userId: 7,
        inputs: {},
      }, coordinatorDependencies(tx))
    ).resolves.toMatchObject({ created: true, executionId: 123 })
    expect(mockUserCanAccessResource).toHaveBeenCalledTimes(1)
    expect(
      mockUserCanAccessResource.mock.calls[0] as unknown[]
    ).toEqual([7, "assistant", 5, { ownerUserId: 99 }, tx])
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("rechecks only the final stored model for a direct follow-up", async () => {
    const automaticallyRoutedAssistant = {
      ...approvedAssistant,
      modelRoutingMode: "standard",
    }
    const { tx } = createTransaction(automaticallyRoutedAssistant, [2, 3])

    await expect(
      createCoordinatedAssistantExecution({
        assistantId: 5,
        userId: 7,
        inputs: {},
        modelAccessMode: "final_prompt",
      }, coordinatorDependencies(tx))
    ).resolves.toMatchObject({ created: true, executionId: 123 })
    expect(mockUserCanAccessResource.mock.calls as unknown[][]).toEqual([
      [7, "assistant", 5, { ownerUserId: 99 }, tx],
      [7, "model", 3, {}, tx],
    ])
  })

  it("fails before graph reads or insert when assistant access was revoked", async () => {
    const { tx, insert } = createTransaction(approvedAssistant, [3])
    mockUserCanAccessResource.mockResolvedValueOnce(false)

    await expect(
      createCoordinatedAssistantExecution({
        assistantId: 5,
        userId: 7,
        inputs: {},
      }, coordinatorDependencies(tx))
    ).rejects.toMatchObject({
      userMessage: "You do not have access to this assistant",
    })
    expect(tx.select).toHaveBeenCalledTimes(1)
    expect(insert).not.toHaveBeenCalled()
  })

  it.each([
    { caller: "owner", userId: 99, isAdmin: false },
    { caller: "administrator", userId: 7, isAdmin: true },
  ])(
    "requires approved status for a programmatic $caller under the lock",
    async ({ userId, isAdmin }) => {
      const pendingAssistant = {
        ...approvedAssistant,
        status: "pending_approval",
      }
      const { tx, insert } = createTransaction(pendingAssistant, [3])
      mockCheckUserRole.mockResolvedValue(isAdmin)

      await expect(
        createCoordinatedAssistantExecution({
          assistantId: 5,
          userId,
          inputs: {},
          requireApproved: true,
        }, coordinatorDependencies(tx))
      ).rejects.toThrow(/Record not found in assistant_architects/)
      expect(mockCheckUserRole).not.toHaveBeenCalled()
      expect(tx.select).toHaveBeenCalledTimes(1)
      expect(insert).not.toHaveBeenCalled()
    }
  )

  it("retains the owner draft-preview path when approval is not required", async () => {
    const pendingAssistant = {
      ...approvedAssistant,
      status: "pending_approval",
    }
    const { tx, insert } = createTransaction(pendingAssistant, [3])

    await expect(
      createCoordinatedAssistantExecution({
        assistantId: 5,
        userId: 99,
        inputs: {},
      }, coordinatorDependencies(tx))
    ).resolves.toMatchObject({ created: true, executionId: 123 })
    expect(insert).toHaveBeenCalledTimes(1)
  })
})

describe("coordinated assistant rate and graph limits", () => {
  it("applies the web agentic rate cap while still holding the assistant lock", async () => {
    const agenticAssistant: AssistantRow = {
      ...approvedAssistant,
      mode: "agentic",
      agentMaxRequestsPerHour: 2,
    }
    const { tx, insert } = createTransaction(
      agenticAssistant,
      [3],
      2
    )

    const result = await createCoordinatedAssistantExecution({
      assistantId: 5,
      userId: 7,
      inputs: {},
      enforceAgentRateCap: true,
    }, coordinatorDependencies(tx))

    expect(result).toEqual({
      created: false,
      reason: "rate_limited",
      rateCap: 2,
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it.each([
    { modelIds: [], promptCount: 0 },
    {
      modelIds: Array.from({ length: 21 }, () => 3),
      promptCount: 21,
    },
  ])(
    "rejects a $promptCount-prompt graph for every execution surface",
    async ({ modelIds, promptCount }) => {
      const agenticAssistant: AssistantRow = {
        ...approvedAssistant,
        mode: "agentic",
        agentMaxRequestsPerHour: 2,
      }
      const { tx, insert } = createTransaction(
        agenticAssistant,
        modelIds,
      )

      const result = await createCoordinatedAssistantExecution({
        assistantId: 5,
        userId: 7,
        inputs: {},
      }, coordinatorDependencies(tx))

      expect(result).toEqual({
        created: false,
        reason: "invalid_graph",
        promptCount,
        maxPromptCount: 20,
      })
      expect(tx.select).toHaveBeenCalledTimes(2)
      expect(insert).not.toHaveBeenCalled()
    },
  )
})

describe("coordinated execution deadlines", () => {
  it("uses the agentic timeout instead of the prompt-chain timeout", () => {
    expect(resolveAssistantExecutionTimeoutSeconds({
      mode: "agentic",
      timeoutSeconds: 60,
      agentTimeoutSeconds: 900,
    })).toBe(900)
  })

  it("uses the platform deadline for an unset prompt-chain timeout", () => {
    expect(resolveAssistantExecutionTimeoutSeconds({
      mode: "prompt_chain",
      timeoutSeconds: null,
      agentTimeoutSeconds: 300,
    })).toBe(900)
  })

  it("reconciles only after the enforced deadline plus grace", () => {
    const startedAt = new Date("2026-07-28T00:00:00.000Z")
    const config = {
      mode: "agentic",
      timeoutSeconds: 60,
      agentTimeoutSeconds: 900,
    }
    expect(assistantExecutionDeadline(startedAt, config).toISOString()).toBe(
      "2026-07-28T00:15:00.000Z"
    )
    const now = new Date("2026-07-28T00:16:00.000Z")
    expect(assistantExecutionDeadlineStaleBefore(now).toISOString()).toBe(
      "2026-07-28T00:15:00.000Z"
    )
    expect(legacyAssistantExecutionStaleBefore(now).toISOString()).toBe(
      "2026-07-28T00:00:00.000Z"
    )
  })
})
