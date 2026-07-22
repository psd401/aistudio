import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryArtifacts,
  repositoryIndexGenerations,
  repositoryItemChunks,
  repositoryItems,
  repositoryItemVersions,
  type RepositoryArtifactKind,
  type RepositoryInspectionStatus,
  type RepositorySegmentAccessScope,
  type RepositorySourceLocator,
  type RepositorySourceRegion,
} from "@/lib/db/schema";
import type { PdfSegment } from "./pdf-processing";
import { canReuseRepositoryEmbeddings } from "@/lib/repositories/embedding-configuration";

export interface PublishableSegment {
  content: string;
  contentHash: string;
  chunkIndex: number;
  tokens: number;
  sourceLocator: RepositorySourceLocator;
  modality?: "text" | "image" | "audio" | "video" | "table";
  contextPrefix?: string;
  segmentLevel?: "document" | "section" | "chunk";
  parentChunkIndex?: number;
  accessScope?: RepositorySegmentAccessScope;
}
export interface PublishableArtifact {
  kind: Exclude<RepositoryArtifactKind, "canonical_text">;
  mediaType: string;
  objectKey?: string;
  textInline?: string;
  sha256?: string;
  timeStartMs?: number;
  timeEndMs?: number;
  sourceRegions?: RepositorySourceRegion[];
  metadata?: Record<string, unknown>;
}

export interface PublishDocumentVersionInput {
  itemVersionId: string;
  processorVersion: string;
  processorName: string;
  detectedContentType: string;
  inspectionStatus: Extract<
    RepositoryInspectionStatus,
    "clean" | "not_required"
  >;
  inspectionDetails?: Record<string, unknown>;
  malwareScanRequired: boolean;
  canonicalText?: string;
  canonicalTextObjectKey?: string;
  segments: PublishableSegment[];
  artifactMetadata?: Record<string, unknown>;
  additionalArtifacts?: PublishableArtifact[];
  embeddingModel?: string;
  embeddingDimensions?: number;
  visualEmbeddingModel?: string;
  visualEmbeddingDimensions?: number;
  segmentationVersion?: string;
}

export type PublishPdfVersionInput = Omit<
  PublishDocumentVersionInput,
  "processorName" | "detectedContentType" | "segments"
> & { segments: PdfSegment[] };

export interface PublishDocumentVersionResult {
  artifactId: string;
  generationId: string;
  segmentCount: number;
  replayed: boolean;
}

export type PublishPdfVersionResult = PublishDocumentVersionResult;

export const MAX_INLINE_ARTIFACT_CHARACTERS = 1_000_000;

function artifactKey(input: PublishDocumentVersionInput): string {
  return `${input.itemVersionId}:canonical_text:${input.processorVersion}`;
}

function additionalArtifactKey(
  input: PublishDocumentVersionInput,
  artifact: PublishableArtifact
): string {
  return `${input.itemVersionId}:${artifact.kind}:${input.processorVersion}`;
}

function validatePublicationInput(input: PublishDocumentVersionInput): void {
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
    if (Object.keys(segment.sourceLocator).length === 0) {
      throw new Error("Every segment requires a source citation");
    }
  }
  const artifactKinds = new Set<RepositoryArtifactKind>();
  for (const artifact of input.additionalArtifacts ?? []) {
    if (artifactKinds.has(artifact.kind)) {
      throw new Error("Additional artifact kinds must be unique per publication");
    }
    artifactKinds.add(artifact.kind);
    if (!artifact.mediaType.trim()) {
      throw new Error("Every additional artifact requires a media type");
    }
    if (!artifact.objectKey && !artifact.textInline) {
      throw new Error("Every additional artifact requires an object or inline text");
    }
    if (
      artifact.textInline &&
      artifact.textInline.length > MAX_INLINE_ARTIFACT_CHARACTERS
    ) {
      throw new Error("Large additional artifact text must be stored as an object");
    }
    if (artifact.sha256 && !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error("Additional artifact SHA-256 values must be lowercase hex");
    }
    const timeStartMs = artifact.timeStartMs;
    const timeEndMs = artifact.timeEndMs;
    if (
      (timeStartMs == null) !== (timeEndMs == null) ||
      (timeStartMs != null &&
        timeEndMs != null &&
        (!Number.isSafeInteger(timeStartMs) ||
          !Number.isSafeInteger(timeEndMs) ||
          timeStartMs < 0 ||
          timeEndMs < timeStartMs))
    ) {
      throw new Error("Artifact time ranges must be complete non-negative milliseconds");
    }
  }
}

/**
 * Atomically publish one processed document into a new repository index generation.
 * The newest building generation (or current active generation) is copied
 * forward, excluding this logical item. Generations that require embeddings
 * remain building until the embedding worker atomically swaps the pointer.
 */
export async function publishDocumentVersion(
  input: PublishDocumentVersionInput
): Promise<PublishDocumentVersionResult> {
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

      const [buildingGeneration] = await tx
        .select({ id: repositoryIndexGenerations.id })
        .from(repositoryIndexGenerations)
        .where(
          and(
            eq(repositoryIndexGenerations.repositoryId, context.repositoryId),
            eq(repositoryIndexGenerations.status, "building")
          )
        )
        .orderBy(desc(repositoryIndexGenerations.createdAt))
        .limit(1)
        .for("update");
      const sourceGenerationId =
        buildingGeneration?.id ?? context.activeGenerationId;

      const [existingArtifact] = await tx
        .select({ id: repositoryArtifacts.id })
        .from(repositoryArtifacts)
        .where(eq(repositoryArtifacts.artifactKey, key))
        .limit(1);

      if (
        existingArtifact &&
        context.processingStatus === "completed" &&
        context.storageStatus === "available" &&
        sourceGenerationId
      ) {
        const [publishedChunk] = await tx
          .select({ generationId: repositoryItemChunks.indexGenerationId })
          .from(repositoryItemChunks)
          .innerJoin(
            repositoryIndexGenerations,
            eq(
              repositoryIndexGenerations.id,
              repositoryItemChunks.indexGenerationId
            )
          )
          .where(
            and(
              eq(repositoryItemChunks.itemVersionId, input.itemVersionId),
              inArray(repositoryIndexGenerations.status, ["building", "active"])
            )
          )
          .orderBy(desc(repositoryIndexGenerations.createdAt))
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

      const citedPages = input.segments.flatMap((segment) => {
        const first = segment.sourceLocator.page;
        if (!first) return [];
        return [first, segment.sourceLocator.pageEnd ?? first];
      });
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
              pageFrom: citedPages.length > 0 ? Math.min(...citedPages) : undefined,
              pageTo: citedPages.length > 0 ? Math.max(...citedPages) : undefined,
              processorName: input.processorName,
              processorVersion: input.processorVersion,
              metadata: {
                ...input.artifactMetadata,
                segmentCount: input.segments.length,
                detectedContentType: input.detectedContentType,
              },
            })
            .returning({ id: repositoryArtifacts.id });
      if (!createdArtifact) throw new Error("Failed to create canonical artifact");

      let reuseActiveEmbeddings = true;
      let reuseActiveVisualEmbeddings = true;
      if (sourceGenerationId) {
        const [activeGeneration] = await tx
          .select({
            embeddingModel: repositoryIndexGenerations.embeddingModel,
            embeddingDimensions:
              repositoryIndexGenerations.embeddingDimensions,
            visualEmbeddingModel:
              repositoryIndexGenerations.visualEmbeddingModel,
            visualEmbeddingDimensions:
              repositoryIndexGenerations.visualEmbeddingDimensions,
          })
          .from(repositoryIndexGenerations)
          .where(
            eq(repositoryIndexGenerations.id, sourceGenerationId)
          )
          .limit(1);
        reuseActiveEmbeddings = canReuseRepositoryEmbeddings(
          activeGeneration?.embeddingModel,
          activeGeneration?.embeddingDimensions,
          input.embeddingModel,
          input.embeddingDimensions
        );
        reuseActiveVisualEmbeddings = canReuseRepositoryEmbeddings(
          activeGeneration?.visualEmbeddingModel,
          activeGeneration?.visualEmbeddingDimensions,
          input.visualEmbeddingModel,
          input.visualEmbeddingDimensions
        );
      }

      for (const artifact of input.additionalArtifacts ?? []) {
        const key = additionalArtifactKey(input, artifact);
        const [existing] = await tx
          .select({ id: repositoryArtifacts.id })
          .from(repositoryArtifacts)
          .where(eq(repositoryArtifacts.artifactKey, key))
          .limit(1);
        if (existing) continue;
        await tx.insert(repositoryArtifacts).values({
          itemVersionId: input.itemVersionId,
          artifactKey: key,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          objectKey: artifact.objectKey,
          textInline: artifact.textInline,
          sha256: artifact.sha256,
          timeStartMs: artifact.timeStartMs,
          timeEndMs: artifact.timeEndMs,
          sourceRegions: artifact.sourceRegions ?? [],
          processorName: input.processorName,
          processorVersion: input.processorVersion,
          metadata: artifact.metadata ?? {},
        });
      }

      const [generation] = await tx
        .insert(repositoryIndexGenerations)
        .values({
          repositoryId: context.repositoryId,
          status: "building",
          embeddingModel: input.embeddingModel,
          embeddingDimensions: input.embeddingDimensions,
          visualEmbeddingModel: input.visualEmbeddingModel,
          visualEmbeddingDimensions: input.visualEmbeddingDimensions,
          segmentationVersion: input.segmentationVersion ?? "retrieval-v2",
          processorVersion: input.processorVersion,
        })
        .returning({ id: repositoryIndexGenerations.id });
      if (!generation) throw new Error("Failed to create index generation");

      if (sourceGenerationId) {
        await tx.execute(sql`
          INSERT INTO repository_item_chunks (
            item_id, item_version_id, artifact_id, index_generation_id,
            content, chunk_index, metadata, modality, content_hash,
            source_locator, context_prefix, segment_level, parent_chunk_index,
            access_scope, embedding, visual_embedding, tokens, created_at
          )
          SELECT
            item_id, item_version_id, artifact_id, ${generation.id},
            content, chunk_index, metadata, modality, content_hash,
            source_locator, context_prefix, segment_level, parent_chunk_index,
            access_scope,
            CASE WHEN ${reuseActiveEmbeddings} THEN embedding ELSE NULL END,
            CASE WHEN ${reuseActiveVisualEmbeddings} THEN visual_embedding ELSE NULL END,
            tokens, now()
          FROM repository_item_chunks
          WHERE index_generation_id = ${sourceGenerationId}
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
          modality: segment.modality ?? "text",
          contentHash: segment.contentHash,
          sourceLocator: segment.sourceLocator,
          contextPrefix: segment.contextPrefix ?? "",
          segmentLevel: segment.segmentLevel ?? "chunk",
          parentChunkIndex: segment.parentChunkIndex,
          accessScope: segment.accessScope ?? {},
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

      if (buildingGeneration) {
        await tx
          .update(repositoryIndexGenerations)
          .set({ status: "superseded" })
          .where(
            and(
              eq(repositoryIndexGenerations.id, buildingGeneration.id),
              ne(repositoryIndexGenerations.status, "superseded")
            )
          );
      }

      const publishedAt = new Date();
      const requiresEmbedding = Boolean(
        input.embeddingModel && input.embeddingDimensions
      );
      if (!requiresEmbedding && context.activeGenerationId) {
        await tx
          .update(repositoryIndexGenerations)
          .set({ status: "superseded" })
          .where(
            and(
              eq(repositoryIndexGenerations.id, context.activeGenerationId),
              ne(repositoryIndexGenerations.id, generation.id)
            )
          );
      }
      await tx
        .update(repositoryIndexGenerations)
        .set({
          status: requiresEmbedding ? "building" : "active",
          sourceVersionCount: counts?.source_version_count ?? 1,
          segmentCount: counts?.segment_count ?? input.segments.length,
          publishedAt: requiresEmbedding ? null : publishedAt,
        })
        .where(eq(repositoryIndexGenerations.id, generation.id));
      if (!requiresEmbedding) {
        await tx
          .update(knowledgeRepositories)
          .set({ activeIndexGenerationId: generation.id, updatedAt: publishedAt })
          .where(eq(knowledgeRepositories.id, context.repositoryId));
      }
      await tx
        .update(repositoryItemVersions)
        .set({
          detectedContentType: input.detectedContentType,
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
    "contentPlatform.publishDocumentVersion",
    { isolationLevel: "serializable" }
  );
}

/** Backwards-compatible PDF entry point with a stricter page-citation guard. */
export async function publishPdfVersion(
  input: PublishPdfVersionInput
): Promise<PublishPdfVersionResult> {
  if (input.segments.some((segment) => !segment.sourceLocator.page)) {
    throw new Error("Every PDF segment requires a page citation");
  }
  return publishDocumentVersion({
    ...input,
    processorName: "aistudio-pdf",
    detectedContentType: "application/pdf",
  });
}
