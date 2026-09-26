/**
 * The cron Lambda bundles separately from the router, so chat-text-budget.ts and
 * rich-envelope.ts exist as duplicated copies. Drift between them is invisible
 * at runtime — the router is what parses the cron's delivery envelope off the
 * queue — so assert the bodies stay identical below the file header.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTER_DIR = join(import.meta.dir, '..', 'agent-router');

/** Everything after the leading block comment. */
function bodyAfterHeader(path: string): string {
  const source = readFileSync(path, 'utf8');
  const headerEnd = source.indexOf('*/');
  expect(headerEnd).toBeGreaterThan(-1);
  return source.slice(headerEnd + 2);
}

describe('duplicated Chat delivery modules stay in lockstep', () => {
  for (const file of ['chat-text-budget.ts', 'rich-envelope.ts']) {
    test(file, () => {
      expect(bodyAfterHeader(join(import.meta.dir, file))).toBe(
        bodyAfterHeader(join(ROUTER_DIR, file)),
      );
    });
  }
});
