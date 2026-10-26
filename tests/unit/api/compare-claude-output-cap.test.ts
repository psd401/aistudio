/**
 * The compare route calls streamText directly (not through ClaudeAdapter), so it
 * must apply the Claude output-cap default itself — otherwise Bedrock caps a
 * compare answer at 4,096 tokens.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('direct streamText callers apply the Claude output cap', () => {
  it.each(['app/api/compare/route.ts', 'lib/ai-helpers.ts'])('%s', file => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo paths.
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).toMatch(/maxOutputTokens:\s*defaultClaudeMaxOutputTokens\(/);
  });
});
