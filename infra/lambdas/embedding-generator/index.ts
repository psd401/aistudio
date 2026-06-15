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
import { eq, inArray, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './db-client';
import { settings, repositoryItems, repositoryItemChunks } from './schema';

// eslint-disable-next-line no-console
const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    process.stdout.write(JSON.stringify({ level: 'INFO', message: msg, ...meta }) + '\n'),
  error: (msg: string, meta?: Record<string, unknown>) =>
    process.stderr.write(JSON.stringify({ level: 'ERROR', message: msg, ...meta }) + '\n'),
};

const EMBEDDING_KEYS = [
  'OPENAI_API_KEY',
  'BEDROCK_ACCESS_KEY_ID',
  'BEDROCK_SECRET_ACCESS_KEY',
  'BEDROCK_REGION',
  'AZURE_OPENAI_KEY',
  'AZURE_OPENAI_ENDPOINT',
] as const;

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

  return {
    provider: map['EMBEDDING_MODEL_PROVIDER'] ?? 'openai',
    modelId: map['EMBEDDING_MODEL_ID'] ?? 'text-embedding-3-small',
    dimensions: parseInt(map['EMBEDDING_DIMENSIONS'] ?? '1536', 10),
    batchSize: parseInt(map['EMBEDDING_BATCH_SIZE'] ?? '100', 10),
    openAIKey: map['OPENAI_API_KEY'],
    bedrockAccessKey: map['BEDROCK_ACCESS_KEY_ID'],
    bedrockSecretKey: map['BEDROCK_SECRET_ACCESS_KEY'],
    bedrockRegion: map['BEDROCK_REGION'],
    azureKey: map['AZURE_OPENAI_KEY'],
    azureEndpoint: map['AZURE_OPENAI_ENDPOINT'],
  };
}

async function generateEmbeddings(texts: string[], embSettings: EmbeddingSettings): Promise<number[][]> {
  switch (embSettings.provider) {
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

    case 'bedrock': {
      if (!embSettings.bedrockAccessKey || !embSettings.bedrockSecretKey) {
        throw new Error('Bedrock credentials not configured');
      }
      const client = new BedrockRuntimeClient({
        region: embSettings.bedrockRegion ?? 'us-east-1',
        credentials: {
          accessKeyId: embSettings.bedrockAccessKey,
          secretAccessKey: embSettings.bedrockSecretKey,
        },
      });
      const embeddings: number[][] = [];
      for (const text of texts) {
        const command = new InvokeModelCommand({
          modelId: embSettings.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ inputText: text }),
        });
        const response = await client.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] };
        embeddings.push(result.embedding);
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

interface EmbeddingMessage {
  itemId: number;
  chunkIds: number[];
  texts: string[];
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
  throw lastError;
}

async function processRecord(record: SQSRecord, embSettings: EmbeddingSettings): Promise<void> {
  const message = JSON.parse(record.body) as EmbeddingMessage;
  log.info(`Processing embeddings for item ${message.itemId} with ${message.chunkIds.length} chunks`);

  const db = await getDb();

  try {
    const embeddings = await retryWithBackoff(
      () => generateEmbeddings(message.texts, embSettings),
      3,
      2000
    );

    for (let i = 0; i < message.chunkIds.length; i++) {
      const chunkId = message.chunkIds[i];
      const embedding = embeddings[i];
      const embeddingStr = `[${embedding.join(',')}]`;

      log.info(`Updating chunk ${chunkId} with embedding length: ${embedding.length}`);

      // Use raw SQL for the vector cast — postgres.js parameterised queries
      // don't automatically coerce text to the vector column type.
      await db.execute(
        sql`UPDATE repository_item_chunks SET embedding = ${embeddingStr}::vector WHERE id = ${chunkId}`
      );
    }

    await db
      .update(repositoryItems)
      .set({ processingStatus: 'embedded', updatedAt: new Date() })
      .where(eq(repositoryItems.id, message.itemId));

    log.info(`Successfully generated embeddings for item ${message.itemId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to generate embeddings for item ${message.itemId}`, { error: errorMessage });

    await db
      .update(repositoryItems)
      .set({ processingStatus: 'embedding_failed', processingError: errorMessage, updatedAt: new Date() })
      .where(eq(repositoryItems.id, message.itemId));

    throw error;
  }
}

export async function handler(event: SQSEvent): Promise<void> {
  log.info(`Processing embedding requests: ${event.Records.length}`);

  const embSettings = await getEmbeddingSettings();

  try {
    for (const record of event.Records) {
      await processRecord(record, embSettings);
    }
  } finally {
    await closeDb();
  }
}
