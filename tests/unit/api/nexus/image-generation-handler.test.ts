import { describe, it, expect } from '@jest/globals';

/**
 * Tests for image-generation-handler.ts
 *
 * These test the pure/synchronous functions that can be imported without
 * side effects. extractReferenceImages is async and accesses S3, so we
 * test it via a focused import that avoids triggering DB/S3 module resolution.
 */

// extractImagePrompt and validateImagePrompt are pure functions — safe to import directly
import { extractImagePrompt, validateImagePrompt } from '@/app/api/nexus/chat/image-generation-handler';

describe('extractImagePrompt', () => {
  it('returns empty string when messages array is empty', () => {
    const result = extractImagePrompt([]);
    expect(result).toBe('');
  });

  it('returns empty string when last message is not user role', () => {
    const result = extractImagePrompt([
      { id: '1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }
    ]);
    expect(result).toBe('');
  });

  it('extracts text from parts format', () => {
    const result = extractImagePrompt([
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'draw a cat' }] }
    ]);
    expect(result).toBe('draw a cat');
  });

  it('extracts text from string content format', () => {
    const result = extractImagePrompt([
      { id: '1', role: 'user', content: 'draw a dog' }
    ]);
    expect(result).toBe('draw a dog');
  });

  it('trims whitespace from prompt', () => {
    const result = extractImagePrompt([
      { id: '1', role: 'user', parts: [{ type: 'text', text: '  draw a bird  ' }] }
    ]);
    expect(result).toBe('draw a bird');
  });
});

describe('validateImagePrompt', () => {
  it('returns invalid for empty prompt', () => {
    const result = validateImagePrompt('');
    expect(result.valid).toBe(false);
  });

  it('returns valid for normal prompt', () => {
    const result = validateImagePrompt('a beautiful sunset over the ocean');
    expect(result.valid).toBe(true);
  });

  it('returns invalid for prompt exceeding 4000 characters', () => {
    const longPrompt = 'a'.repeat(4001);
    const result = validateImagePrompt(longPrompt);
    expect(result.valid).toBe(false);
  });

  it('returns invalid for prompt with forbidden patterns', () => {
    const result = validateImagePrompt('create an explicit image');
    expect(result.valid).toBe(false);
  });
});

describe('extractReferenceImages', () => {
  // Dynamic import to avoid top-level DB/S3 module resolution
  async function getExtractReferenceImages() {
    const mod = await import('@/app/api/nexus/chat/image-generation-handler');
    return mod.extractReferenceImages;
  }

  it('returns empty array when lastMessage is undefined', async () => {
    const extractReferenceImages = await getExtractReferenceImages();
    const result = await extractReferenceImages(undefined);
    expect(result).toEqual([]);
  });

  it('returns empty array when message has no parts', async () => {
    const extractReferenceImages = await getExtractReferenceImages();
    const result = await extractReferenceImages({ id: '1', role: 'user' });
    expect(result).toEqual([]);
  });

  it('returns empty array when parts is not an array', async () => {
    const extractReferenceImages = await getExtractReferenceImages();
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: 'not-an-array' as unknown as Array<{ type: string }>
    });
    expect(result).toEqual([]);
  });

  it('returns empty array when parts has only text', async () => {
    const extractReferenceImages = await getExtractReferenceImages();
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'text', text: 'draw something' }]
    });
    expect(result).toEqual([]);
  });
});
