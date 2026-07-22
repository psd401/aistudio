import { activateCompletedGeneration } from '../generation-activation';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('atomic generation activation', () => {
  test('returns the switched repository and all embedded items', async () => {
    const execute = jest.fn(async (_query: SQL) => [
      { repository_id: 7, embedded_item_count: 3 },
    ]);

    await expect(
      activateCompletedGeneration(
        '11111111-2222-4333-8444-555555555555',
        execute,
      ),
    ).resolves.toEqual({ repository_id: 7, embedded_item_count: 3 });
    expect(execute).toHaveBeenCalledTimes(1);

    const activationQuery = execute.mock.calls[0]?.[0];
    expect(activationQuery).toBeDefined();
    const query = new PgDialect().sqlToQuery(activationQuery as SQL);
    const normalizedSql = query.sql.replace(/\s+/g, ' ');
    expect(normalizedSql).toContain(
      'AND EXISTS ( SELECT 1 FROM repository_item_chunks chunk'
    );
    expect(normalizedSql).toContain(
      'AND NOT EXISTS ( SELECT 1 FROM repository_item_chunks chunk'
    );
    expect(normalizedSql).toContain('chunk.embedding IS NULL');
    expect(normalizedSql).toContain('generation.visual_embedding_model IS NOT NULL');
    expect(normalizedSql).toContain("chunk.modality IN ('image', 'video')");
    expect(normalizedSql).toContain('chunk.visual_embedding IS NULL');
  });

  test('treats a superseded stale generation as a safe no-op', async () => {
    await expect(
      activateCompletedGeneration(
        '11111111-2222-4333-8444-555555555555',
        jest.fn().mockResolvedValue([]),
      ),
    ).resolves.toBeNull();
  });
});
