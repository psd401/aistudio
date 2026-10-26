/**
 * Bedrock Converse caps Claude at 4,096 output tokens when no maxOutputTokens is
 * sent, and Claude 5.x adaptive thinking counts against it. Nexus never sent a
 * cap, so long turns (grading a class set) ended `finishReason: length` with no
 * text — "This turn ended without a written answer" (prod, 2026-10-26).
 */
import { describe, it, expect } from '@jest/globals';
import type { LanguageModel } from 'ai';
import { ClaudeAdapter, DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS } from '../provider-adapters/claude-adapter';
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

describe('ClaudeAdapter default output cap', () => {
  it.each([
    'us.anthropic.claude-sonnet-5-5',
    'us.anthropic.claude-opus-5-5',
    'us.anthropic.claude-haiku-5-5',
    'us.anthropic.claude-opus-4-6-v1',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ])('raises %s above the Bedrock 4,096 default when the caller sets none', modelId => {
    expect(adapter.enhance(configFor(modelId)).maxTokens).toBe(DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS);
    expect(DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
  });

  it('keeps a cap the caller set', () => {
    expect(adapter.enhance(configFor('us.anthropic.claude-sonnet-5-5', 2048)).maxTokens).toBe(2048);
  });

  it('leaves Claude 3.x (4K-8K maximum) and Bedrock GPT models uncapped', () => {
    expect(adapter.enhance(configFor('us.anthropic.claude-3-5-haiku-20241022-v1:0')).maxTokens).toBeUndefined();
    expect(adapter.enhance(configFor('us.openai.gpt-6-sol')).maxTokens).toBeUndefined();
  });
});
