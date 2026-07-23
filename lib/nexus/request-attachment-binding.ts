import { and, eq } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import {
  nexusConversations,
  nexusRepositoryBindings,
} from "@/lib/db/schema";
import {
  bindNexusAttachmentReferencesToConversation,
  type NexusAttachmentReference,
} from "@/lib/nexus/ephemeral-repository-service";

export class NexusAttachmentBindingRejectedError extends Error {
  constructor() {
    super("Nexus attachment reference was not found");
    this.name = "NexusAttachmentBindingRejectedError";
  }
}

export class NexusAttachmentBindingCleanupError extends Error {
  constructor(options: ErrorOptions) {
    super("Failed to remove a rejected empty Nexus conversation", options);
    this.name = "NexusAttachmentBindingCleanupError";
  }
}

/**
 * Compensate a failed first turn after its references were bound. Unbind before
 * deleting because the binding FK cascades on conversation deletion; reversing
 * the order would delete the only handle needed for a retry. The transaction is
 * intentionally idempotent so it can also follow the narrower bind-race cleanup.
 */
export async function rollbackNewNexusAttachmentConversation(input: {
  ownerId: number;
  conversationId: string;
}): Promise<void> {
  try {
    await executeTransaction(
      async (tx) => {
        await tx
          .update(nexusRepositoryBindings)
          .set({
            conversationId: null,
            boundAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(nexusRepositoryBindings.ownerId, input.ownerId),
              eq(
                nexusRepositoryBindings.conversationId,
                input.conversationId
              )
            )
          );
        await tx
          .delete(nexusConversations)
          .where(
            and(
              eq(nexusConversations.id, input.conversationId),
              eq(nexusConversations.userId, input.ownerId)
            )
          );
      },
      "rollbackNewNexusAttachmentConversation"
    );
  } catch (cleanupError) {
    throw new NexusAttachmentBindingCleanupError({
      cause: cleanupError,
    });
  }
}

/**
 * Bind a preflighted turn to its conversation. A race with expiry, deletion,
 * promotion, or another conversation can still invalidate the references
 * between preflight and this transaction. If that happens on a newly created
 * conversation, remove the empty row before returning the non-disclosing error.
 */
export async function bindNexusRequestAttachmentReferences(input: {
  ownerId: number;
  conversationId: string;
  references: NexusAttachmentReference[];
  conversationCreated: boolean;
}): Promise<void> {
  if (input.references.length === 0) return;
  try {
    await bindNexusAttachmentReferencesToConversation({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      references: input.references,
    });
  } catch {
    if (input.conversationCreated) {
      try {
        await rollbackNewNexusAttachmentConversation({
          ownerId: input.ownerId,
          conversationId: input.conversationId,
        });
      } catch (cleanupError) {
        if (cleanupError instanceof NexusAttachmentBindingCleanupError) {
          throw cleanupError;
        }
        throw new NexusAttachmentBindingCleanupError({ cause: cleanupError });
      }
    }
    throw new NexusAttachmentBindingRejectedError();
  }
}
