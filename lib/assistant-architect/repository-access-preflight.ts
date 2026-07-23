import { getAccessibleRepositoriesByCognitoSub } from "@/lib/db/drizzle"
import { createLogger } from "@/lib/logger"
import { parseRepositoryIds } from "@/lib/utils/repository-utils"

export const REPOSITORY_ACCESS_CHANGED_MESSAGE =
  "Repository access changed. Request access to every repository used by this assistant before trying again."

interface RepositoryBoundPrompt {
  repositoryIds?: string | number[] | null
}

export interface RepositoryAccessPreflightResult {
  isAllowed: boolean
  repositoryIds: number[]
}

function hasValidRepositoryBinding(
  repositoryIds: RepositoryBoundPrompt["repositoryIds"]
): boolean {
  if (repositoryIds == null) return true

  const parsed: unknown = typeof repositoryIds === "string"
    ? (() => {
        try {
          return JSON.parse(repositoryIds)
        } catch {
          return null
        }
      })()
    : repositoryIds

  return Array.isArray(parsed) && parsed.every(
    (id) => Number.isSafeInteger(id) && Number(id) > 0
  )
}

/**
 * Collect every distinct repository bound to any prompt in an assistant chain.
 */
export function collectBoundRepositoryIds(
  prompts: readonly RepositoryBoundPrompt[]
): { repositoryIds: number[]; hasMalformedBinding: boolean } {
  const repositoryIds = new Set<number>()
  let hasMalformedBinding = false

  for (const prompt of prompts) {
    if (!hasValidRepositoryBinding(prompt.repositoryIds)) {
      hasMalformedBinding = true
      continue
    }

    for (const repositoryId of parseRepositoryIds(prompt.repositoryIds)) {
      repositoryIds.add(repositoryId)
    }
  }

  return {
    repositoryIds: [...repositoryIds],
    hasMalformedBinding,
  }
}

/**
 * Fail-closed execution preflight for Assistant Architect repository bindings.
 *
 * Deliberately accepts only the executing principal. Assistant ownership is not
 * an authorization input: sharing an assistant must never lend its owner's
 * repository access to the executor.
 */
export async function preflightAssistantRepositoryAccess(
  prompts: readonly RepositoryBoundPrompt[],
  executorCognitoSub: string
): Promise<RepositoryAccessPreflightResult> {
  const log = createLogger({ action: "preflightAssistantRepositoryAccess" })
  const { repositoryIds, hasMalformedBinding } = collectBoundRepositoryIds(prompts)

  if (hasMalformedBinding) {
    log.warn("Assistant execution blocked by malformed repository bindings", {
      repositoryCount: repositoryIds.length,
    })
    return { isAllowed: false, repositoryIds }
  }

  if (repositoryIds.length === 0) {
    return { isAllowed: true, repositoryIds }
  }

  try {
    const repositories = await getAccessibleRepositoriesByCognitoSub(
      repositoryIds,
      executorCognitoSub
    )
    const accessibleIds = new Set(
      repositories
        .filter((repository) => repository.isAccessible)
        .map((repository) => repository.id)
    )
    const isAllowed =
      repositories.length === repositoryIds.length &&
      repositoryIds.every((repositoryId) => accessibleIds.has(repositoryId))

    return { isAllowed, repositoryIds }
  } catch (error) {
    log.error("Assistant repository access preflight failed closed", {
      repositoryCount: repositoryIds.length,
      error: error instanceof Error ? error.message : String(error),
    })
    return { isAllowed: false, repositoryIds }
  }
}
