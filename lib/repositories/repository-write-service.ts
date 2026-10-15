import "server-only";

import {
  getRepositoryItemById,
  updateRepositoryItemStatus,
} from "@/lib/db/drizzle";
import {
  executeTransaction,
  repositoryItemChunks,
  repositoryItems,
} from "@/lib/db/drizzle-client";
import {
  dispatchContentProcessingJob,
  registerCanonicalText,
  registerCanonicalTextIfEnabled,
} from "@/lib/repositories/content-platform";
import {
  getContentPlatformConfig,
  isCanonicalRepositoryUploadActive,
} from "@/lib/repositories/content-platform/config";
import { createLogger } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";
import type { SelectRepositoryItem } from "@/lib/db/types";

/**
 * Repository WRITE primitives, free of any session dependency.
 *
 * Issue #1907: the Repository Manager's inline-text path used to live entirely
 * inside `actions/repositories/repository-items.actions.ts`, which resolves the
 * browser session before it does anything. The MCP surface authenticates with an
 * API key or an OAuth bearer token and has no session, so the write core is
 * extracted here and the two surfaces share ONE implementation of the
 * transaction + canonical shadow-write.
 *
 * ## Authorization is the CALLER's job
 *
 * Nothing in this module checks who the caller is — `userId` is taken on trust.
 * Every caller MUST authorize first:
 * - the server action uses its session + `canModifyRepository`
 * - the MCP handlers use `canModifyUserManagedDurableRepository` plus the
 *   `knowledge-repositories` capability (see `lib/mcp/tool-handlers.ts`)
 *
 * This mirrors `actions/repositories/repository-permissions.ts`: an internal
 * server module, never a `"use server"` action, so its exports are not public
 * endpoints. `import "server-only"` makes a client import fail at build time.
 */

/**
 * Upper bound on inline text accepted from a single call, in UTF-8 bytes.
 *
 * The MCP transport ceiling (`MCP_REQUEST_MAX_BYTES`, 64 MiB) is shared by every
 * tool and is far too generous for a repository note; the canonical pipeline's
 * own cap (`registerCanonicalText`) only applies once the content platform is
 * active, so without this bound a pre-cutover deployment would accept an
 * unbounded `text` column. 1 MiB is ~250k words — well beyond any agent-authored
 * note, and well under the canonical cap in every environment.
 */
export const REPOSITORY_INLINE_TEXT_MAX_BYTES = 1024 * 1024;

/**
 * Longest accepted repository/item name and repository description, in UTF-8
 * bytes. The underlying columns are unbounded `text`, so these are the API
 * boundary's bounds, not the database's. Bytes rather than characters for the
 * same reason the content cap is: a CJK or emoji name costs up to 4x what its
 * `.length` suggests.
 */
export const REPOSITORY_NAME_MAX_BYTES = 500;
export const REPOSITORY_DESCRIPTION_MAX_BYTES = 2000;

export interface CreateRepositoryTextItemInput {
  repositoryId: number;
  /** Already-authorized acting user. NOT verified here. */
  userId: number;
  name: string;
  content: string;
  traceId: string;
  /**
   * The calling surface, used as the log `action` tag and the DB operation
   * label (for example `addTextItem` for the Server Action,
   * `repositories_add_item` for the MCP tool).
   *
   * Passed in rather than hard-coded: the extraction would otherwise collapse
   * both surfaces onto one label, and every existing dashboard or alert keyed
   * on `action: "addTextItem"` would stop matching while the two callers became
   * indistinguishable in the logs.
   */
  callerAction: string;
}

/**
 * Shadow-write inline text through the canonical S3 / version / generation /
 * embedding pipeline.
 *
 * Deliberately non-throwing: a canonical failure marks the item `failed` (so the
 * owner can retry it) rather than failing the whole add, because the legacy row
 * is already committed. `canonicalRequired` is true after the Repository Manager
 * cutover, when the canonical version is the ONLY searchable copy.
 */
async function shadowWriteCanonicalText(
  input: {
    itemId: number;
    repositoryId: number;
    userId: number;
    name: string;
    content: string;
    traceId: string;
  },
  log: ReturnType<typeof createLogger>,
  canonicalRequired = false
): Promise<void> {
  try {
    const canonical = canonicalRequired
      ? await registerCanonicalText(input)
      : await registerCanonicalTextIfEnabled(input);
    if (!canonical) return;

    log.info("Canonical inline text version registered", {
      itemId: input.itemId,
      versionId: canonical.version.id,
      processingJobId: canonical.inspectJob.id,
      created: canonical.created,
    });
    await updateRepositoryItemStatus(input.itemId, "pending", null);
    try {
      await dispatchContentProcessingJob({
        jobId: canonical.inspectJob.id,
        itemVersionId: canonical.version.id,
      });
    } catch (dispatchError) {
      log.warn(
        "Canonical inline text processing is pending scheduled dispatch",
        {
          processingJobId: canonical.inspectJob.id,
          error:
            dispatchError instanceof Error
              ? dispatchError.message
              : "Unknown error",
        }
      );
    }
  } catch (error) {
    await updateRepositoryItemStatus(
      input.itemId,
      "failed",
      "Canonical content registration failed. Retry this item."
    ).catch((statusError) => {
      log.error("Failed to expose canonical inline text registration failure", {
        itemId: input.itemId,
        error:
          statusError instanceof Error ? statusError.message : "Unknown error",
      });
    });
    log.error("Canonical inline text shadow write failed", {
      itemId: input.itemId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Create one inline-text repository item and start its processing.
 *
 * The caller MUST have authorized `userId` against `repositoryId` and MUST have
 * run the system-managed-repository guard (`assertNotSystemManagedRepository`)
 * first — the DB accessors keep their own backstop, but a 404-before-403 answer
 * is the caller's to produce.
 */
export async function createRepositoryTextItem(
  input: CreateRepositoryTextItemInput
): Promise<SelectRepositoryItem> {
  const log = createLogger({
    requestId: input.traceId,
    action: input.callerAction,
    module: "repository-write-service",
  });

  const contentPlatformConfig = await getContentPlatformConfig();
  const canonicalCutover = isCanonicalRepositoryUploadActive(
    contentPlatformConfig
  );

  // During the shadow window retain the legacy chunk for rollback. After the
  // independent Repository Manager cutover, create only the stable item and let
  // the canonical version/generation own searchable content.
  log.info("Creating text item with Drizzle transaction", {
    repositoryId: input.repositoryId,
    contentLength: input.content.length,
    canonicalCutover,
  });

  const itemId = await executeTransaction(async (tx) => {
    const [newItem] = await tx
      .insert(repositoryItems)
      .values({
        repositoryId: input.repositoryId,
        type: "text",
        name: input.name,
        source: input.content,
        metadata: { length: input.content.length },
        processingStatus: canonicalCutover ? "pending" : "completed",
      })
      .returning({ id: repositoryItems.id });

    log.debug("Text item created", { itemId: newItem.id });

    if (!canonicalCutover) {
      await tx.insert(repositoryItemChunks).values({
        itemId: newItem.id,
        content: input.content,
        chunkIndex: 0,
        metadata: {},
      });
      log.debug("Legacy text chunk added", {
        itemId: newItem.id,
        chunkIndex: 0,
      });
    }

    return newItem.id;
  }, input.callerAction);

  // Inline text previously bypassed the canonical pipeline entirely. Keep the
  // legacy row for rollback, but shadow-write a repository-scoped text object so
  // Retrieval v2 receives an immutable version, generation, embeddings, and
  // exact citation through the same worker as file uploads.
  await shadowWriteCanonicalText(
    {
      itemId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      name: input.name,
      content: input.content,
      traceId: input.traceId,
    },
    log,
    canonicalCutover
  );

  const item = await getRepositoryItemById(itemId);
  if (!item) {
    throw ErrorFactories.dbRecordNotFound("repository_items", itemId);
  }
  return item;
}
