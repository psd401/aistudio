import type { ResourceGrant } from "@/lib/db/drizzle/resource-access"

export interface BoundRepositoryAudience {
  id: number
  isPublic: boolean
  roleNames: string[]
}

export type RepositoryAudienceMismatchReason =
  | "repository_not_found"
  | "unrestricted_assistant_requires_public_repository"
  | "group_audience_requires_public_repository"
  | "repository_missing_role_grant"

export interface RepositoryAudienceMismatch {
  repositoryId: number
  reason: RepositoryAudienceMismatchReason
  missingRoleNames?: string[]
}

export interface RepositoryAudienceCompatibility {
  isCompatible: boolean
  mismatches: RepositoryAudienceMismatch[]
}

function normalizeGrantValue(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Check that every bound repository covers the assistant's full intended
 * audience. Repository ACLs currently support public, direct-user, and role
 * grants, while assistant audiences support role and group grants.
 *
 * Direct-user repository grants and repository ownership cannot prove coverage
 * for an assistant role/group audience. Group-restricted assistants therefore
 * require public repositories until repositories gain a durable group ACL.
 */
export function evaluateRepositoryAudienceCompatibility(
  repositoryIds: number[],
  assistantGrants: ResourceGrant[],
  repositories: BoundRepositoryAudience[]
): RepositoryAudienceCompatibility {
  const repositoryById = new Map(
    repositories.map((repository) => [repository.id, repository])
  )
  const normalizedGrants = assistantGrants
    .map((grant) => ({
      grantKind: grant.grantKind,
      grantValue: normalizeGrantValue(grant.grantValue),
    }))
    .filter((grant) => grant.grantValue.length > 0)
  const roleNames = [
    ...new Set(
      normalizedGrants
        .filter((grant) => grant.grantKind === "role")
        .map((grant) => grant.grantValue)
    ),
  ]
  const hasGroupAudience = normalizedGrants.some(
    (grant) => grant.grantKind === "group"
  )
  const hasRestrictedAudience = normalizedGrants.length > 0
  const mismatches: RepositoryAudienceMismatch[] = []

  for (const repositoryId of new Set(repositoryIds)) {
    const repository = repositoryById.get(repositoryId)
    if (!repository) {
      mismatches.push({ repositoryId, reason: "repository_not_found" })
      continue
    }
    if (repository.isPublic) continue

    if (!hasRestrictedAudience) {
      mismatches.push({
        repositoryId,
        reason: "unrestricted_assistant_requires_public_repository",
      })
      continue
    }

    if (hasGroupAudience) {
      mismatches.push({
        repositoryId,
        reason: "group_audience_requires_public_repository",
      })
      continue
    }

    const repositoryRoleNames = new Set(
      repository.roleNames.map(normalizeGrantValue).filter(Boolean)
    )
    const missingRoleNames = roleNames.filter(
      (roleName) => !repositoryRoleNames.has(roleName)
    )
    if (missingRoleNames.length > 0) {
      mismatches.push({
        repositoryId,
        reason: "repository_missing_role_grant",
        missingRoleNames,
      })
    }
  }

  return {
    isCompatible: mismatches.length === 0,
    mismatches,
  }
}
