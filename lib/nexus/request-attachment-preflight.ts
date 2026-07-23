import {
  resolveNexusAttachmentReference,
  type NexusAttachmentReference,
  type NexusAttachmentReferenceResolution,
} from "@/lib/nexus/ephemeral-repository-service";
import {
  temporaryAttachmentReferencesFromValue,
  type TemporaryAttachmentReference,
} from "@/lib/repositories/temporary-attachment-contract";

const MAX_ATTACHMENTS_PER_TURN = 20;

interface NexusRequestMessage {
  role?: string;
  parts?: unknown[];
  content?: unknown;
}

export interface NexusAttachmentRequestPreflight {
  references: NexusAttachmentReference[];
  resolutions: NexusAttachmentReferenceResolution[];
  /**
   * Every canonical source requires the repository retrieval tool before a
   * model can make source-based claims. Images may also retain inline pixels
   * for the immediate vision/image-generation path, but caller-controlled
   * part ordering cannot prove those pixels belong to a particular marker.
   */
  requiresAttachmentTools: boolean;
}

export class NexusAttachmentTurnLimitError extends Error {
  constructor() {
    super(`A message can include at most ${MAX_ATTACHMENTS_PER_TURN} attachments`);
    this.name = "NexusAttachmentTurnLimitError";
  }
}

function lastUserMessage(messages: NexusRequestMessage[]): NexusRequestMessage | null {
  return messages.findLast((message) => message.role === "user") ?? null;
}

function deduplicateReferences(
  references: TemporaryAttachmentReference[]
): TemporaryAttachmentReference[] {
  return [
    ...new Map(
      references.map((reference) => [
        `${reference.bindingId}:${reference.itemId}`,
        reference,
      ])
    ).values(),
  ];
}

/**
 * Resolve every opaque attachment reference on the current user turn before
 * model routing or conversation creation. `null` intentionally collapses
 * missing, expired, foreign, and mismatched references into one result.
 */
export async function preflightNexusAttachmentReferences(input: {
  ownerId: number;
  messages: NexusRequestMessage[];
}): Promise<NexusAttachmentRequestPreflight | null> {
  const currentMessage = lastUserMessage(input.messages);
  const references = deduplicateReferences(
    temporaryAttachmentReferencesFromValue(currentMessage)
  );
  if (references.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new NexusAttachmentTurnLimitError();
  }
  if (references.length === 0) {
    return {
      references: [],
      resolutions: [],
      requiresAttachmentTools: false,
    };
  }

  const resolutions = await Promise.all(
    references.map((reference) =>
      resolveNexusAttachmentReference({
        ownerId: input.ownerId,
        bindingId: reference.bindingId,
        itemId: reference.itemId,
      })
    )
  );
  if (resolutions.includes(null)) {
    return null;
  }

  const resolved = resolutions.filter(
    (resolution): resolution is NexusAttachmentReferenceResolution =>
      resolution !== null
  );
  return {
    references: references.map(({ bindingId, itemId }) => ({
      bindingId,
      itemId,
    })),
    resolutions: resolved,
    // Inline image parts are not cryptographically associated with markers.
    // Always keep the authoritative repository retrieval path available so
    // reordering or substituting pixels cannot suppress source verification.
    requiresAttachmentTools: true,
  };
}
