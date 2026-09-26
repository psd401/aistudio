/**
 * The cron Lambda bundles separately from the router, so chat-text-budget.ts and
 * rich-envelope.ts exist as duplicated copies. Drift between them is invisible
 * at runtime — the router is what parses the cron's delivery envelope off the
 * queue — so assert the bodies stay identical below the file header.
 */
import { describe, expect, test } from 'bun:test';

/** Everything after the leading block comment, which differs by design. */
async function bodyAfterHeader(path: string): Promise<string> {
  const source = await Bun.file(path).text();
  const headerEnd = source.indexOf('*/');
  expect(headerEnd).toBeGreaterThan(-1);
  return source.slice(headerEnd + 2);
}

describe('duplicated Chat delivery modules stay in lockstep', () => {
  test('chat-text-budget.ts', async () => {
    expect(
      await bodyAfterHeader(`${import.meta.dir}/chat-text-budget.ts`),
    ).toBe(
      await bodyAfterHeader(
        `${import.meta.dir}/../agent-router/chat-text-budget.ts`,
      ),
    );
  });

  test('rich-envelope.ts', async () => {
    expect(await bodyAfterHeader(`${import.meta.dir}/rich-envelope.ts`)).toBe(
      await bodyAfterHeader(
        `${import.meta.dir}/../agent-router/rich-envelope.ts`,
      ),
    );
  });
});
