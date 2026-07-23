import type { ToolSet } from "ai";
import { createRepositoryTools } from "@/lib/tools/repository-tools";

interface RepositoryBoundPrompt {
  repositoryIds?: number[] | null;
}

export interface AgenticRepositoryContext {
  repositoryIds: number[];
  tools: ToolSet;
  systemGuidance: string;
}

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Agentic assistants do not execute one prompt at a time, so their repository
 * boundary is the union of every static prompt binding and every owner-resolved
 * runtime attachment.
 */
export function collectAgenticRepositoryIds(
  prompts: readonly RepositoryBoundPrompt[],
  runtimeRepositoryIds: readonly number[]
): number[] {
  return [
    ...new Set([
      ...prompts.flatMap((prompt) => prompt.repositoryIds ?? []),
      ...runtimeRepositoryIds,
    ]),
  ].filter(isPositiveId);
}

export function createAgenticRepositoryContext(input: {
  prompts: readonly RepositoryBoundPrompt[];
  runtimeRepositoryIds: readonly number[];
  userCognitoSub: string;
}): AgenticRepositoryContext {
  const repositoryIds = collectAgenticRepositoryIds(
    input.prompts,
    input.runtimeRepositoryIds
  );
  if (repositoryIds.length === 0) {
    return { repositoryIds, tools: {}, systemGuidance: "" };
  }

  return {
    repositoryIds,
    tools: createRepositoryTools({
      repositoryIds,
      userCognitoSub: input.userCognitoSub,
    }) as ToolSet,
    systemGuidance:
      "Repository knowledge is available through vectorSearch, keywordSearch, and hybridSearch. Search the repositories before making source-based claims and preserve the returned source/citation details.",
  };
}
