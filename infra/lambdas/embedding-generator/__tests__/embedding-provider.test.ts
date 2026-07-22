import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL_ID,
  DEFAULT_EMBEDDING_PROVIDER,
  buildBedrockEmbeddingBody,
  embeddingDescriptor,
  normalizeEmbeddingProvider,
  parseEmbeddingDescriptor,
  parseEmbeddingVector,
} from '../embedding-provider';

describe('embedding provider contract', () => {
  test('defaults to the IAM-authenticated Bedrock compatibility model', () => {
    expect(DEFAULT_EMBEDDING_PROVIDER).toBe('amazon-bedrock');
    expect(DEFAULT_EMBEDDING_MODEL_ID).toBe('amazon.titan-embed-text-v1');
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(1536);
  });

  test('normalizes provider aliases into a stable generation descriptor', () => {
    expect(normalizeEmbeddingProvider('bedrock')).toBe('amazon-bedrock');
    expect(embeddingDescriptor('bedrock', 'amazon.titan-embed-text-v1')).toBe(
      'amazon-bedrock:amazon.titan-embed-text-v1',
    );
  });

  test('parses generation descriptors without losing model colons', () => {
    expect(
      parseEmbeddingDescriptor(
        'amazon-bedrock:amazon.titan-embed-text-v2:0',
        1024,
      ),
    ).toEqual({
      provider: 'amazon-bedrock',
      modelId: 'amazon.titan-embed-text-v2:0',
      dimensions: 1024,
    });
    expect(() => parseEmbeddingDescriptor('amazon-bedrock', 1536)).toThrow(
      'Invalid index generation embedding descriptor',
    );
  });

  test('builds model-specific Titan requests', () => {
    expect(JSON.parse(buildBedrockEmbeddingBody('amazon.titan-embed-text-v1', ' hello ', 1536))).toEqual({
      inputText: 'hello',
    });
    expect(JSON.parse(buildBedrockEmbeddingBody('amazon.titan-embed-text-v2:0', 'hello', 1024))).toEqual({
      inputText: 'hello',
      dimensions: 1024,
      normalize: true,
    });
  });

  test('rejects an incompatible model dimension before invoking Bedrock', () => {
    expect(() => buildBedrockEmbeddingBody('amazon.titan-embed-text-v2:0', 'hello', 1536)).toThrow(
      'does not support 1536 dimensions',
    );
  });

  test('validates the provider response shape and values', () => {
    expect(parseEmbeddingVector({ embedding: [0.1, 0.2] }, 2, 'test-model')).toEqual([0.1, 0.2]);
    expect(() => parseEmbeddingVector({ embedding: [Number.NaN] }, 1, 'test-model')).toThrow('non-finite');
  });
});
