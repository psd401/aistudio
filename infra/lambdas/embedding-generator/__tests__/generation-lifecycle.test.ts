import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  assertValidEmbeddingMessage,
  failBuildingGeneration,
  isTerminalEmbeddingAttempt,
  shouldSkipCanonicalGeneration,
} from '../generation-lifecycle';

describe('canonical embedding generation lifecycle', () => {
  test('accepts activation-only work without fabricated chunk inputs', () => {
    expect(() =>
      assertValidEmbeddingMessage({
        itemId: 42,
        generationId: '11111111-2222-4333-8444-555555555555',
        chunkIds: [],
        texts: [],
        modalities: [],
        visualSources: [],
        activationOnly: true,
      })
    ).not.toThrow();

    expect(() =>
      assertValidEmbeddingMessage({
        itemId: 42,
        chunkIds: [],
        texts: [],
        activationOnly: true,
      })
    ).toThrow('requires a generation id');
  });

  test('rejects malformed normal embedding batches before model work', () => {
    expect(() =>
      assertValidEmbeddingMessage({
        itemId: 42,
        chunkIds: [1, 2],
        texts: ['only one'],
      })
    ).toThrow('invalid or mismatched chunk data');
  });

  test('acknowledges superseded and failed generations as stale', () => {
    expect(shouldSkipCanonicalGeneration('superseded')).toBe(true);
    expect(shouldSkipCanonicalGeneration('failed')).toBe(true);
    expect(shouldSkipCanonicalGeneration('building')).toBe(false);
    expect(shouldSkipCanonicalGeneration('active')).toBe(false);
  });

  test('does not expose a terminal failure before the SQS retry budget is exhausted', () => {
    expect(isTerminalEmbeddingAttempt(undefined)).toBe(false);
    expect(isTerminalEmbeddingAttempt('1')).toBe(false);
    expect(isTerminalEmbeddingAttempt('2')).toBe(false);
    expect(isTerminalEmbeddingAttempt('3')).toBe(true);
    expect(isTerminalEmbeddingAttempt('4')).toBe(true);
    expect(isTerminalEmbeddingAttempt('invalid')).toBe(false);
  });

  test('fails only a building generation and its own newly published item', async () => {
    const execute = jest.fn(async (_query: SQL) => [{ item_id: 42 }]);

    await expect(
      failBuildingGeneration(
        {
          generationId: '11111111-2222-4333-8444-555555555555',
          itemId: 42,
          errorMessage: 'provider unavailable',
        },
        execute
      )
    ).resolves.toBe(true);

    const failureQuery = execute.mock.calls[0]?.[0];
    expect(failureQuery).toBeDefined();
    const normalizedSql = new PgDialect()
      .sqlToQuery(failureQuery as SQL)
      .sql.replace(/\s+/g, ' ');
    expect(normalizedSql).toContain("generation.status = 'building'");
    expect(normalizedSql).toContain("SET status = 'failed'");
    expect(normalizedSql).toContain("processing_status = 'embedding_failed'");
    expect(normalizedSql).toContain('chunk.index_generation_id =');
    expect(normalizedSql).toContain('chunk.item_id = item.id');
    expect(normalizedSql).toContain(
      'serving_chunk.index_generation_id = serving_repository.active_index_generation_id'
    );
  });

  test('treats a superseded-generation failure update as a no-op', async () => {
    await expect(
      failBuildingGeneration(
        {
          generationId: '11111111-2222-4333-8444-555555555555',
          itemId: 42,
          errorMessage: 'stale batch',
        },
        jest.fn(async (_query: SQL) => [])
      )
    ).resolves.toBe(false);
  });
});
