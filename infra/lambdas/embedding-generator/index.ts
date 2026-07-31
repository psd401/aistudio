/**
 * Embedding Generator Lambda
 *
 * Consumes SQS messages requesting embedding generation for repository item chunks.
 * Generates vector embeddings via OpenAI, Bedrock, or Azure, then writes them to
 * the repository_item_chunks table using Drizzle ORM.
 *
 * Migrated from AWS RDS Data API to postgres.js + Drizzle ORM (Issue #578).
 */

import { SQSEvent, SQSRecord } from 'aws-lambda';
import OpenAI from 'openai';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, closeDb } from './db-client';
import { settings, repositoryItems } from './schema';
import { shouldMarkItemEmbedded } from './completion-policy';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_EMBEDDING_PROVIDER,
  buildBedrockEmbeddingBody,
  buildCohereMultimodalEmbeddingBody,
  normalizeEmbeddingProvider,
  parseEmbeddingDescriptor,
  parseEmbeddingVector,
} from './embedding-provider';
export {
  buildBedrockEmbeddingBody as buildBedrockEmbeddingBodyForRuntimeSmoke,
  buildCohereMultimodalEmbeddingBody as buildCohereMultimodalEmbeddingBodyForRuntimeSmoke,
  normalizeEmbeddingProvider as normalizeEmbeddingProviderForRuntimeSmoke,
  parseEmbeddingVector as parseEmbeddingVectorForRuntimeSmoke,
} from './embedding-provider';
import { activateCompletedGeneration } from './generation-activation';
import {
  assertValidEmbeddingMessage,
  failBuildingGeneration,
  isTerminalEmbeddingAttempt,
  shouldSkipCanonicalGeneration,
  type EmbeddingMessage,
  type CanonicalGenerationStatus,
} from './generation-lifecycle';

const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    process.stdout.write(JSON.stringify({ level: 'INFO', message: msg, ...meta }) + '\n'),
  error: (msg: string, meta?: Record<string, unknown>) =>
    process.stderr.write(JSON.stringify({ level: 'ERROR', message: msg, ...meta }) + '\n'),
};

const EMBEDDING_KEYS = [
  'EMBEDDING_MODEL_PROVIDER',
  'EMBEDDING_MODEL_ID',
  'EMBEDDING_DIMENSIONS',
  'EMBEDDING_BATCH_SIZE',
  'OPENAI_API_KEY',
  'BEDROCK_ACCESS_KEY_ID',
  'BEDROCK_SECRET_ACCESS_KEY',
  'BEDROCK_REGION',
  'AZURE_OPENAI_KEY',
  'AZURE_OPENAI_ENDPOINT',
] as const;

const s3 = new S3Client({});
const documentsBucket = process.env.DOCUMENTS_BUCKET_NAME;
const MAX_VISUAL_SOURCE_BYTES = 5 * 1024 * 1024;

interface EmbeddingSettings {
  provider: string;
  modelId: string;
  dimensions: number;
  batchSize: number;
  openAIKey?: string;
  bedrockAccessKey?: string;
  bedrockSecretKey?: string;
  bedrockRegion?: string;
  azureKey?: string;
  azureEndpoint?: string;
}
async function getEmbeddingSettings(): Promise<EmbeddingSettings> {
  const db = await getDb();

  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      or(
        eq(settings.category, 'embeddings'),
        inArray(settings.key, [...EMBEDDING_KEYS])
      )
    );

  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.key && row.value) map[row.key] = row.value;
  }

  const dimensions = Number.parseInt(
    map['EMBEDDING_DIMENSIONS'] ?? String(DEFAULT_EMBEDDING_DIMENSIONS),
    10
  );
  const batchSize = Number.parseInt(map['EMBEDDING_BATCH_SIZE'] ?? '100', 10);
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error('EMBEDDING_DIMENSIONS must be a positive integer');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('EMBEDDING_BATCH_SIZE must be between 1 and 1000');
  }

  return {
    provider: map['EMBEDDING_MODEL_PROVIDER'] ?? DEFAULT_EMBEDDING_PROVIDER,
    modelId: map['EMBEDDING_MODEL_ID'] ?? DEFAULT_EMBEDDING_MODEL_ID,
    dimensions,
    batchSize,
    openAIKey: map['OPENAI_API_KEY'],
    bedrockAccessKey: map['BEDROCK_ACCESS_KEY_ID'],
    bedrockSecretKey: map['BEDROCK_SECRET_ACCESS_KEY'],
    bedrockRegion: map['BEDROCK_REGION'],
    azureKey: map['AZURE_OPENAI_KEY'],
    azureEndpoint: map['AZURE_OPENAI_ENDPOINT'],
  };
}

async function generateEmbeddings(texts: string[], embSettings: EmbeddingSettings): Promise<number[][]> {
  switch (normalizeEmbeddingProvider(embSettings.provider)) {
    case 'openai': {
      if (!embSettings.openAIKey) throw new Error('OpenAI API key not configured');
      const openai = new OpenAI({ apiKey: embSettings.openAIKey });
      const embeddings: number[][] = [];
      for (let i = 0; i < texts.length; i += embSettings.batchSize) {
        const batch = texts.slice(i, i + embSettings.batchSize);
        const response = await openai.embeddings.create({ model: embSettings.modelId, input: batch });
        embeddings.push(...response.data.map((item) => item.embedding));
      }
      return embeddings;
    }

    case 'amazon-bedrock': {
      const region =
        process.env.AWS_REGION ?? embSettings.bedrockRegion ?? 'us-east-1';
      let client: BedrockRuntimeClient;
      if (
        !process.env.AWS_LAMBDA_FUNCTION_NAME &&
        embSettings.bedrockAccessKey &&
        embSettings.bedrockSecretKey
      ) {
        client = new BedrockRuntimeClient({
          region,
          credentials: {
            accessKeyId: embSettings.bedrockAccessKey,
            secretAccessKey: embSettings.bedrockSecretKey,
          },
        });
      } else {
        // Lambda uses its workload role through the ambient AWS credential chain.
        client = new BedrockRuntimeClient({ region });
      }
      const embeddings: number[][] = [];
      for (const text of texts) {
        const command = new InvokeModelCommand({
          modelId: embSettings.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: buildBedrockEmbeddingBody(
            embSettings.modelId,
            text,
            embSettings.dimensions
          ),
        });
        const response = await client.send(command);
        const result = JSON.parse(
          new TextDecoder().decode(response.body)
        ) as unknown;
        embeddings.push(
          parseEmbeddingVector(
            result,
            embSettings.dimensions,
            embSettings.modelId
          )
        );
      }
      return embeddings;
    }

    case 'azure': {
      if (!embSettings.azureKey || !embSettings.azureEndpoint) {
        throw new Error('Azure OpenAI not configured');
      }
      const openai = new OpenAI({
        apiKey: embSettings.azureKey,
        baseURL: `${embSettings.azureEndpoint}/openai/deployments/${embSettings.modelId}`,
        defaultHeaders: { 'api-key': embSettings.azureKey },
        defaultQuery: { 'api-version': '2024-02-15-preview' },
      });
      const embeddings: number[][] = [];
      for (let i = 0; i < texts.length; i += embSettings.batchSize) {
        const batch = texts.slice(i, i + embSettings.batchSize);
        const response = await openai.embeddings.create({ model: embSettings.modelId, input: batch });
        embeddings.push(...response.data.map((item) => item.embedding));
      }
      return embeddings;
    }

    default:
      throw new Error(`Unsupported embedding provider: ${embSettings.provider}`);
  }
}

interface VisualEmbeddingInput {
  text: string;
  imageDataUri?: string;
}

async function generateVisualEmbeddings(
  inputs: VisualEmbeddingInput[],
  embSettings: EmbeddingSettings,
): Promise<number[][]> {
  if (
    normalizeEmbeddingProvider(embSettings.provider) !== 'amazon-bedrock' ||
    embSettings.modelId !== 'cohere.embed-v4:0'
  ) {
    throw new Error('Visual embeddings require Cohere Embed v4 on Amazon Bedrock');
  }
  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? embSettings.bedrockRegion ?? 'us-east-1',
  });
  const embeddings: number[][] = [];
  for (const input of inputs) {
    const response = await client.send(
      new InvokeModelCommand({
        modelId: embSettings.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: buildCohereMultimodalEmbeddingBody(
          embSettings.modelId,
          input,
          embSettings.dimensions,
        ),
      }),
    );
    embeddings.push(
      parseEmbeddingVector(
        JSON.parse(new TextDecoder().decode(response.body)) as unknown,
        embSettings.dimensions,
        embSettings.modelId,
      ),
    );
  }
  return embeddings;
}

async function activateCanonicalGeneration(
  db: Awaited<ReturnType<typeof getDb>>,
  generationId: string
) {
  return activateCompletedGeneration(
    generationId,
    async (plan) =>
      db.transaction(async (tx) => {
        await tx.execute(plan.lockRepository);
        await tx.execute(plan.supersedeCurrent);
        await tx.execute(plan.activateTarget);
        return (await tx.execute<{
          repository_id: number;
          embedded_item_count: number;
        }>(plan.publishTarget)) as Array<{
          repository_id: number;
          embedded_item_count: number;
        }>;
      })
  );
}

async function loadVisualDataUri(
  source: NonNullable<EmbeddingMessage['visualSources']>[number],
  cache: Map<string, string>,
): Promise<string | undefined> {
  if (!source) return undefined;
  const cached = cache.get(source.objectKey);
  if (cached) return cached;
  if (
    !documentsBucket ||
    !source.objectKey.startsWith('repositories/') ||
    source.objectKey.includes('..')
  ) {
    throw new Error('Visual embedding source is outside the repository artifact namespace');
  }
  const response = await s3.send(
    new GetObjectCommand({ Bucket: documentsBucket, Key: source.objectKey }),
  );
  if (!response.Body) throw new Error('Visual embedding source has no body');
  const bytes = await response.Body.transformToByteArray();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_VISUAL_SOURCE_BYTES) {
    throw new Error('Visual embedding source exceeds Cohere image size limits');
  }
  const uri = `data:${source.mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  cache.set(source.objectKey, uri);
  return uri;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        (error.message.includes('Invalid API key') || error.message.includes('quota exceeded'))
      ) {
        throw error;
      }
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        log.info(`Retry attempt ${attempt + 1} after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError ?? new Error('retryWithBackoff: exhausted retries with no captured error');
}

type EmbeddingDb = Awaited<ReturnType<typeof getDb>>;

async function canonicalGenerationAcceptsWrites(
  db: EmbeddingDb,
  generationId: string,
): Promise<boolean> {
  const [generation] = await db.execute<{ status: CanonicalGenerationStatus }>(
    sql`
      SELECT status
      FROM repository_index_generations
      WHERE id = ${generationId}::uuid
      LIMIT 1
    `,
  );
  return generation?.status === "building";
}

async function writeVisualEmbeddings(params: {
  db: EmbeddingDb;
  message: EmbeddingMessage;
  baseSettings: EmbeddingSettings;
  descriptor: ReturnType<typeof parseEmbeddingDescriptor>;
}): Promise<boolean> {
  const modalities =
    params.message.modalities ??
    params.message.chunkIds.map(() => 'text' as const);
  const indexes = modalities.flatMap((modality, index) =>
    modality === 'image' || modality === 'video' ? [index] : []
  );
  if (indexes.length === 0) return true;
  const visualSettings: EmbeddingSettings = {
    ...params.baseSettings,
    provider: params.descriptor.provider,
    modelId: params.descriptor.modelId,
    dimensions: params.descriptor.dimensions,
  };
  if (
    !params.message.generationId ||
    !(await canonicalGenerationAcceptsWrites(
      params.db,
      params.message.generationId,
    ))
  ) {
    log.info("Acknowledging stale visual embedding work before provider call", {
      generationId: params.message.generationId,
    });
    return false;
  }
  const sourceCache = new Map<string, string>();
  const inputs = await Promise.all(
    indexes.map(async (index) => ({
      text: params.message.texts[index] ?? '',
      imageDataUri: await loadVisualDataUri(
        params.message.visualSources?.[index] ?? null,
        sourceCache,
      ),
    })),
  );
  const embeddings = await retryWithBackoff(
    () => generateVisualEmbeddings(inputs, visualSettings),
    3,
    2000
  );
  if (embeddings.length !== indexes.length) {
    throw new Error('Visual embedding provider returned a mismatched vector count');
  }
  if (
    !params.message.generationId ||
    !(await canonicalGenerationAcceptsWrites(
      params.db,
      params.message.generationId,
    ))
  ) {
    log.info("Acknowledging superseded visual embedding work", {
      generationId: params.message.generationId,
    });
    return false;
  }
  for (const [position, messageIndex] of indexes.entries()) {
    const chunkId = params.message.chunkIds[messageIndex];
    const embedding = embeddings[position];
    if (!chunkId || !embedding) {
      throw new Error('Visual embedding response could not be matched to a chunk');
    }
    const embeddingValue = `[${embedding.join(',')}]`;
    const updated = await params.db.execute(sql`
      UPDATE repository_item_chunks
      SET visual_embedding = ${embeddingValue}::vector
      WHERE id = ${chunkId}
        AND index_generation_id = ${params.message.generationId}::uuid
        AND EXISTS (
          SELECT 1
          FROM repository_index_generations generation
          WHERE generation.id = ${params.message.generationId}::uuid
            AND generation.status = 'building'
        )
      RETURNING id
    `);
    if (updated.length !== 1) {
      if (
        !(await canonicalGenerationAcceptsWrites(
          params.db,
          params.message.generationId,
        ))
      ) {
        log.info("Acknowledging superseded visual embedding batch", {
          generationId: params.message.generationId,
        });
        return false;
      }
      throw new Error(
        `Visual chunk ${chunkId} does not belong to generation ${params.message.generationId}`
      );
    }
  }
  return true;
}

async function resolveRecordEmbeddingSettings(
  db: EmbeddingDb,
  message: EmbeddingMessage,
): Promise<EmbeddingSettings | null> {
  if (!message.generationId) return getEmbeddingSettings();
  const [generation] = await db.execute<{
    status: CanonicalGenerationStatus;
    embedding_model: string | null;
    embedding_dimensions: number | null;
    visual_embedding_model: string | null;
    visual_embedding_dimensions: number | null;
  }>(sql`
    SELECT status, embedding_model, embedding_dimensions,
           visual_embedding_model, visual_embedding_dimensions
    FROM repository_index_generations
    WHERE id = ${message.generationId}::uuid
    LIMIT 1
  `);
  if (!generation) {
    throw new Error(`Index generation ${message.generationId} was not found`);
  }
  if (shouldSkipCanonicalGeneration(generation.status)) {
    log.info(`Skipping stale embedding generation ${message.generationId}`, {
      status: generation.status,
    });
    return null;
  }
  if (message.activationOnly) {
    const activated = await activateCanonicalGeneration(
      db,
      message.generationId
    );
    if (!activated) {
      throw new Error(
        `Generation ${message.generationId} is not complete enough to activate`
      );
    }
    log.info(`Activated recovered generation ${message.generationId}`, {
      repositoryId: activated.repository_id,
      embeddedItemCount: activated.embedded_item_count,
    });
    return null;
  }
  if (generation.status !== "building") {
    log.info(`Skipping immutable active generation ${message.generationId}`, {
      status: generation.status,
    });
    return null;
  }
  const baseSettings = await getEmbeddingSettings();
  const descriptor = parseEmbeddingDescriptor(
    generation.embedding_model,
    generation.embedding_dimensions
  );
  const visualDescriptor = generation.visual_embedding_model
    ? parseEmbeddingDescriptor(
        generation.visual_embedding_model,
        generation.visual_embedding_dimensions
      )
    : null;
  if (visualDescriptor) {
    const visualWritten = await writeVisualEmbeddings({
      db,
      message,
      baseSettings,
      descriptor: visualDescriptor,
    });
    if (!visualWritten) return null;
  }
  return {
    ...baseSettings,
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    dimensions: descriptor.dimensions,
  };
}

function assertValidEmbeddingVector(
  embedding: number[],
  dimensions: number,
  chunkId: number,
): void {
  if (
    embedding.length !== dimensions ||
    !embedding.every((value) =>
      typeof value === 'number' && Number.isFinite(value)
    )
  ) {
    throw new Error(
      `Invalid embedding for chunk ${chunkId}: expected ${dimensions} finite values`
    );
  }
}

async function writeTextEmbeddings(params: {
  db: EmbeddingDb;
  message: EmbeddingMessage;
  settings: EmbeddingSettings;
}): Promise<boolean> {
  if (
    params.message.generationId &&
    !(await canonicalGenerationAcceptsWrites(
      params.db,
      params.message.generationId,
    ))
  ) {
    log.info("Acknowledging stale text embedding work before provider call", {
      generationId: params.message.generationId,
    });
    return false;
  }
  const embeddings = await retryWithBackoff(
    () => generateEmbeddings(params.message.texts, params.settings),
    3,
    2000
  );
  if (embeddings.length !== params.message.chunkIds.length) {
    throw new Error(
      `Embedding provider returned ${embeddings.length} vectors for ${params.message.chunkIds.length} chunks (item ${params.message.itemId})`
    );
  }
  if (
    params.message.generationId &&
    !(await canonicalGenerationAcceptsWrites(
      params.db,
      params.message.generationId,
    ))
  ) {
    log.info("Acknowledging superseded text embedding work", {
      generationId: params.message.generationId,
    });
    return false;
  }
  for (const [index, chunkId] of params.message.chunkIds.entries()) {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new Error(`Embedding response omitted chunk ${chunkId}`);
    }
    assertValidEmbeddingVector(
      embedding,
      params.settings.dimensions,
      chunkId
    );
    const embeddingValue = `[${embedding.join(',')}]`;
    log.info(`Updating chunk ${chunkId} with embedding length: ${embedding.length}`);
    if (params.message.generationId) {
      const updated = await params.db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = ${embeddingValue}::vector
        WHERE id = ${chunkId}
          AND index_generation_id = ${params.message.generationId}::uuid
          AND EXISTS (
            SELECT 1
            FROM repository_index_generations generation
            WHERE generation.id = ${params.message.generationId}::uuid
              AND generation.status = 'building'
          )
        RETURNING id
      `);
      if (updated.length !== 1) {
        if (
          !(await canonicalGenerationAcceptsWrites(
            params.db,
            params.message.generationId,
          ))
        ) {
          log.info("Acknowledging superseded text embedding batch", {
            generationId: params.message.generationId,
          });
          return false;
        }
        throw new Error(
          `Chunk ${chunkId} does not belong to generation ${params.message.generationId}`
        );
      }
    } else {
      await params.db.execute(
        sql`UPDATE repository_item_chunks SET embedding = ${embeddingValue}::vector WHERE id = ${chunkId}`
      );
    }
  }
  return true;
}

async function countPendingGenerationChunks(
  db: EmbeddingDb,
  generationId: string | undefined,
): Promise<number> {
  if (!generationId) return 0;
  const [generation] = await db.execute<{
    visual_embedding_model: string | null;
  }>(sql`
    SELECT visual_embedding_model
    FROM repository_index_generations
    WHERE id = ${generationId}::uuid
  `);
  const [pending] = await db.execute<{ pending_count: number }>(sql`
    SELECT count(*)::integer AS pending_count
    FROM repository_item_chunks
    WHERE index_generation_id = ${generationId}::uuid
      AND (
        embedding IS NULL
        OR (
          ${generation?.visual_embedding_model != null}
          AND modality IN ('image', 'video')
          AND visual_embedding IS NULL
        )
      )
  `);
  return pending?.pending_count ?? 0;
}

async function finalizeEmbeddingRecord(
  db: EmbeddingDb,
  message: EmbeddingMessage,
  pendingGenerationChunks: number,
): Promise<boolean> {
  const generationComplete = shouldMarkItemEmbedded(
    message,
    pendingGenerationChunks
  );
  if (!generationComplete) return false;
  if (message.generationId) {
    await activateCanonicalGeneration(db, message.generationId);
  } else {
    await db
      .update(repositoryItems)
      .set({ processingStatus: 'embedded', updatedAt: new Date() })
      .where(eq(repositoryItems.id, message.itemId));
  }
  return true;
}

async function recordTerminalEmbeddingFailure(params: {
  db: EmbeddingDb;
  message: EmbeddingMessage;
  errorMessage: string;
}): Promise<void> {
  if (params.message.generationId) {
    const failed = await failBuildingGeneration(
      {
        generationId: params.message.generationId,
        itemId: params.message.itemId,
        errorMessage: params.errorMessage,
      },
      async (query) =>
        (await params.db.execute<{ item_id: number }>(query)) as Array<{
          item_id: number;
        }>
    );
    log.info('Canonical embedding generation terminal failure handled', {
      generationId: params.message.generationId,
      itemId: params.message.itemId,
      failedCurrentGeneration: failed,
    });
    return;
  }
  await params.db
    .update(repositoryItems)
    .set({
      processingStatus: 'embedding_failed',
      processingError: params.errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(repositoryItems.id, params.message.itemId));
}

async function handleEmbeddingRecordFailure(params: {
  db: EmbeddingDb;
  message: EmbeddingMessage;
  record: SQSRecord;
  error: unknown;
}): Promise<void> {
  const errorMessage =
    params.error instanceof Error ? params.error.message : String(params.error);
  log.error(`Failed to generate embeddings for item ${params.message.itemId}`, {
    error: errorMessage,
  });
  const receiveCount = params.record.attributes.ApproximateReceiveCount;
  if (!isTerminalEmbeddingAttempt(receiveCount)) {
    log.info('Embedding failure remains retryable', {
      itemId: params.message.itemId,
      generationId: params.message.generationId,
      approximateReceiveCount: receiveCount ?? '1',
    });
    return;
  }
  try {
    await recordTerminalEmbeddingFailure({
      db: params.db,
      message: params.message,
      errorMessage,
    });
  } catch (dbError) {
    log.error('Failed to record terminal embedding failure', {
      itemId: params.message.itemId,
      generationId: params.message.generationId,
      error: String(dbError),
    });
  }
}

async function processRecord(record: SQSRecord): Promise<void> {
  const message: unknown = JSON.parse(record.body);
  assertValidEmbeddingMessage(message);
  const db = await getDb();

  try {
    log.info(
      `Processing embeddings for item ${message.itemId} with ${message.chunkIds.length} chunks`
    );
    const settings = await resolveRecordEmbeddingSettings(db, message);
    if (!settings) return;
    const textWritten = await writeTextEmbeddings({ db, message, settings });
    if (!textWritten) return;
    const pendingGenerationChunks = await countPendingGenerationChunks(
      db,
      message.generationId,
    );
    const generationComplete = await finalizeEmbeddingRecord(
      db,
      message,
      pendingGenerationChunks,
    );
    log.info(`Successfully generated embeddings for item ${message.itemId}`, {
      generationComplete,
      pendingGenerationChunks,
    });
  } catch (error) {
    await handleEmbeddingRecordFailure({ db, message, record, error });
    throw error;
  }
}

export async function handler(event: SQSEvent): Promise<void> {
  // batchSize=1 is set on the SqsEventSource in processing-stack.ts.
  // Guard here so a misconfigured deployment fails loudly rather than silently
  // processing a partial batch (closeDb() is called once for all records).
  if (event.Records.length !== 1) {
    throw new Error(`Expected exactly 1 SQS record, got ${event.Records.length} — verify batchSize=1 on the SqsEventSource`);
  }
  log.info(`Processing embedding requests: ${event.Records.length}`);

  try {
    for (const record of event.Records) {
      await processRecord(record);
    }
  } finally {
    // Swallow closeDb errors — they must not mask the original processing error.
    await closeDb().catch((e) => log.error('closeDb failed', { error: String(e) }));
  }
}
