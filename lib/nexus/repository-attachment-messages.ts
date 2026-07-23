import type { UIMessage } from "ai";
import {
  parseTemporaryAttachmentMarkers,
  removeTemporaryAttachmentMarkers,
  replaceTemporaryAttachmentMarkersWithAuthoritativeLabels,
  type AuthoritativeTemporaryAttachmentLabel,
  type TemporaryAttachmentReference,
} from "@/lib/repositories/temporary-attachment-contract";

function referencesFromUnknown(
  value: unknown
): TemporaryAttachmentReference[] {
  if (typeof value === "string") {
    return parseTemporaryAttachmentMarkers(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap(referencesFromUnknown);
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(
    referencesFromUnknown
  );
}

function stripMarkersFromUnknown(
  value: unknown,
  labels: readonly AuthoritativeTemporaryAttachmentLabel[]
): unknown {
  if (typeof value === "string") {
    return replaceTemporaryAttachmentMarkersWithAuthoritativeLabels(
      value,
      labels
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripMarkersFromUnknown(entry, labels));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      stripMarkersFromUnknown(nested, labels),
    ])
  );
}

function deduplicateReferences(
  references: TemporaryAttachmentReference[]
): TemporaryAttachmentReference[] {
  const unique = new Map<string, TemporaryAttachmentReference>();
  for (const reference of references) {
    unique.set(`${reference.bindingId}:${reference.itemId}`, reference);
  }
  return [...unique.values()];
}

function authoritativeReferencesForValue(
  value: unknown,
  labels: readonly AuthoritativeTemporaryAttachmentLabel[]
): TemporaryAttachmentReference[] {
  const labelsByReference = new Map(
    labels.map((label) => [
      `${label.bindingId.toLowerCase()}:${label.itemId}`,
      label,
    ])
  );
  return deduplicateReferences(referencesFromUnknown(value)).flatMap(
    (reference) => {
      const authoritative = labelsByReference.get(
        `${reference.bindingId.toLowerCase()}:${reference.itemId}`
      );
      return authoritative
        ? [{
            bindingId: authoritative.bindingId,
            itemId: authoritative.itemId,
            name: authoritative.name,
          }]
        : [];
    }
  );
}

function attachmentMetadata(
  references: TemporaryAttachmentReference[],
  displayText: string
): Record<string, unknown> {
  return {
    repositoryAttachments: references,
    repositoryAttachmentDisplayText: displayText,
  };
}

function removeUntrustedAttachmentMetadata(
  part: Record<string, unknown>
): Record<string, unknown> {
  if (
    !part.metadata ||
    typeof part.metadata !== "object" ||
    Array.isArray(part.metadata)
  ) {
    return part;
  }
  const {
    repositoryAttachments: _repositoryAttachments,
    repositoryAttachmentDisplayText: _repositoryAttachmentDisplayText,
    ...metadata
  } = part.metadata as Record<string, unknown>;
  return {
    ...part,
    ...(Object.keys(metadata).length > 0 ? { metadata } : { metadata: undefined }),
  };
}

function normalizeMessagePart(
  value: unknown,
  labels: readonly AuthoritativeTemporaryAttachmentLabel[]
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return stripMarkersFromUnknown(value, labels);
  }
  const part = value as Record<string, unknown>;
  const references = authoritativeReferencesForValue(part, labels);
  const sanitized = removeUntrustedAttachmentMetadata(
    stripMarkersFromUnknown(part, labels) as Record<string, unknown>
  );
  if (
    references.length > 0 &&
    (part.type === "document" || part.type === "file")
  ) {
    return {
      type: "text",
      text: references
        .map((reference) => `[Attached repository content: ${reference.name}]`)
        .join("\n"),
      metadata: attachmentMetadata(references, ""),
    };
  }
  if (
    references.length > 0 &&
    part.type === "text" &&
    typeof part.text === "string"
  ) {
    return {
      ...sanitized,
      metadata: attachmentMetadata(
        references,
        removeTemporaryAttachmentMarkers(part.text)
      ),
    };
  }
  return sanitized;
}

function removeAttachmentMetadataForModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeAttachmentMetadataForModel);
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sanitized = Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      removeAttachmentMetadataForModel(nested),
    ])
  );
  if (
    sanitized.metadata &&
    typeof sanitized.metadata === "object" &&
    !Array.isArray(sanitized.metadata)
  ) {
    const {
      repositoryAttachments: _repositoryAttachments,
      repositoryAttachmentDisplayText: _repositoryAttachmentDisplayText,
      ...metadata
    } = sanitized.metadata as Record<string, unknown>;
    if (Object.keys(metadata).length > 0) {
      sanitized.metadata = metadata;
    } else {
      delete sanitized.metadata;
    }
  }
  return sanitized;
}

/**
 * Extract opaque canonical attachment references and replace their markers with
 * authoritative human-readable labels. `messages` retains server-created
 * metadata for durable UI reconstruction; `modelMessages` removes that metadata
 * so binding/item identifiers never enter safety, routing, or provider code.
 * Neither representation contains source bytes or extracted source text.
 */
export function prepareRepositoryAttachmentMessages(
  messages: UIMessage[],
  authoritativeLabels: readonly AuthoritativeTemporaryAttachmentLabel[]
): {
  messages: UIMessage[];
  modelMessages: UIMessage[];
  references: TemporaryAttachmentReference[];
} {
  const references = authoritativeReferencesForValue(
    messages,
    authoritativeLabels
  );
  const hasMarkers = messages.flatMap(referencesFromUnknown).length > 0;
  if (!hasMarkers) {
    return {
      messages,
      modelMessages: removeAttachmentMetadataForModel(messages) as UIMessage[],
      references,
    };
  }
  const preparedMessages = messages.map((message) => ({
      ...message,
      parts: Array.isArray(message.parts)
        ? message.parts.map((part) =>
            normalizeMessagePart(part, authoritativeLabels)
          ) as UIMessage["parts"]
        : message.parts,
      ...("content" in message
        ? {
            content: stripMarkersFromUnknown(
              (message as unknown as Record<string, unknown>).content,
              authoritativeLabels
            ),
          }
        : {}),
    }));
  return {
    messages: preparedMessages,
    modelMessages: removeAttachmentMetadataForModel(
      preparedMessages
    ) as UIMessage[],
    references,
  };
}

export function repositoryAttachmentLabels(
  value: unknown
): Array<{ text: string; reference: TemporaryAttachmentReference }> {
  return deduplicateReferences(referencesFromUnknown(value)).map((reference) => ({
    text: `[Attached repository content: ${reference.name}]`,
    reference,
  }));
}
