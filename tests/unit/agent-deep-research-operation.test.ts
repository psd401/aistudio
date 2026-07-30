/** @jest-environment node */

const reserveDeepResearchMock = jest.fn()
const releaseDeepResearchMock = jest.fn()
const createDeepResearchInteractionMock = jest.fn()
const getDeepResearchInteractionMock = jest.fn()
const cancelDeepResearchInteractionMock = jest.fn()
const mapInteractionErrorMock = jest.fn((error: unknown) => {
  const mapped = new Error(
    error instanceof Error ? error.message : String(error)
  ) as Error & { type: "AGENT_FAILURE" }
  mapped.type = "AGENT_FAILURE"
  return mapped
})
const hasCapabilityMock = jest.fn(
  (
    capabilities: string | string[] | null | undefined,
    _capability: unknown
  ) =>
    typeof capabilities === "string" &&
    capabilities.includes("deep_research")
)
const logInfoMock = jest.fn()
const logWarnMock = jest.fn()
const logErrorMock = jest.fn()
const executeQueryMock = jest.fn()
let queryResults: unknown[][] = []

jest.mock("@/lib/agent-credentials/broker", () => ({
  AgentCredentialBroker: class {},
  AgentCredentialInputError: class extends Error {},
}))

jest.mock("@/lib/ai/deep-research-budget", () => ({
  reserveDeepResearch: (...args: unknown[]) =>
    reserveDeepResearchMock(...args),
  releaseDeepResearch: (...args: unknown[]) =>
    releaseDeepResearchMock(...args),
}))

jest.mock("@/lib/ai/gemini-deep-research-service", () => ({
  MAX_DEEP_RESEARCH_RUN_DURATION_MS: 25 * 60 * 1_000,
  cancelDeepResearchInteraction: (...args: unknown[]) =>
    cancelDeepResearchInteractionMock(...args),
  createDeepResearchInteraction: (...args: unknown[]) =>
    createDeepResearchInteractionMock(...args),
  getDeepResearchInteraction: (...args: unknown[]) =>
    getDeepResearchInteractionMock(...args),
  mapInteractionError: (error: unknown) => mapInteractionErrorMock(error),
}))

jest.mock("@/lib/ai/capability-utils", () => ({
  hasCapability: (
    capabilities: string | string[] | null | undefined,
    capability: unknown
  ) => hasCapabilityMock(capabilities, capability),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}))

jest.mock("@/lib/db/schema", () => ({
  aiModels: {
    id: "ai_models.id",
    active: "ai_models.active",
    provider: "ai_models.provider",
    modelId: "ai_models.model_id",
    capabilities: "ai_models.capabilities",
  },
  deepResearchReservations: {
    id: "deep_research_reservations.id",
    userId: "deep_research_reservations.user_id",
    status: "deep_research_reservations.status",
    reservedAt: "deep_research_reservations.reserved_at",
    interactionId: "deep_research_reservations.interaction_id",
  },
  users: {
    id: "users.id",
    email: "users.email",
    cognitoSub: "users.cognito_sub",
  },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => logInfoMock(...args),
    warn: (...args: unknown[]) => logWarnMock(...args),
    error: (...args: unknown[]) => logErrorMock(...args),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
}))

import {
  DeepResearchOperationError,
  executeDeepResearchStartOperation,
  executeDeepResearchStatusOperation,
} from "@/lib/agent-credentials/owner-operation-broker"

function activeOwner(id = 7) {
  return [{ id }]
}

function deepResearchModel() {
  return [
    {
      modelId: "deep-research-from-database",
      capabilities: '["deep_research"]',
    },
  ]
}

function ownedReservation(overrides: {
  userId?: number
  reservedAt?: Date
} = {}) {
  return [
    {
      leaseId: "lease-1",
      userId: overrides.userId ?? 7,
      reservedAt: overrides.reservedAt ?? new Date(Date.now() - 45_000),
    },
  ]
}

async function expectOperationError(
  operation: Promise<unknown>,
  status: number,
  code: string
): Promise<string> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(DeepResearchOperationError)
    const operationError = error as DeepResearchOperationError
    expect(operationError.status).toBe(status)
    expect(operationError.code).toBe(code)
    return operationError.message
  }
  throw new Error("Expected Deep Research operation to reject")
}

beforeEach(() => {
  jest.clearAllMocks()
  queryResults = []
  executeQueryMock.mockImplementation(async () => queryResults.shift() ?? [])
  reserveDeepResearchMock.mockResolvedValue({
    allowed: true,
    leaseId: "lease-1",
  })
  releaseDeepResearchMock.mockResolvedValue(undefined)
  createDeepResearchInteractionMock.mockResolvedValue({
    interactionId: "interaction-1",
    status: "in_progress",
  })
  getDeepResearchInteractionMock.mockResolvedValue({
    interactionId: "interaction-1",
    status: "in_progress",
  })
  cancelDeepResearchInteractionMock.mockResolvedValue(undefined)
})

describe("Deep Research start owner operation", () => {
  it("returns 403 for an unknown or inactive signed owner", async () => {
    queryResults = [[]]

    await expectOperationError(
      executeDeepResearchStartOperation({
        ownerEmail: "unknown@psd401.net",
        prompt: "Research a topic",
      }),
      403,
      "forbidden"
    )
    expect(reserveDeepResearchMock).not.toHaveBeenCalled()
  })

  it("resolves the model from active Google rows and binds the interaction", async () => {
    queryResults = [
      activeOwner(),
      deepResearchModel(),
      [{ id: "lease-1" }],
    ]

    await expect(
      executeDeepResearchStartOperation({
        ownerEmail: "owner@psd401.net",
        prompt: "  Research a topic  ",
      })
    ).resolves.toEqual({
      interactionId: "interaction-1",
      status: "in_progress",
    })
    expect(reserveDeepResearchMock).toHaveBeenCalledWith(7)
    expect(createDeepResearchInteractionMock).toHaveBeenCalledWith(
      "Research a topic",
      "deep-research-from-database"
    )
    expect(executeQueryMock).toHaveBeenLastCalledWith(
      expect.any(Function),
      "bindDeepResearchInteraction"
    )
    expect(logInfoMock).toHaveBeenCalledWith(
      "Deep Research broker start completed",
      expect.objectContaining({
        caller: "owner@psd401.net",
        interactionId: "interaction-1",
        resolvedModel: "deep-research-from-database",
        reservationOutcome: "reserved",
        elapsedMs: expect.any(Number),
      })
    )
  })

  it.each([
    ["user_concurrency", /already have a Deep Research run/i],
    ["deployment_concurrency", /deployment-wide concurrent-run limit/i],
    ["user_budget", /hourly Deep Research budget/i],
    ["deployment_budget", /deployment-wide hourly Deep Research budget/i],
  ] as const)(
    "maps %s to a distinct agent-readable denial",
    async (reason, expectedMessage) => {
      queryResults = [activeOwner()]
      reserveDeepResearchMock.mockResolvedValueOnce({ allowed: false, reason })

      const message = await expectOperationError(
        executeDeepResearchStartOperation({
          ownerEmail: "owner@psd401.net",
          prompt: "Research a topic",
        }),
        429,
        reason
      )
      expect(message).toMatch(expectedMessage)
      expect(createDeepResearchInteractionMock).not.toHaveBeenCalled()
    }
  )

  it("releases the lease if provider creation fails", async () => {
    queryResults = [activeOwner(), deepResearchModel()]
    createDeepResearchInteractionMock.mockRejectedValueOnce(
      new Error("Google unavailable")
    )

    await expectOperationError(
      executeDeepResearchStartOperation({
        ownerEmail: "owner@psd401.net",
        prompt: "Research a topic",
      }),
      502,
      "upstream_error"
    )
    expect(releaseDeepResearchMock).toHaveBeenCalledWith("lease-1")
    expect(cancelDeepResearchInteractionMock).not.toHaveBeenCalled()
  })

  it("cancels an interaction before releasing when reservation binding fails", async () => {
    queryResults = [activeOwner(), deepResearchModel(), []]

    await expectOperationError(
      executeDeepResearchStartOperation({
        ownerEmail: "owner@psd401.net",
        prompt: "Research a topic",
      }),
      502,
      "upstream_error"
    )
    expect(cancelDeepResearchInteractionMock).toHaveBeenCalledWith(
      "interaction-1"
    )
    expect(releaseDeepResearchMock).toHaveBeenCalledWith("lease-1")
  })

  it("preserves the lease if an unbound interaction cannot be cancelled", async () => {
    queryResults = [activeOwner(), deepResearchModel(), []]
    cancelDeepResearchInteractionMock.mockRejectedValueOnce(
      new Error("Google cancel unavailable")
    )

    await expectOperationError(
      executeDeepResearchStartOperation({
        ownerEmail: "owner@psd401.net",
        prompt: "Research a topic",
      }),
      502,
      "upstream_error"
    )
    expect(releaseDeepResearchMock).not.toHaveBeenCalled()
    expect(logErrorMock).toHaveBeenCalledWith(
      "Failed to cancel unbound Deep Research interaction",
      expect.objectContaining({
        interactionId: "interaction-1",
      })
    )
  })
})

describe("Deep Research status owner operation", () => {
  it("masks an interaction owned by another caller with 404", async () => {
    queryResults = [activeOwner(), ownedReservation({ userId: 99 })]

    await expectOperationError(
      executeDeepResearchStatusOperation({
        ownerEmail: "owner@psd401.net",
        interactionId: "foreign-interaction",
      }),
      404,
      "not_found"
    )
    expect(getDeepResearchInteractionMock).not.toHaveBeenCalled()
    expect(releaseDeepResearchMock).not.toHaveBeenCalled()
  })

  it("returns a completed report with citations and releases its lease", async () => {
    queryResults = [activeOwner(), ownedReservation(), deepResearchModel()]
    getDeepResearchInteractionMock.mockResolvedValueOnce({
      interactionId: "interaction-1",
      status: "completed",
      report: "Completed research report",
      citations: [{ url: "https://example.org/source" }],
    })

    await expect(
      executeDeepResearchStatusOperation({
        ownerEmail: "owner@psd401.net",
        interactionId: "interaction-1",
      })
    ).resolves.toEqual({
      interactionId: "interaction-1",
      status: "completed",
      elapsedSec: expect.any(Number),
      report: "Completed research report",
      citations: [{ url: "https://example.org/source" }],
    })
    expect(releaseDeepResearchMock).toHaveBeenCalledWith("lease-1")
    expect(logInfoMock).toHaveBeenCalledWith(
      "Deep Research broker terminal status",
      expect.objectContaining({
        caller: "owner@psd401.net",
        interactionId: "interaction-1",
        resolvedModel: "deep-research-from-database",
        reservationOutcome: "released",
        status: "completed",
      })
    )
  })

  it("cancels and releases a non-terminal interaction at the server deadline", async () => {
    queryResults = [
      activeOwner(),
      ownedReservation({
        reservedAt: new Date(Date.now() - 26 * 60 * 1_000),
      }),
      deepResearchModel(),
    ]

    const message = await expectOperationError(
      executeDeepResearchStatusOperation({
        ownerEmail: "owner@psd401.net",
        interactionId: "interaction-1",
      }),
      504,
      "upstream_error"
    )
    expect(message).toMatch(/25-minute server time limit/)
    expect(cancelDeepResearchInteractionMock).toHaveBeenCalledWith(
      "interaction-1"
    )
    expect(releaseDeepResearchMock).toHaveBeenCalledWith("lease-1")
    expect(logWarnMock).toHaveBeenCalledWith(
      "Deep Research broker deadline reached",
      expect.objectContaining({
        reservationOutcome: "released",
        status: "cancelled",
      })
    )
  })

  it("preserves an overdue lease if Google cancellation fails", async () => {
    queryResults = [
      activeOwner(),
      ownedReservation({
        reservedAt: new Date(Date.now() - 26 * 60 * 1_000),
      }),
    ]
    cancelDeepResearchInteractionMock.mockRejectedValueOnce(
      new Error("Google cancel unavailable")
    )

    await expectOperationError(
      executeDeepResearchStatusOperation({
        ownerEmail: "owner@psd401.net",
        interactionId: "interaction-1",
      }),
      502,
      "upstream_error"
    )
    expect(releaseDeepResearchMock).not.toHaveBeenCalled()
  })

  it.each(["failed", "cancelled", "incomplete"] as const)(
    "releases the lease and surfaces %s as an upstream error",
    async (status) => {
      queryResults = [activeOwner(), ownedReservation(), deepResearchModel()]
      getDeepResearchInteractionMock.mockResolvedValueOnce({
        interactionId: "interaction-1",
        status,
      })

      await expectOperationError(
        executeDeepResearchStatusOperation({
          ownerEmail: "owner@psd401.net",
          interactionId: "interaction-1",
        }),
        502,
        "upstream_error"
      )
      expect(releaseDeepResearchMock).toHaveBeenCalledWith("lease-1")
    }
  )
})
