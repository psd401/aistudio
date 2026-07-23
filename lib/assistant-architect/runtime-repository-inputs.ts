import { resolveNexusAttachmentReference } from "@/lib/nexus/ephemeral-repository-service";
import {
  prepareTemporaryAttachmentValueWithAuthoritativeLabels,
  sanitizeTemporaryAttachmentName,
  temporaryAttachmentReferencesFromValue,
  type AuthoritativeTemporaryAttachmentLabel,
  type TemporaryAttachmentReference,
} from "@/lib/repositories/temporary-attachment-contract";

export interface AssistantRuntimeRepositoryInputs {
  repositoryIds: number[];
  queryContext: string;
  references: TemporaryAttachmentReference[];
  modelInputs: Record<string, unknown>;
}

export class AssistantRuntimeRepositoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantRuntimeRepositoryInputError";
  }
}

export async function resolveAssistantRuntimeRepositoryInputs(
  inputs: Record<string, unknown>,
  ownerId: number
): Promise<AssistantRuntimeRepositoryInputs> {
  const references = [
    ...new Map(
      temporaryAttachmentReferencesFromValue(inputs).map((reference) => [
        `${reference.bindingId}:${reference.itemId}`,
        reference,
      ])
    ).values(),
  ];
  if (references.length > 10) {
    throw new AssistantRuntimeRepositoryInputError(
      "Too many temporary repository inputs"
    );
  }

  const resolved = await Promise.all(
    references.map((reference) =>
      resolveNexusAttachmentReference({
        ownerId,
        bindingId: reference.bindingId,
        itemId: reference.itemId,
      })
    )
  );
  if (resolved.includes(null)) {
    throw new AssistantRuntimeRepositoryInputError(
      "Temporary repository input is unavailable"
    );
  }

  const authoritativeLabels: AuthoritativeTemporaryAttachmentLabel[] =
    references.map((reference, index) => ({
      bindingId: reference.bindingId,
      itemId: reference.itemId,
      name: resolved[index]?.itemName ?? "attachment",
    }));

  return {
    repositoryIds: [
      ...new Set(
        resolved.flatMap((reference) =>
          reference ? [reference.repositoryId] : []
        )
      ),
    ],
    queryContext: authoritativeLabels
      .map(
        (reference) =>
          `Attached source: ${sanitizeTemporaryAttachmentName(reference.name)}`
      )
      .join("\n"),
    references: authoritativeLabels,
    modelInputs:
      prepareTemporaryAttachmentValueWithAuthoritativeLabels(
        inputs,
        authoritativeLabels
      ) as Record<string, unknown>,
  };
}
