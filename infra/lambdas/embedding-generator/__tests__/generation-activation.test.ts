import { activateCompletedGeneration } from '../generation-activation';

describe('atomic generation activation', () => {
  test('returns the switched repository and all embedded items', async () => {
    const execute = jest.fn().mockResolvedValue([
      { repository_id: 7, embedded_item_count: 3 },
    ]);

    await expect(
      activateCompletedGeneration(
        '11111111-2222-4333-8444-555555555555',
        execute,
      ),
    ).resolves.toEqual({ repository_id: 7, embedded_item_count: 3 });
    expect(execute).toHaveBeenCalledTimes(1);
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
