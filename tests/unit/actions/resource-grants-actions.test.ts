/**
 * @jest-environment node
 *
 * Assistant resource grants are the published audience for an Assistant
 * Architect tool. Proposed replacements must remain compatible with every
 * bound repository before the atomic delete-and-insert writer runs.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"
import type {
  RepositoryAudienceCompatibility,
  RepositoryAudienceMismatchReason,
} from "@/lib/assistant-architect/repository-audience-policy"
import type { ResourceGrant } from "@/lib/db/drizzle/resource-access"
import type { ResourceGrantType } from "@/lib/db/schema"

const mockHasRole = jest.fn<(role: string) => Promise<boolean>>(() =>
  Promise.resolve(true)
)
const mockGetCurrentUserAction = jest.fn(() =>
  Promise.resolve({
    isSuccess: true,
    data: { user: { id: 7 } },
  })
)
const mockListResourceGrants = jest.fn<
  (
    resourceType: ResourceGrantType,
    resourceId: number | string
  ) => Promise<ResourceGrant[]>
>(() => Promise.resolve([]))
const mockReplaceResourceGrants = jest.fn<
  (
    resourceType: ResourceGrantType,
    resourceId: number | string,
    grants: ResourceGrant[],
    createdBy?: number | null
  ) => Promise<void>
>(() => Promise.resolve())
const mockValidateAudience = jest.fn<
  (
    assistantId: number,
    grants: ResourceGrant[]
  ) => Promise<RepositoryAudienceCompatibility>
>(() => Promise.resolve({ isCompatible: true, mismatches: [] }))

const incompatibleAudienceCases: Array<{
  name: string
  grants: ResourceGrant[]
  reason: RepositoryAudienceMismatchReason
}> = [
  {
    name: "unrestricted",
    grants: [],
    reason: "unrestricted_assistant_requires_public_repository",
  },
  {
    name: "group-restricted",
    grants: [
      {
        grantKind: "group",
        grantValue: "teachers@example.edu",
      },
    ],
    reason: "group_audience_requires_public_repository",
  },
  {
    name: "wider-role",
    grants: [
      { grantKind: "role", grantValue: "staff" },
      { grantKind: "role", grantValue: "curriculum" },
    ],
    reason: "repository_missing_role_grant",
  },
]

jest.mock("@/utils/roles", () => ({
  hasRole: mockHasRole,
}))
jest.mock("@/actions/db/get-current-user-action", () => ({
  getCurrentUserAction: mockGetCurrentUserAction,
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => Promise.resolve([])),
}))
jest.mock("@/lib/db/schema", () => ({
  RESOURCE_GRANT_TYPES: ["model", "assistant", "skill"],
  RESOURCE_GRANT_KINDS: ["role", "group"],
  roles: { name: "name" },
}))
jest.mock("@/lib/db/drizzle/resource-access", () => ({
  listResourceGrants: mockListResourceGrants,
  normalizeGrants: (
    grants: Array<{ grantKind: "role" | "group"; grantValue: string }>
  ) =>
    grants
      .map((grant) => ({
        ...grant,
        grantValue:
          grant.grantKind === "group"
            ? grant.grantValue.trim().toLowerCase()
            : grant.grantValue.trim(),
      }))
      .filter((grant) => grant.grantValue.length > 0),
  replaceResourceGrants: mockReplaceResourceGrants,
}))
jest.mock("@/lib/assistant-architect/repository-audience", () => ({
  validateAssistantRepositoryAudienceForGrants: mockValidateAudience,
}))
jest.mock("@/lib/groups/queries", () => ({
  listActiveGroupsForPicker: jest.fn(() => Promise.resolve([])),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value,
}))
jest.mock("@/lib/error-utils", () => ({
  createSuccess: (data: unknown, message: string) => ({
    isSuccess: true,
    data,
    message,
  }),
  handleError: (error: unknown, fallback: string) => ({
    isSuccess: false,
    message: error instanceof Error ? error.message : fallback,
  }),
  ErrorFactories: {
    authzAdminRequired: () => new Error("Administrator access required"),
    validationFailed: (issues: Array<{ message: string }>) =>
      new Error(issues[0]?.message ?? "Validation failed"),
  },
}))

describe("updateResourceGrantsAction assistant repository audience", () => {
  let updateResourceGrantsAction: typeof import(
    "@/actions/db/resource-grants-actions"
  ).updateResourceGrantsAction

  beforeAll(async () => {
    ;({ updateResourceGrantsAction } = await import(
      "@/actions/db/resource-grants-actions"
    ))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockHasRole.mockResolvedValue(true)
    mockGetCurrentUserAction.mockResolvedValue({
      isSuccess: true,
      data: { user: { id: 7 } },
    })
    mockValidateAudience.mockResolvedValue({
      isCompatible: true,
      mismatches: [],
    })
    mockListResourceGrants.mockResolvedValue([
      { grantKind: "role", grantValue: "staff" },
    ])
  })

  it.each(incompatibleAudienceCases)(
    "blocks an incompatible $name replacement before persistence",
    async ({ grants, reason }) => {
      mockValidateAudience.mockResolvedValue({
        isCompatible: false,
        mismatches: [{ repositoryId: 10, reason }],
      })

      const result = await updateResourceGrantsAction(
        "assistant",
        5,
        grants
      )

      expect(result).toEqual(
        expect.objectContaining({
          isSuccess: false,
          message: expect.stringContaining(
            "Repository permissions do not cover"
          ),
        })
      )
      expect(mockValidateAudience).toHaveBeenCalledWith(5, grants)
      expect(mockReplaceResourceGrants).not.toHaveBeenCalled()
    }
  )

  it("persists a compatible normalized assistant audience", async () => {
    const result = await updateResourceGrantsAction("assistant", 5, [
      { grantKind: "role", grantValue: " Staff " },
    ])

    expect(result.isSuccess).toBe(true)
    expect(mockValidateAudience).toHaveBeenCalledWith(5, [
      { grantKind: "role", grantValue: "Staff" },
    ])
    expect(mockReplaceResourceGrants).toHaveBeenCalledWith(
      "assistant",
      5,
      [{ grantKind: "role", grantValue: "Staff" }],
      7
    )
  })

  it("does not apply assistant repository policy to model grants", async () => {
    const result = await updateResourceGrantsAction("model", 9, [
      { grantKind: "role", grantValue: "staff" },
    ])

    expect(result.isSuccess).toBe(true)
    expect(mockValidateAudience).not.toHaveBeenCalled()
    expect(mockReplaceResourceGrants).toHaveBeenCalledWith(
      "model",
      9,
      [{ grantKind: "role", grantValue: "staff" }],
      7
    )
  })
})
