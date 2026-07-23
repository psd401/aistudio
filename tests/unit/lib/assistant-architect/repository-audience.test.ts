const mockExecuteQuery = jest.fn()
const mockListResourceGrants = jest.fn()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  listResourceGrants: (...args: unknown[]) => mockListResourceGrants(...args),
}))

import {
  validateAssistantRepositoryAudience,
  validateAssistantRepositoryAudienceForGrants,
  validateAssistantRepositoryAudienceForRepositoryIds,
} from "@/lib/assistant-architect/repository-audience"

describe("validateAssistantRepositoryAudience", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListResourceGrants.mockResolvedValue([
      { grantKind: "role", grantValue: "staff" },
    ])
  })

  it("loads every prompt binding and accepts matching repository role grants", async () => {
    mockExecuteQuery.mockImplementation(
      (_query: unknown, label: string) => {
        if (label === "getAssistantBoundRepositoryIdsForAudience") {
          return Promise.resolve([
            { repositoryIds: [10] },
            { repositoryIds: [10, 11] },
          ])
        }
        if (label === "getRepositoryAudiencesForAssistant") {
          return Promise.resolve([
            { id: 10, isPublic: false, roleName: "staff" },
            { id: 11, isPublic: false, roleName: "staff" },
          ])
        }
        return Promise.resolve([])
      }
    )

    await expect(validateAssistantRepositoryAudience(5)).resolves.toEqual({
      isCompatible: true,
      mismatches: [],
    })
    expect(mockListResourceGrants).toHaveBeenCalledWith("assistant", 5)
  })

  it("fails closed when a bound repository no longer exists", async () => {
    mockExecuteQuery.mockImplementation(
      (_query: unknown, label: string) => {
        if (label === "getAssistantBoundRepositoryIdsForAudience") {
          return Promise.resolve([{ repositoryIds: [10, 99] }])
        }
        if (label === "getRepositoryAudiencesForAssistant") {
          return Promise.resolve([
            { id: 10, isPublic: false, roleName: "staff" },
          ])
        }
        return Promise.resolve([])
      }
    )

    const result = await validateAssistantRepositoryAudience(5)
    expect(result).toEqual({
      isCompatible: false,
      mismatches: [
        {
          repositoryId: 99,
          reason: "repository_not_found",
        },
      ],
    })
  })

  it.each([
    {
      name: "clearing grants to make the assistant unrestricted",
      grants: [],
      mismatch: {
        repositoryId: 10,
        reason: "unrestricted_assistant_requires_public_repository",
      },
    },
    {
      name: "adding a group audience to a private repository",
      grants: [
        {
          grantKind: "group" as const,
          grantValue: "teachers@example.edu",
        },
      ],
      mismatch: {
        repositoryId: 10,
        reason: "group_audience_requires_public_repository",
      },
    },
    {
      name: "adding a role absent from the repository ACL",
      grants: [
        { grantKind: "role" as const, grantValue: "staff" },
        { grantKind: "role" as const, grantValue: "curriculum" },
      ],
      mismatch: {
        repositoryId: 10,
        reason: "repository_missing_role_grant",
        missingRoleNames: ["curriculum"],
      },
    },
  ])("rejects proposed grants when $name", async ({ grants, mismatch }) => {
    mockExecuteQuery.mockImplementation(
      (_query: unknown, label: string) => {
        if (label === "getAssistantBoundRepositoryIdsForAudience") {
          return Promise.resolve([{ repositoryIds: [10] }])
        }
        if (label === "getRepositoryAudiencesForAssistant") {
          return Promise.resolve([
            { id: 10, isPublic: false, roleName: "staff" },
          ])
        }
        return Promise.resolve([])
      }
    )

    await expect(
      validateAssistantRepositoryAudienceForGrants(5, grants)
    ).resolves.toEqual({
      isCompatible: false,
      mismatches: [mismatch],
    })
    expect(mockListResourceGrants).not.toHaveBeenCalled()
  })

  it("evaluates a proposed repository set instead of the stored prompt bindings", async () => {
    mockExecuteQuery.mockImplementation(
      (_query: unknown, label: string) => {
        if (label === "getRepositoryAudiencesForAssistant") {
          return Promise.resolve([
            { id: 12, isPublic: false, roleName: "staff" },
          ])
        }
        return Promise.resolve([])
      }
    )

    await expect(
      validateAssistantRepositoryAudienceForRepositoryIds(5, [12, 12])
    ).resolves.toEqual({
      isCompatible: true,
      mismatches: [],
    })
    expect(mockListResourceGrants).toHaveBeenCalledWith("assistant", 5)
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.anything(),
      "getRepositoryAudiencesForAssistant"
    )
  })
})
