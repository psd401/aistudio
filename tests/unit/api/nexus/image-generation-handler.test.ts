/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Readable } from 'node:stream';

// Use the global `jest` (not the @jest/globals import) so next/jest's SWC hoists
// this jest.mock above the handler import.
const mockGetAttachmentFromS3 = jest.fn();
jest.mock('@/lib/services/attachment-storage-service', () => ({
  getAttachmentFromS3: (key: string) => mockGetAttachmentFromS3(key),
}));

const mockDeleteDocumentVersions = jest.fn();
const mockGetObjectStream = jest.fn();
jest.mock('@/lib/aws/s3-client', () => ({
  deleteDocumentVersions: (key: string) => mockDeleteDocumentVersions(key),
  getObjectStream: (key: string) => mockGetObjectStream(key),
}));

const mockExecuteQuery = jest.fn();
const mockExecuteTransaction = jest.fn();
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: (...a: unknown[]) => mockExecuteQuery(...a),
  executeTransaction: (...a: unknown[]) => mockExecuteTransaction(...a),
}));

import {
  extractImagePrompt,
  validateImagePrompt,
  extractReferenceImages,
  getImageRoutingContext,
  persistImageExchange,
  deleteUnpersistedGeneratedImage,
  extractCanonicalRepositoryImages,
  handleImageGenerationError
} from '@/app/api/nexus/chat/image-generation-handler';

const CONVO = 'conv-123';
const IN_PREFIX_KEY = `conversations/${CONVO}/attachments/msg-0-ref.png`;

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

  it('does not block on substring keywords (provider/guardrails handle moderation)', () => {
    // Educational prompts that the old naive blocklist falsely rejected.
    // Content moderation belongs to the upstream provider + Bedrock guardrails,
    // not a local substring filter.
    expect(validateImagePrompt('a Civil War weapon on display').valid).toBe(true);
    expect(validateImagePrompt('diagram of red blood cells').valid).toBe(true);
    expect(validateImagePrompt('a memorial honoring the deaths of soldiers').valid).toBe(true);
  });
});

describe('extractReferenceImages', () => {
  beforeEach(() => {
    mockGetAttachmentFromS3.mockReset();
  });

  it('returns empty array when lastMessage is undefined', async () => {
    const result = await extractReferenceImages(undefined, CONVO);
    expect(result).toEqual([]);
  });

  it('returns empty array when message has no parts', async () => {
    const result = await extractReferenceImages({ id: '1', role: 'user' }, CONVO);
    expect(result).toEqual([]);
  });

  it('returns empty array when parts is not an array', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: 'not-an-array' as unknown as Array<{ type: string }>
    }, CONVO);
    expect(result).toEqual([]);
  });

  it('returns empty array when parts has only text', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'text', text: 'draw something' }]
    }, CONVO);
    expect(result).toEqual([]);
  });

  it('skips file parts with non-allowlisted MIME type (e.g. SVG)', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }]
    }, CONVO);
    expect(result).toEqual([]);
  });

  it('includes file parts with allowed MIME type', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/jpeg', data: '/9j/4AAQ' }]
    }, CONVO);
    expect(result.length).toBe(1);
    expect(result[0].mimeType).toBe('image/jpeg');
  });

  it('skips image parts with s3:// URL but no s3Key', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'image', image: 's3://bucket/key.png' }]
    }, CONVO);
    expect(result).toEqual([]);
  });

  // REV-SEC-144: reject client-supplied S3 keys outside the conversation's prefix
  it('rejects an image s3Key outside the conversation prefix (never reads S3)', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'image', s3Key: 'conversations/OTHER-CONVO/attachments/secret.png' }]
    }, CONVO);
    expect(result).toEqual([]);
    expect(mockGetAttachmentFromS3).not.toHaveBeenCalled();
  });

  it('rejects a file s3Key (via s3:// url) outside the conversation prefix', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/png', url: 's3://bucket/conversations/OTHER/attachments/x.png' }]
    }, CONVO);
    expect(result).toEqual([]);
    expect(mockGetAttachmentFromS3).not.toHaveBeenCalled();
  });

  it('loads an image reference whose s3Key is within the conversation prefix', async () => {
    mockGetAttachmentFromS3.mockResolvedValue({ type: 'image', image: 'BASE64DATA', contentType: 'image/png' });
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'image', s3Key: IN_PREFIX_KEY }]
    }, CONVO);
    expect(mockGetAttachmentFromS3).toHaveBeenCalledWith(IN_PREFIX_KEY);
    expect(result.length).toBe(1);
    expect(result[0].base64).toBe('BASE64DATA');
  });

  // REV-SEC-142: reject SSRF targets in client-supplied reference URLs
  it('rejects an image imageUrl pointing at the cloud metadata endpoint (SSRF)', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'image', imageUrl: 'http://169.254.169.254/latest/meta-data/iam/' }]
    }, CONVO);
    expect(result).toEqual([]);
  });

  it('rejects a file url pointing at loopback (SSRF)', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/png', url: 'http://127.0.0.1:8080/internal.png' }]
    }, CONVO);
    expect(result).toEqual([]);
  });

  it('allows a normal public https image URL reference', async () => {
    const result = await extractReferenceImages({
      id: '1',
      role: 'user',
      parts: [{ type: 'image', imageUrl: 'https://example.com/cat.png' }]
    }, CONVO);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://example.com/cat.png');
  });
});

describe('getImageRoutingContext', () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset();
  });

  it('uses an image attached to the current user turn without querying history', async () => {
    const result = await getImageRoutingContext({
      messages: [{
        id: '1',
        role: 'user',
        parts: [{ type: 'file', mediaType: 'image/png' }],
      }],
      conversationId: CONVO,
      userId: 42,
    });

    expect(result).toEqual({ hasImageInput: true, hasPreviousGeneratedImage: false });
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it('preserves persisted generated-image context for an elliptical follow-up edit', async () => {
    mockExecuteQuery.mockResolvedValue([{
      parts: [{ type: 'image', s3Key: `v2/generated-images/${CONVO}/latest.png` }],
    }]);

    const result = await getImageRoutingContext({
      messages: [{ id: '2', role: 'user', parts: [{ type: 'text', text: 'Make it brighter' }] }],
      conversationId: CONVO,
      userId: 42,
    });

    expect(result).toEqual({ hasImageInput: false, hasPreviousGeneratedImage: true });
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });

  it('does not invent previous image context when owned persisted history has none', async () => {
    mockExecuteQuery.mockResolvedValue([{ parts: [{ type: 'text', text: 'No image here' }] }]);

    const result = await getImageRoutingContext({
      messages: [{ id: '3', role: 'user', parts: [{ type: 'text', text: 'Make it brighter' }] }],
      conversationId: CONVO,
      userId: 42,
    });

    expect(result).toEqual({ hasImageInput: false, hasPreviousGeneratedImage: false });
  });

  it('degrades to no prior image context when the optional history lookup fails', async () => {
    mockExecuteQuery.mockRejectedValue(new Error('database unavailable'));

    await expect(getImageRoutingContext({
      messages: [{ id: '4', role: 'user', parts: [{ type: 'text', text: 'Make it brighter' }] }],
      conversationId: CONVO,
      userId: 42,
    })).resolves.toEqual({ hasImageInput: false, hasPreviousGeneratedImage: false });
  });
});

describe('persistImageExchange (REV-DB-047 / REV-COR-220)', () => {
  function makeTx() {
    const insertValues = jest.fn(async () => {});
    const updateWhere = jest.fn(async () => {});
    const updateSet = jest.fn(() => ({ where: updateWhere }));
    const tx = {
      insert: jest.fn(() => ({ values: insertValues })),
      update: jest.fn(() => ({ set: updateSet })),
    };
    return { tx, insertValues, updateWhere };
  }

  beforeEach(() => {
    mockExecuteTransaction.mockReset();
    mockExecuteQuery.mockReset();
  });

  const imageResult = { imageUrl: 'https://s3/img.png', s3Key: 'v2/generated-images/c1/x.png', altText: 'a cat' };

  it('inserts both messages and the stats update inside one executeTransaction', async () => {
    const { tx, insertValues, updateWhere } = makeTx();
    mockExecuteTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));

    await persistImageExchange({ conversationId: 'c1', imagePrompt: 'draw a cat', imageResult, dbModelId: 7 });

    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteTransaction.mock.calls[0][1]).toBe('persistImageExchange');
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    // user row + assistant row = two inserts, then one stats update — all atomic.
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('rejects (rolls back) when the transaction fails', async () => {
    mockExecuteTransaction.mockRejectedValue(new Error('insert failed'));

    await expect(
      persistImageExchange({ conversationId: 'c1', imagePrompt: 'x', imageResult, dbModelId: 7 })
    ).rejects.toThrow('insert failed');
  });
});

describe('deleteUnpersistedGeneratedImage', () => {
  beforeEach(() => {
    mockDeleteDocumentVersions.mockReset();
    mockDeleteDocumentVersions.mockResolvedValue(1);
  });

  it('deletes every version of the exact conversation-scoped generated key', async () => {
    const key = 'v2/generated-images/conv-123/1234-model.png';

    await expect(
      deleteUnpersistedGeneratedImage({
        conversationId: 'conv-123',
        s3Key: key,
      })
    ).resolves.toBe(true);
    expect(mockDeleteDocumentVersions).toHaveBeenCalledWith(key);
  });

  it('refuses to delete an object outside the generated-image conversation prefix', async () => {
    await expect(
      deleteUnpersistedGeneratedImage({
        conversationId: 'conv-123',
        s3Key: 'v2/generated-images/another-conversation/image.png',
      })
    ).resolves.toBe(false);
    expect(mockDeleteDocumentVersions).not.toHaveBeenCalled();
  });
});

describe('extractCanonicalRepositoryImages', () => {
  beforeEach(() => {
    mockGetObjectStream.mockReset();
  });

  const source = {
    bindingId: '123e4567-e89b-42d3-a456-426614174000',
    repositoryId: 77,
    itemId: 88,
    itemVersionId: '223e4567-e89b-42d3-a456-426614174000',
    objectKey:
      'repositories/77/323e4567-e89b-42d3-a456-426614174000/photo.png',
    declaredContentType: 'image/png',
    detectedContentType: 'image/png',
    byteSize: 7,
  };

  it('loads the exact immutable canonical object instead of caller inline pixels', async () => {
    mockGetObjectStream.mockResolvedValue({
      stream: Readable.from([Buffer.from('IMAGE-A')]),
      contentType: 'image/png',
      contentLength: 7,
    });

    await expect(extractCanonicalRepositoryImages([source])).resolves.toEqual([
      {
        base64: `data:image/png;base64,${Buffer.from('IMAGE-A').toString('base64')}`,
        mimeType: 'image/png',
        role: 'reference',
      },
    ]);
    expect(mockGetObjectStream).toHaveBeenCalledWith(source.objectKey);
  });

  it('rejects a cross-repository object key before reading storage', async () => {
    await expect(
      extractCanonicalRepositoryImages([
        {
          ...source,
          objectKey:
            'repositories/78/323e4567-e89b-42d3-a456-426614174000/photo.png',
        },
      ])
    ).rejects.toMatchObject({ type: 'INVALID_ATTACHMENT' });
    expect(mockGetObjectStream).not.toHaveBeenCalled();
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

  it('returns a bounded 400 for an invalid canonical image attachment', () => {
    const error = Object.assign(new Error('private storage detail'), {
      type: 'INVALID_ATTACHMENT',
    });
    const response = handleImageGenerationError(
      error,
      'conv-123',
      'req-456'
    );

    expect(response.status).toBe(400);
    const body = getLastBody();
    expect(body.code).toBe('INVALID_ATTACHMENT');
    expect(String(body.error)).not.toContain('private storage detail');
  });
});
