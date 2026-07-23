const mockGetAccessibleRepositoriesByCognitoSub = jest.fn()

jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: (...args: unknown[]) =>
    mockGetAccessibleRepositoriesByCognitoSub(...args),
}))

jest.mock("@/lib/logger", () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
  },
  createLogger: jest.fn(() => ({
    warn: jest.fn(),
    error: jest.fn(),
  })),
}))

import {
  collectBoundRepositoryIds,
  preflightAssistantRepositoryAccess,
} from "@/lib/assistant-architect/repository-access-preflight"

describe("Assistant Architect repository execution preflight", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("collects every distinct repository bound across the prompt chain", () => {
    expect(collectBoundRepositoryIds([
      { repositoryIds: [7, 8] },
      { repositoryIds: "[8,9]" },
      { repositoryIds: null },
    ])).toEqual({
      repositoryIds: [7, 8, 9],
      hasMalformedBinding: false,
    })
  })

  it("fails closed when the executor lost access to one bound repository", async () => {
    mockGetAccessibleRepositoriesByCognitoSub.mockResolvedValue([
      { id: 7, name: "Accessible", isAccessible: true },
      { id: 8, name: "", isAccessible: false },
    ])

    await expect(preflightAssistantRepositoryAccess(
      [{ repositoryIds: [7] }, { repositoryIds: [8] }],
      "executor-sub"
    )).resolves.toEqual({
      isAllowed: false,
      repositoryIds: [7, 8],
    })
  })

  it("never supplies assistant-owner authority to elevate the executor", async () => {
    mockGetAccessibleRepositoriesByCognitoSub.mockImplementation(
      async (_repositoryIds: number[], _executorSub: string, assistantOwnerSub?: string) => [
        { id: 7, name: "Owner private", isAccessible: Boolean(assistantOwnerSub) },
      ]
    )

    const result = await preflightAssistantRepositoryAccess(
      [{ repositoryIds: [7] }],
      "executor-sub"
    )

    expect(result.isAllowed).toBe(false)
    expect(mockGetAccessibleRepositoriesByCognitoSub).toHaveBeenCalledWith(
      [7],
      "executor-sub"
    )
    expect(mockGetAccessibleRepositoriesByCognitoSub.mock.calls[0]).toHaveLength(2)
  })

  it("fails closed when the access query errors or a binding is malformed", async () => {
    mockGetAccessibleRepositoriesByCognitoSub.mockRejectedValue(new Error("database unavailable"))

    await expect(preflightAssistantRepositoryAccess(
      [{ repositoryIds: [7] }],
      "executor-sub"
    )).resolves.toMatchObject({ isAllowed: false })

    jest.clearAllMocks()
    await expect(preflightAssistantRepositoryAccess(
      [{ repositoryIds: "[7" }],
      "executor-sub"
    )).resolves.toEqual({ isAllowed: false, repositoryIds: [] })
    expect(mockGetAccessibleRepositoriesByCognitoSub).not.toHaveBeenCalled()
  })
})
