import { and, eq, inArray } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  nexusConversationRepositories,
  nexusConversations,
  type NexusRepositoryBindingSource,
} from "@/lib/db/schema";
import { getAccessibleRepositoryIds } from "@/lib/db/drizzle";
import {
  assertRepositoriesSearchable,
  RepositoryReadinessError,
  type RepositoryReadinessSnapshot,
} from "@/lib/repositories/readiness-service";

export type ConversationRepositoryBindingErrorCode =
  | "CONVERSATION_NOT_FOUND"
  | "REPOSITORY_BINDING_INACCESSIBLE";

export class ConversationRepositoryBindingError extends Error {
  constructor(
    readonly code: ConversationRepositoryBindingErrorCode,
    message: string,
    readonly repositoryIds: number[] = []
  ) {
    super(message);
    this.name = "ConversationRepositoryBindingError";
  }
}

export interface ConversationRepositoryBinding {
  repositoryId: number;
  source: NexusRepositoryBindingSource;
  sourceId: string;
}

export interface ValidatedConversationRepositoryContext {
  bindings: ConversationRepositoryBinding[];
  repositoryIds: number[];
  readiness: RepositoryReadinessSnapshot[];
}

function normalizeRepositoryIds(repositoryIds: number[]): number[] {
  return [...new Set(repositoryIds)].filter(
    (repositoryId) =>
      Number.isSafeInteger(repositoryId) && repositoryId > 0
  );
}

async function assertAccessibleRepositoryIds(
  repositoryIds: number[],
  userId: number
): Promise<number[]> {
  const normalized = normalizeRepositoryIds(repositoryIds);
  const accessible = await getAccessibleRepositoryIds(normalized, userId);
  const accessibleSet = new Set(accessible);
  const inaccessible = normalized.filter(
    (repositoryId) => !accessibleSet.has(repositoryId)
  );
  if (inaccessible.length > 0) {
    throw new ConversationRepositoryBindingError(
      "REPOSITORY_BINDING_INACCESSIBLE",
      "One or more repositories are missing or inaccessible",
      inaccessible
    );
  }
  return normalized;
}

/**
 * Replace all bindings for one source identity. Direct selection uses an empty
 * sourceId; project, skill, and Assistant bindings use their durable identity.
 * Other binding sources on the conversation are left untouched.
 */
export async function replaceConversationRepositoryBindings(input: {
  conversationId: string;
  userId: number;
  repositoryIds: number[];
  source: NexusRepositoryBindingSource;
  sourceId?: string;
}): Promise<ConversationRepositoryBinding[]> {
  const repositoryIds = await assertAccessibleRepositoryIds(
    input.repositoryIds,
    input.userId
  );
  const sourceId = input.sourceId?.trim() ?? "";
  return executeTransaction(
    async (tx) => {
      const [ownedConversation] = await tx
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, input.conversationId),
            eq(nexusConversations.userId, input.userId)
          )
        )
        .limit(1)
        .for("update");
      if (!ownedConversation) {
        throw new ConversationRepositoryBindingError(
          "CONVERSATION_NOT_FOUND",
          "Conversation not found or access denied"
        );
      }

      const existing = await tx
        .select({ repositoryId: nexusConversationRepositories.repositoryId })
        .from(nexusConversationRepositories)
        .where(
          and(
            eq(
              nexusConversationRepositories.conversationId,
              input.conversationId
            ),
            eq(nexusConversationRepositories.source, input.source),
            eq(nexusConversationRepositories.sourceId, sourceId)
          )
        );
      const existingIds = existing
        .map(({ repositoryId }) => repositoryId)
        .sort((left, right) => left - right);
      const requestedIds = [...repositoryIds].sort((left, right) => left - right);
      if (
        existingIds.length === requestedIds.length &&
        existingIds.every(
          (repositoryId, index) => repositoryId === requestedIds[index]
        )
      ) {
        return repositoryIds.map((repositoryId) => ({
          repositoryId,
          source: input.source,
          sourceId,
        }));
      }

      await tx
        .delete(nexusConversationRepositories)
        .where(
          and(
            eq(
              nexusConversationRepositories.conversationId,
              input.conversationId
            ),
            eq(nexusConversationRepositories.source, input.source),
            eq(nexusConversationRepositories.sourceId, sourceId)
          )
        );

      if (repositoryIds.length > 0) {
        await tx.insert(nexusConversationRepositories).values(
          repositoryIds.map((repositoryId) => ({
            conversationId: input.conversationId,
            repositoryId,
            source: input.source,
            sourceId,
            createdBy: input.userId,
          }))
        );
      }

      return repositoryIds.map((repositoryId) => ({
        repositoryId,
        source: input.source,
        sourceId,
      }));
    },
    "replaceConversationRepositoryBindings",
    { isolationLevel: "serializable" }
  );
}

export async function getConversationRepositoryBindings(input: {
  conversationId: string;
  userId: number;
}): Promise<ConversationRepositoryBinding[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          conversationId: nexusConversations.id,
          repositoryId: nexusConversationRepositories.repositoryId,
          source: nexusConversationRepositories.source,
          sourceId: nexusConversationRepositories.sourceId,
        })
        .from(nexusConversations)
        .leftJoin(
          nexusConversationRepositories,
          eq(
            nexusConversationRepositories.conversationId,
            nexusConversations.id
          )
        )
        .where(
          and(
            eq(nexusConversations.id, input.conversationId),
            eq(nexusConversations.userId, input.userId)
          )
        ),
    "getConversationRepositoryBindings"
  );
  if (rows.length === 0) {
    throw new ConversationRepositoryBindingError(
      "CONVERSATION_NOT_FOUND",
      "Conversation not found or access denied"
    );
  }
  return rows.flatMap((row) =>
    row.repositoryId !== null && row.source !== null && row.sourceId !== null
      ? [
          {
            repositoryId: row.repositoryId,
            source: row.source,
            sourceId: row.sourceId,
          },
        ]
      : []
  );
}

/**
 * Revalidate ownership, current ACLs, lifecycle, and active-generation
 * readiness immediately before a model turn. Stored bindings are never trusted
 * merely because they were valid when created.
 */
export async function loadValidatedConversationRepositoryContext(input: {
  conversationId: string;
  userId: number;
}): Promise<ValidatedConversationRepositoryContext> {
  const bindings = await getConversationRepositoryBindings(input);
  const repositoryIds = normalizeRepositoryIds(
    bindings.map((binding) => binding.repositoryId)
  );
  if (repositoryIds.length === 0) {
    return { bindings, repositoryIds, readiness: [] };
  }

  await assertAccessibleRepositoryIds(repositoryIds, input.userId);
  const readiness = await assertRepositoriesSearchable(repositoryIds);
  return { bindings, repositoryIds, readiness };
}

export async function copyConversationRepositoryBindings(input: {
  fromConversationId: string;
  toConversationId: string;
  userId: number;
}): Promise<void> {
  const bindings = await getConversationRepositoryBindings({
    conversationId: input.fromConversationId,
    userId: input.userId,
  });
  if (bindings.length === 0) return;
  const repositoryIds = await assertAccessibleRepositoryIds(
    bindings.map((binding) => binding.repositoryId),
    input.userId
  );
  const allowed = new Set(repositoryIds);
  await executeTransaction(
    async (tx) => {
      const ownedRows = await tx
        .select({ id: nexusConversations.id })
        .from(nexusConversations)
        .where(
          and(
            inArray(nexusConversations.id, [
              input.fromConversationId,
              input.toConversationId,
            ]),
            eq(nexusConversations.userId, input.userId)
          )
        );
      if (ownedRows.length !== 2) {
        throw new ConversationRepositoryBindingError(
          "CONVERSATION_NOT_FOUND",
          "Conversation not found or access denied"
        );
      }
      await tx
        .insert(nexusConversationRepositories)
        .values(
          bindings
            .filter((binding) => allowed.has(binding.repositoryId))
            .map((binding) => ({
              conversationId: input.toConversationId,
              repositoryId: binding.repositoryId,
              source: binding.source,
              sourceId: binding.sourceId,
              createdBy: input.userId,
            }))
        )
        .onConflictDoNothing();
    },
    "copyConversationRepositoryBindings"
  );
}

export function repositoryBindingErrorResponse(
  error: ConversationRepositoryBindingError | RepositoryReadinessError,
  requestId: string
): Response {
  const status =
    error instanceof ConversationRepositoryBindingError &&
    error.code === "CONVERSATION_NOT_FOUND"
      ? 404
      : error.code === "REPOSITORY_BINDING_INACCESSIBLE"
        ? 403
        : 409;
  return Response.json(
    {
      error: error.message,
      code: error.code,
      repositoryIds:
        error instanceof ConversationRepositoryBindingError
          ? error.repositoryIds
          : error.repositories.map((repository) => repository.repositoryId),
      repositories:
        error instanceof RepositoryReadinessError
          ? error.repositories
          : undefined,
      requestId,
    },
    { status }
  );
}
