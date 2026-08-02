import type { SQSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockGetDb = mock();
const mockCloseDb = mock();
mock.module('../db-client', () => ({
  getDb: mockGetDb,
  closeDb: mockCloseDb,
}));

const { handler } = await import('../index');

describe('collected generation acknowledgement', () => {
  beforeEach(() => {
    mockGetDb.mockReset();
    mockCloseDb.mockReset();
    mockCloseDb.mockResolvedValue();
  });

  test('acks a missing generation without starting downstream embedding work', async () => {
    const execute = mock().mockResolvedValue([]);
    mockGetDb.mockResolvedValue({ execute });
    const event = {
      Records: [
        {
          body: JSON.stringify({
            itemId: 42,
            generationId: '11111111-2222-4333-8444-555555555555',
            chunkIds: [7],
            texts: ['stale chunk'],
          }),
        },
      ],
    } as unknown as SQSEvent;

    await expect(handler(event)).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mockCloseDb).toHaveBeenCalledTimes(1);
  });
});
