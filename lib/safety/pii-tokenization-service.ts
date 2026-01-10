/**
 * PII Tokenization Service
 *
 * Provides reversible PII tokenization for K-12 AI interactions.
 * Uses Amazon Comprehend for PII detection and DynamoDB for secure token storage.
 *
 * Features:
 * - PII detection using Amazon Comprehend
 * - Reversible tokenization (replace PII with tokens, restore later)
 * - Session-scoped token storage with automatic TTL expiration
 * - Encryption at rest via DynamoDB encryption
 *
 * Privacy Benefits:
 * - AI providers never see actual student PII
 * - Tokens are meaningless UUIDs that cannot be reversed without access to DynamoDB
 * - TTL ensures tokens automatically expire after configurable period
 */

import {
  ComprehendClient,
  DetectPiiEntitiesCommand,
} from '@aws-sdk/client-comprehend';
import type { PiiEntity as ComprehendPiiEntity } from '@aws-sdk/client-comprehend';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { createLogger, generateRequestId } from '@/lib/logger';
import type {
  PIIEntity,
  TokenMapping,
  TokenizationResult,
  PIITokenDynamoDBItem,
  GuardrailsConfig,
} from './types';
import { K12_PII_TYPES, type ComprehendPIIType } from './types';

/**
 * PIITokenizationService - Reversible PII protection for student data
 *
 * Flow:
 * 1. User message → tokenize() → AI provider (sees tokens, not PII)
 * 2. AI response → detokenize() → User (sees restored PII naturally)
 */
export class PIITokenizationService {
  private comprehendClient: ComprehendClient;
  private dynamoDBClient: DynamoDBClient;
  private config: GuardrailsConfig;
  private log = createLogger({ module: 'PIITokenizationService' });

  constructor(config?: Partial<GuardrailsConfig>) {
    const region = config?.region || process.env.AWS_REGION;

    // Graceful degradation for local development - disable if no region
    // In production (ECS/Lambda), AWS_REGION is always set
    if (!region) {
      this.log.warn('AWS_REGION not configured - PIITokenizationService disabled (local development mode)');
      // Initialize with dummy region for client instantiation (won't be used)
      this.comprehendClient = new ComprehendClient({ region: 'us-east-1' });
      this.dynamoDBClient = new DynamoDBClient({ region: 'us-east-1' });
      this.config = {
        region: '',
        guardrailId: '',
        guardrailVersion: 'DRAFT',
        piiTokenTableName: undefined,
        tokenTtlSeconds: 3600,
        enablePiiTokenization: false, // Disabled when no region
      };
      return;
    }

    this.comprehendClient = new ComprehendClient({ region });
    this.dynamoDBClient = new DynamoDBClient({ region });

    this.config = {
      region,
      guardrailId: config?.guardrailId || '',
      guardrailVersion: config?.guardrailVersion || 'DRAFT',
      piiTokenTableName: config?.piiTokenTableName || process.env.PII_TOKEN_TABLE_NAME,
      tokenTtlSeconds: config?.tokenTtlSeconds ?? 3600, // 1 hour default
      enablePiiTokenization: config?.enablePiiTokenization ?? true,
    };

    if (!this.config.piiTokenTableName && this.config.enablePiiTokenization) {
      this.log.warn('PII token table not configured - tokenization disabled');
      this.config.enablePiiTokenization = false;
    }
  }

  /**
   * Check if PII tokenization is enabled
   */
  isEnabled(): boolean {
    return this.config.enablePiiTokenization === true && !!this.config.piiTokenTableName;
  }

  /**
   * Detect PII entities in text using Amazon Comprehend
   *
   * @param text - Text to analyze for PII
   * @returns Array of detected PII entities
   */
  async detectPII(text: string): Promise<PIIEntity[]> {
    const requestId = generateRequestId();

    try {
      const command = new DetectPiiEntitiesCommand({
        Text: text,
        LanguageCode: 'en',
      });

      const response = await this.comprehendClient.send(command);

      const entities: PIIEntity[] = (response.Entities || [])
        .filter((entity: ComprehendPiiEntity): boolean =>
          entity.Type !== undefined &&
          entity.BeginOffset !== undefined &&
          entity.EndOffset !== undefined &&
          entity.Score !== undefined
        )
        .map((entity: ComprehendPiiEntity) => ({
          type: entity.Type as string,
          beginOffset: entity.BeginOffset as number,
          endOffset: entity.EndOffset as number,
          score: entity.Score as number,
        }));

      this.log.debug('PII detection complete', {
        requestId,
        textLength: text.length,
        entitiesFound: entities.length,
        entityTypes: entities.map((e) => e.type),
      });

      return entities;
    } catch (error) {
      this.log.error('PII detection failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Tokenize PII in text - replace PII with tokens and store mapping
   *
   * @param text - Text containing potential PII
   * @param sessionId - Session identifier for token scoping
   * @returns Tokenization result with tokenized text and mappings
   */
  async tokenize(text: string, sessionId: string): Promise<TokenizationResult> {
    if (!this.isEnabled()) {
      return {
        tokenizedText: text,
        tokens: [],
        hasPII: false,
      };
    }

    const requestId = generateRequestId();
    this.log.info('Starting PII tokenization', {
      requestId,
      textLength: text.length,
      sessionId,
    });

    try {
      // Detect PII entities
      const piiEntities = await this.detectPII(text);

      // Filter to only K-12 relevant PII types
      const relevantEntities = piiEntities.filter((entity) =>
        K12_PII_TYPES.includes(entity.type as ComprehendPIIType)
      );

      if (relevantEntities.length === 0) {
        this.log.debug('No K-12 relevant PII found', { requestId });
        return {
          tokenizedText: text,
          tokens: [],
          hasPII: false,
        };
      }

      // Sort by position (reverse) to replace from end to start
      // This preserves positions during replacement
      const sortedEntities = [...relevantEntities].sort(
        (a, b) => b.beginOffset - a.beginOffset
      );

      let tokenizedText = text;
      const tokens: TokenMapping[] = [];

      for (const entity of sortedEntities) {
        const token = uuidv4();
        const original = text.substring(entity.beginOffset, entity.endOffset);
        const placeholder = `[PII:${token}]`;

        // Store mapping in DynamoDB
        await this.storeTokenMapping(token, original, entity.type, sessionId);

        // Replace in text (from end to preserve positions)
        tokenizedText =
          tokenizedText.substring(0, entity.beginOffset) +
          placeholder +
          tokenizedText.substring(entity.endOffset);

        tokens.push({
          token,
          original,
          type: entity.type,
          placeholder,
        });
      }

      this.log.info('PII tokenization complete', {
        requestId,
        tokensCreated: tokens.length,
        piiTypes: tokens.map((t) => t.type),
      });

      return {
        tokenizedText,
        tokens,
        hasPII: true,
      };
    } catch (error) {
      this.log.error('PII tokenization failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Graceful degradation - return original text if tokenization fails
      return {
        tokenizedText: text,
        tokens: [],
        hasPII: false,
      };
    }
  }

  /**
   * Detokenize text - restore original PII values from tokens
   *
   * @param text - Text containing token placeholders
   * @param sessionId - Session identifier for token lookup
   * @returns Text with tokens replaced by original PII values
   */
  async detokenize(text: string, sessionId: string): Promise<string> {
    if (!this.isEnabled()) {
      return text;
    }

    const requestId = generateRequestId();

    // Find all token placeholders in the text (full UUID format)
    const tokenPattern = /\[PII:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]/g;
    const matches = [...text.matchAll(tokenPattern)];

    if (matches.length === 0) {
      return text;
    }

    this.log.info('Starting PII detokenization', {
      requestId,
      tokensFound: matches.length,
      sessionId,
    });

    try {
      let detokenizedText = text;

      // Batch fetch tokens for efficiency
      const tokenIds = matches.map((m) => m[1]);
      const tokenMappings = await this.batchGetTokenMappings(tokenIds, sessionId);

      for (const match of matches) {
        const [placeholder, token] = match;

        // Find matching token by exact match
        const tokenMapping = tokenMappings.find((t) => t.token === token);

        if (tokenMapping) {
          detokenizedText = detokenizedText.replace(placeholder, tokenMapping.original);
        } else {
          this.log.warn('Token mapping not found', {
            requestId,
            token,
            sessionId,
          });
          // Leave placeholder if token not found (may have expired)
        }
      }

      this.log.info('PII detokenization complete', {
        requestId,
        tokensRestored: tokenMappings.length,
      });

      return detokenizedText;
    } catch (error) {
      this.log.error('PII detokenization failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return original text with placeholders if detokenization fails
      return text;
    }
  }

  /**
   * Store token mapping in DynamoDB
   */
  private async storeTokenMapping(
    token: string,
    original: string,
    type: string,
    sessionId: string
  ): Promise<void> {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + (this.config.tokenTtlSeconds || 3600);

    const item: PIITokenDynamoDBItem = {
      token,
      sessionId,
      original,
      type,
      createdAt: now,
      ttl,
    };

    const command = new PutItemCommand({
      TableName: this.config.piiTokenTableName,
      Item: {
        token: { S: item.token },
        sessionId: { S: item.sessionId },
        original: { S: item.original },
        type: { S: item.type },
        createdAt: { N: String(item.createdAt) },
        ttl: { N: String(item.ttl) },
      },
    });

    await this.dynamoDBClient.send(command);
  }

  /**
   * Get a single token mapping from DynamoDB
   */
  private async getTokenMapping(
    token: string,
    sessionId: string
  ): Promise<{ token: string; original: string; type: string } | null> {
    const command = new GetItemCommand({
      TableName: this.config.piiTokenTableName,
      Key: {
        token: { S: token },
        sessionId: { S: sessionId },
      },
    });

    const response = await this.dynamoDBClient.send(command);

    if (!response.Item) {
      return null;
    }

    return {
      token: response.Item.token?.S || '',
      original: response.Item.original?.S || '',
      type: response.Item.type?.S || '',
    };
  }

  /**
   * Batch get token mappings from DynamoDB using BatchGetItem API
   *
   * Optimized to reduce API calls: BatchGetItem can fetch up to 100 items
   * in a single request vs. individual GetItem calls for each token.
   */
  private async batchGetTokenMappings(
    tokens: string[],
    sessionId: string
  ): Promise<Array<{ token: string; original: string; type: string }>> {
    if (tokens.length === 0) {
      return [];
    }

    const tableName = this.config.piiTokenTableName;
    if (!tableName) {
      return [];
    }

    // BatchGetItem supports up to 100 items per request
    const BATCH_SIZE = 100;
    const batches: string[][] = [];
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      batches.push(tokens.slice(i, i + BATCH_SIZE));
    }

    // Process batches concurrently with resilience - use allSettled to avoid losing
    // results from successful batches if one batch fails unexpectedly
    const batchSettled = await Promise.allSettled(
      batches.map(async (batch) => {
        const batchItems: Array<{ token: string; original: string; type: string }> = [];

        try {
          const command = new BatchGetItemCommand({
            RequestItems: {
              [tableName]: {
                Keys: batch.map((token) => ({
                  token: { S: token },
                  sessionId: { S: sessionId },
                })),
              },
            },
          });

          const response = await this.dynamoDBClient.send(command);
          const items = response.Responses?.[tableName] || [];

          for (const item of items) {
            if (item.token?.S && item.original?.S) {
              batchItems.push({
                token: item.token.S,
                original: item.original.S,
                type: item.type?.S || '',
              });
            }
          }

          // Handle unprocessed keys (throttling) with retry
          if (response.UnprocessedKeys?.[tableName]?.Keys?.length) {
            this.log.warn('BatchGetItem had unprocessed keys, falling back to individual GetItem', {
              unprocessedCount: response.UnprocessedKeys[tableName].Keys.length,
            });

            // Fallback to individual GetItem for unprocessed keys
            const unprocessedResults = await Promise.all(
              response.UnprocessedKeys[tableName].Keys.map(async (key) => {
                try {
                  const retryCommand = new GetItemCommand({
                    TableName: tableName,
                    Key: key,
                  });
                  const retryResponse = await this.dynamoDBClient.send(retryCommand);
                  if (retryResponse.Item?.token?.S && retryResponse.Item?.original?.S) {
                    return {
                      token: retryResponse.Item.token.S,
                      original: retryResponse.Item.original.S,
                      type: retryResponse.Item.type?.S || '',
                    };
                  }
                } catch {
                  // Token not found or expired
                }
                return null;
              })
            );
            batchItems.push(...unprocessedResults.filter((r): r is NonNullable<typeof r> => r !== null));
          }
        } catch (error) {
          this.log.error('BatchGetItem failed, falling back to individual GetItem', {
            error: error instanceof Error ? error.message : String(error),
            batchSize: batch.length,
          });

          // Fallback to individual GetItem on batch failure
          const fallbackResults = await Promise.all(
            batch.map(async (token) => {
              try {
                const command = new GetItemCommand({
                  TableName: tableName,
                  Key: {
                    token: { S: token },
                    sessionId: { S: sessionId },
                  },
                });
                const response = await this.dynamoDBClient.send(command);
                if (response.Item?.token?.S && response.Item?.original?.S) {
                  return {
                    token: response.Item.token.S,
                    original: response.Item.original.S,
                    type: response.Item.type?.S || '',
                  };
                }
              } catch {
                // Token not found or expired
              }
              return null;
            })
          );
          batchItems.push(...fallbackResults.filter((r): r is NonNullable<typeof r> => r !== null));
        }

        return batchItems;
      })
    );

    // Extract successful batch results and flatten
    const successfulBatches = batchSettled
      .filter((result): result is PromiseFulfilledResult<Array<{ token: string; original: string; type: string }>> =>
        result.status === 'fulfilled'
      )
      .map(result => result.value);

    return successfulBatches.flat();
  }

  /**
   * Get current configuration (for diagnostics)
   */
  getConfig(): Pick<
    GuardrailsConfig,
    'region' | 'piiTokenTableName' | 'tokenTtlSeconds' | 'enablePiiTokenization'
  > {
    return {
      region: this.config.region,
      piiTokenTableName: this.config.piiTokenTableName,
      tokenTtlSeconds: this.config.tokenTtlSeconds,
      enablePiiTokenization: this.config.enablePiiTokenization,
    };
  }
}

// Singleton instance
let piiTokenizationServiceInstance: PIITokenizationService | null = null;

/**
 * Get or create the PIITokenizationService singleton
 */
export function getPIITokenizationService(
  config?: Partial<GuardrailsConfig>
): PIITokenizationService {
  if (!piiTokenizationServiceInstance) {
    piiTokenizationServiceInstance = new PIITokenizationService(config);
  }
  return piiTokenizationServiceInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetPIITokenizationService(): void {
  piiTokenizationServiceInstance = null;
}
