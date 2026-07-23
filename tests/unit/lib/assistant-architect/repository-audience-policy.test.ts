import { evaluateRepositoryAudienceCompatibility } from "@/lib/assistant-architect/repository-audience-policy"
import type { ResourceGrant } from "@/lib/db/drizzle/resource-access"

function role(grantValue: string): ResourceGrant {
  return { grantKind: "role", grantValue }
}

function group(grantValue: string): ResourceGrant {
  return { grantKind: "group", grantValue }
}

describe("Assistant Architect repository audience policy", () => {
  it("allows any assistant audience to use a public repository", () => {
    const result = evaluateRepositoryAudienceCompatibility(
      [10],
      [role("staff"), group("teachers@example.edu")],
      [{ id: 10, isPublic: true, roleNames: [] }]
    )

    expect(result).toEqual({ isCompatible: true, mismatches: [] })
  })

  it("requires every repository to be public for an unrestricted assistant", () => {
    const result = evaluateRepositoryAudienceCompatibility(
      [10, 11],
      [],
      [
        { id: 10, isPublic: true, roleNames: [] },
        { id: 11, isPublic: false, roleNames: ["staff"] },
      ]
    )

    expect(result.isCompatible).toBe(false)
    expect(result.mismatches).toEqual([
      {
        repositoryId: 11,
        reason: "unrestricted_assistant_requires_public_repository",
      },
    ])
  })

  it("allows a private repository only when it grants every assistant role", () => {
    const grants = [role("Staff"), role("Curriculum")]

    expect(
      evaluateRepositoryAudienceCompatibility(
        [10],
        grants,
        [
          {
            id: 10,
            isPublic: false,
            roleNames: ["staff", "CURRICULUM"],
          },
        ]
      ).isCompatible
    ).toBe(true)

    const mismatch = evaluateRepositoryAudienceCompatibility(
      [10],
      grants,
      [{ id: 10, isPublic: false, roleNames: ["staff"] }]
    )
    expect(mismatch).toEqual({
      isCompatible: false,
      mismatches: [
        {
          repositoryId: 10,
          reason: "repository_missing_role_grant",
          missingRoleNames: ["curriculum"],
        },
      ],
    })
  })

  it("rejects a private repository for a group audience", () => {
    const result = evaluateRepositoryAudienceCompatibility(
      [10],
      [group("teachers@example.edu")],
      [{ id: 10, isPublic: false, roleNames: ["staff"] }]
    )

    expect(result).toEqual({
      isCompatible: false,
      mismatches: [
        {
          repositoryId: 10,
          reason: "group_audience_requires_public_repository",
        },
      ],
    })
  })

  it("fails the complete binding set when any repository is missing", () => {
    const result = evaluateRepositoryAudienceCompatibility(
      [10, 99],
      [role("staff")],
      [{ id: 10, isPublic: false, roleNames: ["staff"] }]
    )

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
})
