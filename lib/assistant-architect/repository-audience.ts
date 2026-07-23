import "server-only"

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import {
  chainPrompts,
  knowledgeRepositories,
  repositoryAccess,
  roles,
} from "@/lib/db/schema"
import {
  listResourceGrants,
  type ResourceGrant,
} from "@/lib/db/drizzle/resource-access"
import { parseRepositoryIds } from "@/lib/utils/repository-utils"
import {
  evaluateRepositoryAudienceCompatibility,
  type BoundRepositoryAudience,
  type RepositoryAudienceCompatibility,
} from "./repository-audience-policy"

function isValidRepositoryId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

async function getBoundRepositoryIds(
  assistantId: number
): Promise<number[]> {
  const prompts = await executeQuery(
    (db) =>
      db
        .select({ repositoryIds: chainPrompts.repositoryIds })
        .from(chainPrompts)
        .where(eq(chainPrompts.assistantArchitectId, assistantId)),
    "getAssistantBoundRepositoryIdsForAudience"
  )

  return [
    ...new Set(
      prompts
        .flatMap((prompt) => parseRepositoryIds(prompt.repositoryIds))
        .filter(isValidRepositoryId)
    ),
  ]
}

async function getRepositoryAudiences(
  repositoryIds: number[]
): Promise<BoundRepositoryAudience[]> {
  if (repositoryIds.length === 0) return []

  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: knowledgeRepositories.id,
          isPublic: knowledgeRepositories.isPublic,
          roleName: roles.name,
        })
        .from(knowledgeRepositories)
        .leftJoin(
          repositoryAccess,
          eq(repositoryAccess.repositoryId, knowledgeRepositories.id)
        )
        .leftJoin(roles, eq(roles.id, repositoryAccess.roleId))
        .where(
          and(
            inArray(knowledgeRepositories.id, repositoryIds),
            eq(knowledgeRepositories.repositoryKind, "durable"),
            eq(knowledgeRepositories.lifecycleStatus, "active"),
            or(
              isNull(knowledgeRepositories.expiresAt),
              gt(knowledgeRepositories.expiresAt, new Date())
            ),
            sql`(${knowledgeRepositories.metadata}->>'systemManaged') IS DISTINCT FROM 'true'`
          )
        ),
    "getRepositoryAudiencesForAssistant"
  )

  const repositories = new Map<number, BoundRepositoryAudience>()
  for (const row of rows) {
    const repository = repositories.get(row.id) ?? {
      id: row.id,
      isPublic: row.isPublic === true,
      roleNames: [],
    }
    if (row.roleName) repository.roleNames.push(row.roleName)
    repositories.set(row.id, repository)
  }
  return [...repositories.values()]
}

/**
 * Evaluate a proposed Assistant Architect audience against every repository
 * currently bound to its prompts.
 *
 * This is the write-boundary variant used by the resource-grant editor. It must
 * evaluate the submitted grants, not the rows currently stored in
 * `resource_access_grants`, otherwise clearing or broadening an approved
 * assistant's audience could bypass the submission/approval checks.
 */
export async function validateAssistantRepositoryAudienceForGrants(
  assistantId: number,
  assistantGrants: ResourceGrant[]
): Promise<RepositoryAudienceCompatibility> {
  const repositoryIds = await getBoundRepositoryIds(assistantId)
  if (repositoryIds.length === 0) {
    return { isCompatible: true, mismatches: [] }
  }

  const repositories = await getRepositoryAudiences(repositoryIds)
  return evaluateRepositoryAudienceCompatibility(
    repositoryIds,
    assistantGrants,
    repositories
  )
}

/**
 * Evaluate a candidate prompt-binding state against the assistant's currently
 * published audience. Prompt mutations on an already-approved assistant must
 * use the proposed repository IDs rather than the rows currently stored in the
 * database, otherwise adding a private repository after approval bypasses the
 * submission/approval checks.
 */
export async function validateAssistantRepositoryAudienceForRepositoryIds(
  assistantId: number,
  repositoryIds: number[]
): Promise<RepositoryAudienceCompatibility> {
  const uniqueRepositoryIds = [...new Set(repositoryIds)]
  if (uniqueRepositoryIds.length === 0) {
    return { isCompatible: true, mismatches: [] }
  }

  const [assistantGrants, repositories] = await Promise.all([
    listResourceGrants("assistant", assistantId),
    getRepositoryAudiences(uniqueRepositoryIds),
  ])
  return evaluateRepositoryAudienceCompatibility(
    uniqueRepositoryIds,
    assistantGrants,
    repositories
  )
}

/**
 * Revalidate the complete assistant-to-repository audience boundary immediately
 * before submission or approval. A single incompatible repository fails the
 * whole binding set.
 */
export async function validateAssistantRepositoryAudience(
  assistantId: number
): Promise<RepositoryAudienceCompatibility> {
  const assistantGrants = await listResourceGrants("assistant", assistantId)
  return validateAssistantRepositoryAudienceForGrants(
    assistantId,
    assistantGrants
  )
}
