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
  failBuildingGeneration,
  isTerminalEmbeddingAttempt,
  shouldSkipCanonicalGeneration,
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

interface EmbeddingMessage {
  itemId: number;
  /** Present for canonical index-generation batches. */
  generationId?: string;
  chunkIds: number[];
  texts: string[];
  modalities?: Array<'text' | 'image' | 'audio' | 'video' | 'table'>;
  visualSources?: Array<{
    objectKey: string;
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  } | null>;
  activationOnly?: boolean;
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

async function processRecord(record: SQSRecord): Promise<void> {
  const message = JSON.parse(record.body) as EmbeddingMessage;
  log.info(`Processing embeddings for item ${message.itemId} with ${message.chunkIds.length} chunks`);

  const db = await getDb();

  try {
    if (
      message.chunkIds.length === 0 ||
      message.chunkIds.length !== message.texts.length ||
      (message.modalities != null &&
        message.modalities.length !== message.chunkIds.length) ||
      (message.visualSources != null &&
        message.visualSources.length !== message.chunkIds.length) ||
      !message.chunkIds.every((chunkId) => Number.isSafeInteger(chunkId) && chunkId > 0)
    ) {
      throw new Error('Embedding message has invalid or mismatched chunk data');
    }
    if (message.activationOnly && !message.generationId) {
      throw new Error('Embedding activation message requires a generation id');
    }
    let effectiveSettings: EmbeddingSettings;
    if (message.generationId) {
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
        return;
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
        return;
      }
      const embSettings = await getEmbeddingSettings();
      const descriptor = parseEmbeddingDescriptor(
        generation.embedding_model,
        generation.embedding_dimensions
      );
      effectiveSettings = {
        ...embSettings,
        provider: descriptor.provider,
        modelId: descriptor.modelId,
        dimensions: descriptor.dimensions,
      };
      const visualDescriptor = generation.visual_embedding_model
        ? parseEmbeddingDescriptor(
            generation.visual_embedding_model,
            generation.visual_embedding_dimensions
          )
        : null;
      if (visualDescriptor) {
        const modalities =
          message.modalities ?? message.chunkIds.map(() => 'text' as const);
        const visualIndexes = modalities.flatMap((modality, index) =>
          modality === 'image' || modality === 'video' ? [index] : []
        );
        if (visualIndexes.length > 0) {
          const visualSettings: EmbeddingSettings = {
            ...embSettings,
            provider: visualDescriptor.provider,
            modelId: visualDescriptor.modelId,
            dimensions: visualDescriptor.dimensions,
          };
          const visualSourceCache = new Map<string, string>();
          const visualInputs = await Promise.all(
            visualIndexes.map(async (index) => ({
              text: message.texts[index] ?? '',
              imageDataUri: await loadVisualDataUri(
                message.visualSources?.[index] ?? null,
                visualSourceCache,
              ),
            })),
          );
          const visualEmbeddings = await retryWithBackoff(
            () => generateVisualEmbeddings(visualInputs, visualSettings),
            3,
            2000
          );
          if (visualEmbeddings.length !== visualIndexes.length) {
            throw new Error('Visual embedding provider returned a mismatched vector count');
          }
          for (const [position, messageIndex] of visualIndexes.entries()) {
            const chunkId = message.chunkIds[messageIndex];
            const visualEmbedding = visualEmbeddings[position];
            if (!chunkId || !visualEmbedding) {
              throw new Error('Visual embedding response could not be matched to a chunk');
            }
            const visualEmbeddingStr = `[${visualEmbedding.join(',')}]`;
            const updated = await db.execute(sql`
              UPDATE repository_item_chunks
              SET visual_embedding = ${visualEmbeddingStr}::vector
              WHERE id = ${chunkId}
                AND index_generation_id = ${message.generationId}::uuid
              RETURNING id
            `);
            if (updated.length !== 1) {
              throw new Error(`Visual chunk ${chunkId} does not belong to generation ${message.generationId}`);
            }
          }
        }
      }
    } else {
      effectiveSettings = await getEmbeddingSettings();
    }

    const embeddings = await retryWithBackoff(
      () => generateEmbeddings(message.texts, effectiveSettings),
      3,
      2000
    );

    if (embeddings.length !== message.chunkIds.length) {
      throw new Error(
        `Embedding provider returned ${embeddings.length} vectors for ${message.chunkIds.length} chunks (item ${message.itemId})`
      );
    }

    for (let i = 0; i < message.chunkIds.length; i++) {
      const chunkId = message.chunkIds[i];
      const embedding = embeddings[i];

      if (
        embedding.length !== effectiveSettings.dimensions ||
        !embedding.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        throw new Error(
          `Invalid embedding for chunk ${chunkId}: expected ${effectiveSettings.dimensions} finite values`
        );
      }

      const embeddingStr = `[${embedding.join(',')}]`;

      log.info(`Updating chunk ${chunkId} with embedding length: ${embedding.length}`);

      // Use raw SQL for the vector cast — postgres.js parameterised queries
      // don't automatically coerce text to the vector column type.
      if (message.generationId) {
        const updated = await db.execute(sql`
          UPDATE repository_item_chunks
          SET embedding = ${embeddingStr}::vector
          WHERE id = ${chunkId}
            AND index_generation_id = ${message.generationId}::uuid
          RETURNING id
        `);
        if (updated.length !== 1) {
          throw new Error(`Chunk ${chunkId} does not belong to generation ${message.generationId}`);
        }
      } else {
        await db.execute(
          sql`UPDATE repository_item_chunks SET embedding = ${embeddingStr}::vector WHERE id = ${chunkId}`
        );
      }
    }

    let pendingGenerationChunks = 0;
    if (message.generationId) {
      const [generation] = await db.execute<{
        visual_embedding_model: string | null;
      }>(sql`
        SELECT visual_embedding_model
        FROM repository_index_generations
        WHERE id = ${message.generationId}::uuid
      `);
      const [pending] = await db.execute<{ pending_count: number }>(sql`
        SELECT count(*)::integer AS pending_count
        FROM repository_item_chunks
        WHERE index_generation_id = ${message.generationId}::uuid
          AND (
            embedding IS NULL
            OR (
              ${generation?.visual_embedding_model != null}
              AND modality IN ('image', 'video')
              AND visual_embedding IS NULL
            )
          )
      `);
      pendingGenerationChunks = pending?.pending_count ?? 0;
    }
    const generationComplete = shouldMarkItemEmbedded(
      message,
      pendingGenerationChunks
    );
    if (generationComplete) {
      if (message.generationId) {
        await activateCanonicalGeneration(db, message.generationId);
      } else {
        await db
          .update(repositoryItems)
          .set({ processingStatus: 'embedded', updatedAt: new Date() })
          .where(eq(repositoryItems.id, message.itemId));
      }
    }

    log.info(`Successfully generated embeddings for item ${message.itemId}`, {
      generationComplete,
      pendingGenerationChunks,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to generate embeddings for item ${message.itemId}`, { error: errorMessage });

    const terminalAttempt = isTerminalEmbeddingAttempt(
      record.attributes.ApproximateReceiveCount
    );
    if (terminalAttempt) {
      try {
        if (message.generationId) {
          const failed = await failBuildingGeneration(
            {
              generationId: message.generationId,
              itemId: message.itemId,
              errorMessage,
            },
            async (query) =>
              (await db.execute<{ item_id: number }>(query)) as Array<{
                item_id: number;
              }>
          );
          log.info(`Canonical embedding generation terminal failure handled`, {
            generationId: message.generationId,
            itemId: message.itemId,
            failedCurrentGeneration: failed,
          });
        } else {
          await db
            .update(repositoryItems)
            .set({
              processingStatus: 'embedding_failed',
              processingError: errorMessage,
              updatedAt: new Date(),
            })
            .where(eq(repositoryItems.id, message.itemId));
        }
      } catch (dbError) {
        log.error(`Failed to record terminal embedding failure`, {
          itemId: message.itemId,
          generationId: message.generationId,
          error: String(dbError),
        });
      }
    } else {
      log.info(`Embedding failure remains retryable`, {
        itemId: message.itemId,
        generationId: message.generationId,
        approximateReceiveCount:
          record.attributes.ApproximateReceiveCount ?? '1',
      });
    }

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
