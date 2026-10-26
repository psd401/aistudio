/**
 * Bedrock Converse caps Claude at 4,096 output tokens when no maxOutputTokens is
 * sent, and Claude 5.x adaptive thinking counts against it. Nexus never sent a
 * cap, so long turns (grading a class set) ended `finishReason: length` with no
 * text — "This turn ended without a written answer" (prod, 2026-10-26).
 */
import { describe, it, expect } from '@jest/globals';
import type { LanguageModel } from 'ai';
import { ClaudeAdapter } from '../provider-adapters/claude-adapter';
import {
  DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS,
  defaultClaudeMaxOutputTokens,
} from '@/lib/ai/claude-output-cap';
import type { StreamConfig } from '../types';

class TestableClaudeAdapter extends ClaudeAdapter {
  enhance(config: StreamConfig): StreamConfig {
    return this.enhanceStreamConfig(config);
  }
}

const adapter = new TestableClaudeAdapter();
const configFor = (modelId: string, maxTokens?: number): StreamConfig => ({
  model: { modelId } as unknown as LanguageModel,
  messages: [],
  ...(maxTokens !== undefined && { maxTokens }),
});

const CLAUDE_4_OR_5 = [
  'us.anthropic.claude-sonnet-5-5',
  'us.anthropic.claude-opus-5-5',
  'us.anthropic.claude-haiku-5-5',
  'anthropic.claude-sonnet-5',
  'claude-sonnet-5',
  'us.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-haiku-4.5',
];

const OLDER_OR_NOT_CLAUDE = [
  'us.anthropic.claude-3-5-haiku-20241022-v1:0', // Claude 3.x: 4K-8K maximum
  'anthropic.claude-3-opus-20240229-v1:0',
  'anthropic.claude-v2:1', // Claude 2.x
  'anthropic.claude-2-1',
  'us.openai.gpt-6-sol', // Responses API defaults to the model maximum
];

describe('defaultClaudeMaxOutputTokens', () => {
  it.each(CLAUDE_4_OR_5)('caps %s above the Bedrock 4,096 default', modelId => {
    expect(defaultClaudeMaxOutputTokens(modelId)).toBe(DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS);
  });

  it.each(OLDER_OR_NOT_CLAUDE)('leaves %s uncapped', modelId => {
    expect(defaultClaudeMaxOutputTokens(modelId)).toBeUndefined();
  });
});

describe('ClaudeAdapter default output cap', () => {
  it('applies the default when the caller sets no cap', () => {
    expect(adapter.enhance(configFor('us.anthropic.claude-sonnet-5-5')).maxTokens).toBe(
      DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS
    );
  });

  it('keeps a cap the caller set', () => {
    expect(adapter.enhance(configFor('us.anthropic.claude-sonnet-5-5', 2048)).maxTokens).toBe(2048);
  });

  it('sends no cap for an older Claude model', () => {
    expect(adapter.enhance(configFor('anthropic.claude-v2:1')).maxTokens).toBeUndefined();
  });
});
