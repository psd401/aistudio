import { and, eq, ne, sql } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryArtifacts,
  repositoryIndexGenerations,
  repositoryItemChunks,
  repositoryItems,
  repositoryItemVersions,
  type RepositoryInspectionStatus,
} from "@/lib/db/schema";
import type { PdfSegment } from "./pdf-processing";

export interface PublishPdfVersionInput {
  itemVersionId: string;
  processorVersion: string;
  inspectionStatus: Extract<
    RepositoryInspectionStatus,
    "clean" | "not_required"
  >;
  inspectionDetails?: Record<string, unknown>;
  malwareScanRequired: boolean;
  canonicalText?: string;
  canonicalTextObjectKey?: string;
  segments: PdfSegment[];
  embeddingModel?: string;
  embeddingDimensions?: number;
}

export interface PublishPdfVersionResult {
  artifactId: string;
  generationId: string;
  segmentCount: number;
  replayed: boolean;
}

export const MAX_INLINE_ARTIFACT_CHARACTERS = 1_000_000;

function artifactKey(input: PublishPdfVersionInput): string {
  return `${input.itemVersionId}:canonical_text:${input.processorVersion}`;
}

function validatePublicationInput(input: PublishPdfVersionInput): void {
  if (!input.itemVersionId.trim()) throw new Error("Item version id is required");
  if (!input.processorVersion.trim()) throw new Error("Processor version is required");
  if (input.malwareScanRequired && input.inspectionStatus !== "clean") {
    throw new Error("A clean malware inspection is required before publication");
  }
  if (!input.canonicalText && !input.canonicalTextObjectKey) {
    throw new Error("Canonical text or its object key is required");
  }
  if (
    input.canonicalText &&
    input.canonicalText.length > MAX_INLINE_ARTIFACT_CHARACTERS &&
    !input.canonicalTextObjectKey
  ) {
    throw new Error("Large canonical text must be stored as an artifact object");
  }
  if (input.segments.length === 0) {
    throw new Error("At least one searchable segment is required");
  }
  for (const [index, segment] of input.segments.entries()) {
    if (segment.chunkIndex !== index) {
      throw new Error("Segments must have contiguous zero-based chunk indexes");
    }
    if (!segment.content.trim()) throw new Error("Segments cannot be empty");
    if (!/^[0-9a-f]{64}$/.test(segment.contentHash)) {
      throw new Error("Every segment requires a lowercase SHA-256 content hash");
    }
    if (!segment.sourceLocator.page) {
      throw new Error("Every PDF segment requires a page citation");
    }
  }
}

/**
 * Atomically publish one processed PDF into a new repository index generation.
 * The current generation is copied forward (excluding this logical item), new
 * segments are added, and only then is the generation pointer swapped. A crash
 * before commit leaves the prior active generation untouched.
 */
export async function publishPdfVersion(
  input: PublishPdfVersionInput
): Promise<PublishPdfVersionResult> {
  validatePublicationInput(input);
  const key = artifactKey(input);

  return executeTransaction(
    async (tx) => {
      const [context] = await tx
        .select({
          itemId: repositoryItemVersions.itemId,
          processingStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          repositoryId: repositoryItems.repositoryId,
          currentVersionId: repositoryItems.currentVersionId,
          activeGenerationId: knowledgeRepositories.activeIndexGenerationId,
        })
        .from(repositoryItemVersions)
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.id, repositoryItemVersions.itemId)
        )
        .innerJoin(
          knowledgeRepositories,
          eq(knowledgeRepositories.id, repositoryItems.repositoryId)
        )
        .where(eq(repositoryItemVersions.id, input.itemVersionId))
        .limit(1)
        .for("update");
      if (!context) throw new Error("Repository item version was not found");
      if (context.currentVersionId !== input.itemVersionId) {
        throw new Error("A superseded item version cannot become searchable");
      }

      const [existingArtifact] = await tx
        .select({ id: repositoryArtifacts.id })
        .from(repositoryArtifacts)
        .where(eq(repositoryArtifacts.artifactKey, key))
        .limit(1);

      if (
        existingArtifact &&
        context.processingStatus === "completed" &&
        context.storageStatus === "available" &&
        context.activeGenerationId
      ) {
        const [publishedChunk] = await tx
          .select({ generationId: repositoryItemChunks.indexGenerationId })
          .from(repositoryItemChunks)
          .where(
            and(
              eq(repositoryItemChunks.itemVersionId, input.itemVersionId),
              eq(
                repositoryItemChunks.indexGenerationId,
                context.activeGenerationId
              )
            )
          )
          .limit(1);
        if (publishedChunk?.generationId) {
          return {
            artifactId: existingArtifact.id,
            generationId: publishedChunk.generationId,
            segmentCount: input.segments.length,
            replayed: true,
          };
        }
      }

      const [createdArtifact] = existingArtifact
        ? [existingArtifact]
        : await tx
            .insert(repositoryArtifacts)
            .values({
              itemVersionId: input.itemVersionId,
              artifactKey: key,
              kind: "canonical_text",
              mediaType: "text/markdown",
              objectKey: input.canonicalTextObjectKey,
              textInline:
                input.canonicalText &&
                input.canonicalText.length <= MAX_INLINE_ARTIFACT_CHARACTERS
                  ? input.canonicalText
                  : undefined,
              pageFrom: Math.min(
                ...input.segments.map(
                  (segment) => segment.sourceLocator.page ?? Number.MAX_SAFE_INTEGER
                )
              ),
              pageTo: Math.max(
                ...input.segments.map(
                  (segment) => segment.sourceLocator.pageEnd ?? 0
                )
              ),
              processorName: "aistudio-pdf",
              processorVersion: input.processorVersion,
              metadata: { segmentCount: input.segments.length },
            })
            .returning({ id: repositoryArtifacts.id });
      if (!createdArtifact) throw new Error("Failed to create canonical artifact");

      const [generation] = await tx
        .insert(repositoryIndexGenerations)
        .values({
          repositoryId: context.repositoryId,
          status: "building",
          embeddingModel: input.embeddingModel,
          embeddingDimensions: input.embeddingDimensions,
          processorVersion: input.processorVersion,
        })
        .returning({ id: repositoryIndexGenerations.id });
      if (!generation) throw new Error("Failed to create index generation");

      if (context.activeGenerationId) {
        await tx.execute(sql`
          INSERT INTO repository_item_chunks (
            item_id, item_version_id, artifact_id, index_generation_id,
            content, chunk_index, metadata, modality, content_hash,
            source_locator, embedding, tokens, created_at
          )
          SELECT
            item_id, item_version_id, artifact_id, ${generation.id},
            content, chunk_index, metadata, modality, content_hash,
            source_locator, embedding, tokens, now()
          FROM repository_item_chunks
          WHERE index_generation_id = ${context.activeGenerationId}
            AND item_id <> ${context.itemId}
        `);
      }

      await tx.insert(repositoryItemChunks).values(
        input.segments.map((segment) => ({
          itemId: context.itemId,
          itemVersionId: input.itemVersionId,
          artifactId: createdArtifact.id,
          indexGenerationId: generation.id,
          content: segment.content,
          chunkIndex: segment.chunkIndex,
          metadata: { processorVersion: input.processorVersion },
          modality: "text" as const,
          contentHash: segment.contentHash,
          sourceLocator: segment.sourceLocator,
          tokens: segment.tokens,
        }))
      );

      const [counts] = await tx.execute<{
        source_version_count: number;
        segment_count: number;
      }>(sql`
        SELECT
          count(DISTINCT item_version_id)::integer AS source_version_count,
          count(*)::integer AS segment_count
        FROM repository_item_chunks
        WHERE index_generation_id = ${generation.id}
      `);

      if (context.activeGenerationId) {
        await tx
          .update(repositoryIndexGenerations)
          .set({ status: "superseded" })
          .where(
            and(
              eq(repositoryIndexGenerations.id, context.activeGenerationId),
              ne(repositoryIndexGenerations.status, "superseded")
            )
          );
      }

      const publishedAt = new Date();
      await tx
        .update(repositoryIndexGenerations)
        .set({
          status: "active",
          sourceVersionCount: counts?.source_version_count ?? 1,
          segmentCount: counts?.segment_count ?? input.segments.length,
          publishedAt,
        })
        .where(eq(repositoryIndexGenerations.id, generation.id));
      await tx
        .update(knowledgeRepositories)
        .set({ activeIndexGenerationId: generation.id, updatedAt: publishedAt })
        .where(eq(knowledgeRepositories.id, context.repositoryId));
      await tx
        .update(repositoryItemVersions)
        .set({
          detectedContentType: "application/pdf",
          inspectionStatus: input.inspectionStatus,
          inspectionDetails: input.inspectionDetails ?? {},
          storageStatus: "available",
          processingStatus: "completed",
          processorVersion: input.processorVersion,
        })
        .where(eq(repositoryItemVersions.id, input.itemVersionId));
      await tx
        .update(repositoryItems)
        .set({ processingStatus: "completed", processingError: null, updatedAt: publishedAt })
        .where(eq(repositoryItems.id, context.itemId));

      return {
        artifactId: createdArtifact.id,
        generationId: generation.id,
        segmentCount: input.segments.length,
        replayed: false,
      };
    },
    "contentPlatform.publishPdfVersion",
    { isolationLevel: "serializable" }
  );
}
