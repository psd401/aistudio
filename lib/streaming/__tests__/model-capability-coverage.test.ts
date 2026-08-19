/**
 * Guards the model-capability tables against the failure that produced empty
 * Nexus answers in production.
 *
 * `getAdaptiveTimeout` derives a stream's wall-clock budget from the capability
 * entry a provider adapter returns for a model ID. Those entries are matched by
 * hard-coded glob patterns, and the patterns had fallen a full generation behind
 * the model catalogue: `gemini-3-flash-preview`, `us.anthropic.claude-sonnet-4-6`
 * and `us.anthropic.claude-opus-4-6-v1` matched nothing, fell through to
 * `getDefaultCapabilities()`, and inherited a 30s abort. A Nexus turn that
 * searched an attachment then tried to write a long answer was cut off at
 * exactly 30s with `textLength: 0`.
 *
 * Two things are asserted here:
 *   1. Current production model IDs resolve to a workable budget.
 *   2. The DEFAULT entry is itself workable — pattern tables will always lag the
 *      catalogue, so the fallback has to fail safe rather than fail tight.
 *
 * @see ../provider-adapters/claude-adapter.ts
 * @see ../provider-adapters/gemini-adapter.ts
 * @see ../unified-streaming-service.ts (getAdaptiveTimeout)
 */

import { describe, it, expect } from '@jest/globals';
import { ClaudeAdapter } from '../provider-adapters/claude-adapter';
import { GeminiAdapter } from '../provider-adapters/gemini-adapter';
import { OpenAIAdapter } from '../provider-adapters/openai-adapter';

/**
 * Shortest budget in which a model can realistically produce a long answer —
 * a multi-paragraph schedule, a document summary. The prod incident aborted at
 * 30s, so anything at or below that is a regression of this exact bug.
 */
const MIN_WORKABLE_TIMEOUT_MS = 60_000;

const claude = new ClaudeAdapter();
const gemini = new GeminiAdapter();
const openai = new OpenAIAdapter();

/**
 * Model IDs the production router actually selects, observed in the
 * /ecs/aistudio-prod logs. Add to this list when a model is added to the
 * catalogue — a new entry failing here means its capabilities are unmapped.
 */
const PRODUCTION_MODELS: ReadonlyArray<{
  label: string;
  modelId: string;
  adapter: { getCapabilities(modelId: string): { maxTimeoutMs: number } };
}> = [
  { label: 'Claude Sonnet 4.6 (Bedrock)', modelId: 'us.anthropic.claude-sonnet-4-6', adapter: claude },
  { label: 'Claude Opus 4.6 (Bedrock)', modelId: 'us.anthropic.claude-opus-4-6-v1', adapter: claude },
  { label: 'Claude Sonnet 5', modelId: 'anthropic.claude-sonnet-5', adapter: claude },
  { label: 'Claude Haiku 4.5', modelId: 'claude-haiku-4.5', adapter: claude },
  { label: 'Gemini 3 Flash', modelId: 'gemini-3-flash-preview', adapter: gemini },
  { label: 'Gemini 3 Pro', modelId: 'gemini-3-pro-preview', adapter: gemini },
  { label: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro-preview', adapter: gemini },
  { label: 'GPT-5', modelId: 'gpt-5', adapter: openai },
];

describe('model capability coverage', () => {
  describe.each(PRODUCTION_MODELS)('$label', ({ modelId, adapter }) => {
    it('resolves a budget long enough to finish a long answer', () => {
      expect(adapter.getCapabilities(modelId).maxTimeoutMs).toBeGreaterThanOrEqual(
        MIN_WORKABLE_TIMEOUT_MS
      );
    });
  });

  it('gives an UNRECOGNISED model a workable budget, not the tightest one', () => {
    // Reaching the default means the model is newer than the pattern table, not
    // smaller — and new models are the ones most likely to write long answers.
    for (const adapter of [claude, gemini, openai]) {
      expect(
        adapter.getCapabilities('some-model-released-after-this-test-was-written')
          .maxTimeoutMs
      ).toBeGreaterThanOrEqual(MIN_WORKABLE_TIMEOUT_MS);
    }
  });
});

describe('capability pattern precedence', () => {
  it('does not let family-first Claude patterns swallow legacy version-first IDs', () => {
    // Legacy IDs put the version BEFORE the family (claude-3-5-haiku-*), so they
    // must keep resolving to their own entries rather than the Claude 4.x one.
    const legacyHaiku = claude.getCapabilities('us.anthropic.claude-3-5-haiku-20241022-v1');
    expect(legacyHaiku.supportsThinking).toBe(false);

    const legacySonnet = claude.getCapabilities('anthropic.claude-3-5-sonnet-20241022-v2');
    expect(legacySonnet.supportsThinking).toBe(false);

    const claude3Opus = claude.getCapabilities('anthropic.claude-3-opus-20240229-v1');
    expect(claude3Opus.supportsReasoning).toBe(false);
  });

  it('does not let the Gemini 3 pattern swallow Gemini 2.5 or 1.5', () => {
    expect(gemini.getCapabilities('gemini-2.5-flash').maxTimeoutMs).toBe(90000);
    expect(gemini.getCapabilities('gemini-1.5-flash-latest').maxTimeoutMs).toBe(30000);
  });

  it('distinguishes Claude families for cost estimation', () => {
    const opus = claude.getCapabilities('us.anthropic.claude-opus-4-6-v1');
    const sonnet = claude.getCapabilities('us.anthropic.claude-sonnet-4-6');
    const haiku = claude.getCapabilities('claude-haiku-4.5');

    expect(opus.costPerOutputToken).toBeGreaterThan(sonnet.costPerOutputToken!);
    expect(sonnet.costPerOutputToken).toBeGreaterThan(haiku.costPerOutputToken!);
  });
});
