import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
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
  canonicalTextSha256?: string;
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

export interface PublicationTargetLifecycle {
  repositoryLifecycleStatus: "active" | "expired" | "deleting" | "deleted";
  repositoryExpiresAt: Date | null;
  itemLifecycleStatus:
    | "active"
    | "unavailable"
    | "expired"
    | "deleting"
    | "deleted";
}

export function isPublicationTargetActive(
  target: PublicationTargetLifecycle,
  now = new Date()
): boolean {
  const repositoryExpiresAt = target.repositoryExpiresAt?.getTime();
  return (
    target.repositoryLifecycleStatus === "active" &&
    (repositoryExpiresAt === undefined ||
      (!Number.isNaN(repositoryExpiresAt) &&
        repositoryExpiresAt > now.getTime())) &&
    target.itemLifecycleStatus === "active"
  );
}

export type PublishPdfVersionResult = PublishDocumentVersionResult;

export const MAX_INLINE_ARTIFACT_CHARACTERS = 1_000_000;
export const REPOSITORY_PUBLICATION_STATEMENT_TIMEOUT_MS = 240_000;
export const REPOSITORY_PUBLICATION_TRANSACTION_DEADLINE_MS = 270_000;

interface ExistingCanonicalArtifact {
  id: string;
  itemVersionId: string;
  kind: RepositoryArtifactKind;
  objectKey: string | null;
  textInline: string | null;
  processorName: string;
  processorVersion: string;
  sha256: string | null;
}

function canonicalArtifactCoordinatesMatch(
  input: PublishDocumentVersionInput,
  artifact: ExistingCanonicalArtifact
): boolean {
  return (
    artifact.itemVersionId === input.itemVersionId &&
    artifact.kind === "canonical_text" &&
    artifact.processorName === input.processorName &&
    artifact.processorVersion === input.processorVersion
  );
}

function assertCanonicalArtifactReplayBinding(
  input: PublishDocumentVersionInput,
  artifact: ExistingCanonicalArtifact,
  canonicalTextSha256: string
): void {
  if (!canonicalArtifactCoordinatesMatch(input, artifact)) {
    throw new Error(
      "Existing canonical artifact coordinates do not match the replay"
    );
  }
  if (artifact.objectKey !== (input.canonicalTextObjectKey ?? null)) {
    throw new Error(
      "Existing canonical artifact object key does not match the replay"
    );
  }
  if (
    artifact.textInline !== null &&
    artifact.textInline !== (input.canonicalText ?? null)
  ) {
    throw new Error(
      "Existing canonical artifact inline text does not match the replay"
    );
  }
  if (artifact.objectKey === null && artifact.textInline === null) {
    throw new Error("Existing canonical artifact has no bound payload");
  }
  const storedSha256 =
    artifact.sha256 ??
    (artifact.textInline
      ? createHash("sha256").update(artifact.textInline).digest("hex")
      : null);
  if (storedSha256 && storedSha256 !== canonicalTextSha256) {
    throw new Error(
      "Existing canonical artifact SHA-256 does not match the replay"
    );
  }
}

/**
 * Repository publication copies the previous immutable generation before
 * swapping in one changed item. Large repositories can legitimately exceed
 * the dev pool's global 60-second statement limit while copying vectors.
 */
export async function configureRepositoryPublicationTransaction(
  tx: {
    execute(query: string | SQLWrapper): PromiseLike<unknown>;
  }
): Promise<void> {
  await tx.execute(sql`
    SELECT set_config(
      'statement_timeout',
      ${REPOSITORY_PUBLICATION_STATEMENT_TIMEOUT_MS.toString()},
      true
    )
  `);
}

function artifactKey(input: PublishDocumentVersionInput): string {
  return `${input.itemVersionId}:canonical_text:${input.processorVersion}`;
}

function additionalArtifactKey(
  input: PublishDocumentVersionInput,
  artifact: PublishableArtifact
): string {
  return `${input.itemVersionId}:${artifact.kind}:${input.processorVersion}`;
}

function validateCanonicalArtifact(input: PublishDocumentVersionInput): void {
  if (input.malwareScanRequired && input.inspectionStatus !== "clean") {
    throw new Error("A clean malware inspection is required before publication");
  }
  if (!input.canonicalText && !input.canonicalTextObjectKey) {
    throw new Error("Canonical text or its object key is required");
  }
  if (
    input.canonicalTextSha256 &&
    !/^[0-9a-f]{64}$/.test(input.canonicalTextSha256)
  ) {
    throw new Error("Canonical text SHA-256 must be lowercase hex");
  }
  if (
    input.canonicalTextObjectKey &&
    !input.canonicalText &&
    !input.canonicalTextSha256
  ) {
    throw new Error("Object-backed canonical text requires a SHA-256");
  }
  if (
    input.canonicalText &&
    input.canonicalText.length > MAX_INLINE_ARTIFACT_CHARACTERS &&
    !input.canonicalTextObjectKey
  ) {
      throw new Error("Large canonical text must be stored as an artifact object");
  }
}

function validateSegments(segments: PublishableSegment[]): void {
  if (segments.length === 0) {
    throw new Error("At least one searchable segment is required");
  }
  for (const [index, segment] of segments.entries()) {
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
}

function validateArtifactTimeRange(artifact: PublishableArtifact): void {
  const timeStartMs = artifact.timeStartMs;
  const timeEndMs = artifact.timeEndMs;
  const isIncomplete = (timeStartMs == null) !== (timeEndMs == null);
  const isInvalid =
    timeStartMs != null &&
    timeEndMs != null &&
    (!Number.isSafeInteger(timeStartMs) ||
      !Number.isSafeInteger(timeEndMs) ||
      timeStartMs < 0 ||
      timeEndMs < timeStartMs);
  if (isIncomplete || isInvalid) {
    throw new Error("Artifact time ranges must be complete non-negative milliseconds");
  }
}

function validateAdditionalArtifacts(
  artifacts: PublishableArtifact[]
): void {
  const artifactKinds = new Set<RepositoryArtifactKind>();
  for (const artifact of artifacts) {
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
    validateArtifactTimeRange(artifact);
  }
}

function validatePublicationInput(input: PublishDocumentVersionInput): void {
  if (!input.itemVersionId.trim()) throw new Error("Item version id is required");
  if (!input.processorVersion.trim()) throw new Error("Processor version is required");
  validateCanonicalArtifact(input);
  validateSegments(input.segments);
  validateAdditionalArtifacts(input.additionalArtifacts ?? []);
}

interface PublicationContext extends PublicationTargetLifecycle {
  itemId: number;
  repositoryId: number;
  activeGenerationId: string | null;
  currentVersionId: string | null;
  processingStatus: string;
  storageStatus: string;
}

interface PublicationGenerationState {
  buildingGeneration?: { id: string };
  sourceGenerationId: string | null;
  existingArtifact?: ExistingCanonicalArtifact;
  replay?: PublishDocumentVersionResult;
}

async function lockPublicationContext(
  tx: DbTransaction,
  itemVersionId: string
): Promise<PublicationContext> {
  const [coordinates] = await tx
    .select({
      itemId: repositoryItemVersions.itemId,
      repositoryId: repositoryItems.repositoryId,
    })
    .from(repositoryItemVersions)
    .innerJoin(
      repositoryItems,
      eq(repositoryItems.id, repositoryItemVersions.itemId)
    )
    .where(eq(repositoryItemVersions.id, itemVersionId))
    .limit(1);
  if (!coordinates) throw new Error("Repository item version was not found");

  const [repository] = await tx
    .select({
      repositoryLifecycleStatus: knowledgeRepositories.lifecycleStatus,
      repositoryExpiresAt: knowledgeRepositories.expiresAt,
      activeGenerationId: knowledgeRepositories.activeIndexGenerationId,
    })
    .from(knowledgeRepositories)
    .where(eq(knowledgeRepositories.id, coordinates.repositoryId))
    .limit(1)
    .for("update");
  const [item] = await tx
    .select({
      currentVersionId: repositoryItems.currentVersionId,
      itemLifecycleStatus: repositoryItems.lifecycleStatus,
    })
    .from(repositoryItems)
    .where(
      and(
        eq(repositoryItems.id, coordinates.itemId),
        eq(repositoryItems.repositoryId, coordinates.repositoryId)
      )
    )
    .limit(1)
    .for("update");
  const [version] = await tx
    .select({
      processingStatus: repositoryItemVersions.processingStatus,
      storageStatus: repositoryItemVersions.storageStatus,
    })
    .from(repositoryItemVersions)
    .where(
      and(
        eq(repositoryItemVersions.id, itemVersionId),
        eq(repositoryItemVersions.itemId, coordinates.itemId)
      )
    )
    .limit(1)
    .for("update");
  if (!repository || !item || !version) {
    throw new Error("Repository item version was not found");
  }
  const context = { ...coordinates, ...repository, ...item, ...version };
  if (!isPublicationTargetActive(context)) {
    throw new Error(
      "A version in an inactive repository or item cannot become searchable"
    );
  }
  if (context.currentVersionId !== itemVersionId) {
    throw new Error("A superseded item version cannot become searchable");
  }
  return context;
}

async function loadPublicationGenerationState(
  tx: DbTransaction,
  input: PublishDocumentVersionInput,
  context: PublicationContext,
  key: string,
  canonicalTextSha256: string
): Promise<PublicationGenerationState> {
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
    .select({
      id: repositoryArtifacts.id,
      itemVersionId: repositoryArtifacts.itemVersionId,
      kind: repositoryArtifacts.kind,
      objectKey: repositoryArtifacts.objectKey,
      textInline: repositoryArtifacts.textInline,
      processorName: repositoryArtifacts.processorName,
      processorVersion: repositoryArtifacts.processorVersion,
      sha256: repositoryArtifacts.sha256,
    })
    .from(repositoryArtifacts)
    .where(eq(repositoryArtifacts.artifactKey, key))
    .limit(1);
  if (existingArtifact) {
    assertCanonicalArtifactReplayBinding(
      input,
      existingArtifact,
      canonicalTextSha256
    );
    if (existingArtifact.sha256 === null) {
      await tx
        .update(repositoryArtifacts)
        .set({ sha256: canonicalTextSha256 })
        .where(
          and(
            eq(repositoryArtifacts.id, existingArtifact.id),
            isNull(repositoryArtifacts.sha256)
          )
        );
    }
  }

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
        buildingGeneration,
        sourceGenerationId,
        existingArtifact,
        replay: {
          artifactId: existingArtifact.id,
          generationId: publishedChunk.generationId,
          segmentCount: input.segments.length,
          replayed: true,
        },
      };
    }
  }
  return { buildingGeneration, sourceGenerationId, existingArtifact };
}

async function ensureCanonicalArtifact(
  tx: DbTransaction,
  input: PublishDocumentVersionInput,
  existingArtifact: ExistingCanonicalArtifact | undefined,
  key: string,
  canonicalTextSha256: string
): Promise<{ id: string }> {
  if (existingArtifact) return existingArtifact;
  const citedPages = input.segments.flatMap((segment) => {
    const first = segment.sourceLocator.page;
    return first
      ? [first, segment.sourceLocator.pageEnd ?? first]
      : [];
  });
  const [createdArtifact] = await tx
    .insert(repositoryArtifacts)
    .values({
      itemVersionId: input.itemVersionId,
      artifactKey: key,
      kind: "canonical_text",
      mediaType: "text/markdown",
      objectKey: input.canonicalTextObjectKey,
      sha256: canonicalTextSha256,
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
  return createdArtifact;
}

async function resolveEmbeddingReuse(
  tx: DbTransaction,
  input: PublishDocumentVersionInput,
  sourceGenerationId: string | null
): Promise<{ text: boolean; visual: boolean }> {
  if (!sourceGenerationId) return { text: true, visual: true };
  const [activeGeneration] = await tx
    .select({
      embeddingModel: repositoryIndexGenerations.embeddingModel,
      embeddingDimensions: repositoryIndexGenerations.embeddingDimensions,
      visualEmbeddingModel: repositoryIndexGenerations.visualEmbeddingModel,
      visualEmbeddingDimensions:
        repositoryIndexGenerations.visualEmbeddingDimensions,
    })
    .from(repositoryIndexGenerations)
    .where(eq(repositoryIndexGenerations.id, sourceGenerationId))
    .limit(1);
  return {
    text: canReuseRepositoryEmbeddings(
      activeGeneration?.embeddingModel,
      activeGeneration?.embeddingDimensions,
      input.embeddingModel,
      input.embeddingDimensions
    ),
    visual: canReuseRepositoryEmbeddings(
      activeGeneration?.visualEmbeddingModel,
      activeGeneration?.visualEmbeddingDimensions,
      input.visualEmbeddingModel,
      input.visualEmbeddingDimensions
    ),
  };
}

async function publishAdditionalArtifacts(
  tx: DbTransaction,
  input: PublishDocumentVersionInput
): Promise<void> {
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
}

async function createPublicationGeneration(params: {
  tx: DbTransaction;
  input: PublishDocumentVersionInput;
  context: PublicationContext;
  artifactId: string;
  sourceGenerationId: string | null;
  reuseEmbeddings: { text: boolean; visual: boolean };
}): Promise<{ id: string; sourceVersionCount: number; segmentCount: number }> {
  const { tx, input, context } = params;
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

  if (params.sourceGenerationId) {
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
        CASE WHEN ${params.reuseEmbeddings.text} THEN embedding ELSE NULL END,
        CASE WHEN ${params.reuseEmbeddings.visual} THEN visual_embedding ELSE NULL END,
        tokens, now()
      FROM repository_item_chunks
      WHERE index_generation_id = ${params.sourceGenerationId}
        AND item_id <> ${context.itemId}
    `);
  }
  await tx.insert(repositoryItemChunks).values(
    input.segments.map((segment) => ({
      itemId: context.itemId,
      itemVersionId: input.itemVersionId,
      artifactId: params.artifactId,
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
  return {
    id: generation.id,
    sourceVersionCount: counts?.source_version_count ?? 1,
    segmentCount: counts?.segment_count ?? input.segments.length,
  };
}

async function finalizePublication(params: {
  tx: DbTransaction;
  input: PublishDocumentVersionInput;
  context: PublicationContext;
  generation: {
    id: string;
    sourceVersionCount: number;
    segmentCount: number;
  };
  buildingGeneration?: { id: string };
}): Promise<void> {
  const { tx, input, context, generation } = params;
  if (params.buildingGeneration) {
    await tx
      .update(repositoryIndexGenerations)
      .set({ status: "superseded" })
      .where(
        and(
          eq(repositoryIndexGenerations.id, params.buildingGeneration.id),
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
      sourceVersionCount: generation.sourceVersionCount,
      segmentCount: generation.segmentCount,
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
    .set({
      processingStatus: "completed",
      processingError: null,
      updatedAt: publishedAt,
    })
    .where(eq(repositoryItems.id, context.itemId));
}

async function publishDocumentVersionInTransaction(
  tx: DbTransaction,
  input: PublishDocumentVersionInput,
  key: string,
  canonicalTextSha256: string
): Promise<PublishDocumentVersionResult> {
  const context = await lockPublicationContext(tx, input.itemVersionId);
  const state = await loadPublicationGenerationState(
    tx,
    input,
    context,
    key,
    canonicalTextSha256
  );
  if (state.replay) return state.replay;
  const artifact = await ensureCanonicalArtifact(
    tx,
    input,
    state.existingArtifact,
    key,
    canonicalTextSha256
  );
  const reuseEmbeddings = await resolveEmbeddingReuse(
    tx,
    input,
    state.sourceGenerationId
  );
  await publishAdditionalArtifacts(tx, input);
  const generation = await createPublicationGeneration({
    tx,
    input,
    context,
    artifactId: artifact.id,
    sourceGenerationId: state.sourceGenerationId,
    reuseEmbeddings,
  });
  await finalizePublication({
    tx,
    input,
    context,
    generation,
    buildingGeneration: state.buildingGeneration,
  });
  return {
    artifactId: artifact.id,
    generationId: generation.id,
    segmentCount: input.segments.length,
    replayed: false,
  };
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
  const canonicalTextSha256 =
    input.canonicalTextSha256 ??
    (input.canonicalText
      ? createHash("sha256").update(input.canonicalText).digest("hex")
      : undefined);
  if (!canonicalTextSha256) {
    throw new Error("Canonical text SHA-256 is required");
  }
  return executeTransaction(
    async (tx) => {
      await configureRepositoryPublicationTransaction(tx);
      return publishDocumentVersionInTransaction(
        tx,
        input,
        key,
        canonicalTextSha256
      );
    },
    "contentPlatform.publishDocumentVersion",
    {
      isolationLevel: "serializable",
      deadlineMs: REPOSITORY_PUBLICATION_TRANSACTION_DEADLINE_MS,
    }
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
