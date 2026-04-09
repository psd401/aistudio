/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  extractImagePrompt,
  validateImagePrompt,
  extractReferenceImages,
  handleImageGenerationError
} from '@/app/api/nexus/chat/image-generation-handler';

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
  it('returns empty array when lastMessage is undefined', async () => {
    const result = await extractReferenceImages(undefined);
    expect(result).toEqual([]);
  });

  it('returns empty array when message has no parts', async () => {
    const result = await extractReferenceImages({ id: '1', role: 'user' });
    expect(result).toEqual([]);
  });

  it('returns empty array when parts is not an array', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: 'not-an-array' as unknown as Array<{ type: string }>
    });
    expect(result).toEqual([]);
  });

  it('returns empty array when parts has only text', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'text', text: 'draw something' }]
    });
    expect(result).toEqual([]);
  });
});

describe('handleImageGenerationError', () => {
  // jest-environment-jsdom's Response polyfill lacks body-reading methods (.text(), .json()).
  // Spy on Response constructor to capture the body string argument directly.
  let responseBodies: string[];
  const OriginalResponse = globalThis.Response;

  beforeEach(() => {
    responseBodies = [];
    globalThis.Response = class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init);
        if (typeof body === 'string') responseBodies.push(body);
      }
    } as typeof Response;
  });

  afterEach(() => {
    globalThis.Response = OriginalResponse;
  });

  function getLastBody(): Record<string, unknown> {
    return JSON.parse(responseBodies[responseBodies.length - 1]) as Record<string, unknown>;
  }

  it('does not expose error details in 500 response body', () => {
    const error = new Error('Internal provider SDK trace: connection to api.openai.com failed');
    const response = handleImageGenerationError(error, 'conv-123', 'req-456');

    expect(response.status).toBe(500);
    const body = getLastBody();
    expect(body.error).toBe('Image generation failed. Please try again.');
    expect(body).not.toHaveProperty('details');
    expect(body.requestId).toBe('req-456');
  });

  it('returns generic message for CONTENT_POLICY errors', () => {
    const error = Object.assign(new Error('prompt contains nude content: "user prompt text here"'), { type: 'CONTENT_POLICY' });
    const response = handleImageGenerationError(error, 'conv-123', 'req-456');

    expect(response.status).toBe(400);
    const body = getLastBody();
    expect(body.code).toBe('CONTENT_POLICY');
    expect(String(body.error)).not.toContain('user prompt text here');
  });

  it('returns generic message for RATE_LIMIT errors', () => {
    const error = Object.assign(new Error('Rate limit exceeded for org-abc123'), { type: 'RATE_LIMIT', retryAfter: 30 });
    const response = handleImageGenerationError(error, 'conv-123', 'req-456');

    expect(response.status).toBe(429);
    const body = getLastBody();
    expect(body.code).toBe('RATE_LIMIT');
    expect(String(body.error)).not.toContain('org-abc123');
    expect(body.retryAfter).toBe(30);
  });

  it('returns generic message for AUTHENTICATION errors with requestId', () => {
    const error = Object.assign(new Error('API key sk-proj-abc123 is invalid'), { type: 'AUTHENTICATION' });
    const response = handleImageGenerationError(error, 'conv-123', 'req-456');

    expect(response.status).toBe(401);
    const body = getLastBody();
    expect(body.code).toBe('AUTH_ERROR');
    expect(String(body.error)).not.toContain('sk-proj-abc123');
    expect(body.requestId).toBe('req-456');
  });
});
