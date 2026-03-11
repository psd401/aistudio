/**
 * Tests for PIITokenizationService
 *
 * Focuses on core functionality and token lifecycle.
 */

import { PIITokenizationService } from '../pii-tokenization-service';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-comprehend');
jest.mock('@aws-sdk/client-dynamodb');

import { DynamoDBClient, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';

describe('PIITokenizationService', () => {
  let service: PIITokenizationService;
  const TEST_REGION = 'us-west-2';

  beforeEach(() => {
    service = new PIITokenizationService({
      region: TEST_REGION,
      piiTokenTableName: 'test-table',
      tokenTtlSeconds: 3600,
      enablePiiTokenization: true,
    });
  });

  describe('isEnabled', () => {
    it('should return true when configured', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when not configured', () => {
      const disabledService = new PIITokenizationService({
        region: TEST_REGION,
        piiTokenTableName: undefined,
        enablePiiTokenization: false,
      });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('tokenize', () => {
    it('should pass through content when disabled', async () => {
      const disabledService = new PIITokenizationService({
        region: TEST_REGION,
        enablePiiTokenization: false,
      });

      const result = await disabledService.tokenize('Hello John', 'session-123');

      expect(result.tokenizedText).toBe('Hello John');
      expect(result.hasPII).toBe(false);
      expect(result.tokens).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      // Mock implementation will throw by default since AWS clients are mocked
      const result = await service.tokenize('Hello John', 'session-123');

      expect(result.tokenizedText).toBe('Hello John');
      expect(result.hasPII).toBe(false);
      expect(result.tokens).toEqual([]);
    });
  });

  describe('detokenize', () => {
    it('should pass through content when disabled', async () => {
      const disabledService = new PIITokenizationService({
        region: TEST_REGION,
        enablePiiTokenization: false,
      });

      const result = await disabledService.detokenize(
        '[PII:abc123]',
        'session-123'
      );

      expect(result).toBe('[PII:abc123]');
    });

    it('should handle missing tokens gracefully', async () => {
      // Mock implementation will throw by default since AWS clients are mocked
      const result = await service.detokenize(
        '[PII:12345678-1234-1234-1234-123456789012]',
        'session-123'
      );

      // Should return original text with placeholder when token not found
      expect(result).toContain('[PII:');
    });
  });

  describe('getConfig', () => {
    it('should return configuration', () => {
      const config = service.getConfig();

      expect(config).toHaveProperty('region');
      expect(config).toHaveProperty('piiTokenTableName');
      expect(config).toHaveProperty('tokenTtlSeconds');
      expect(config).toHaveProperty('enablePiiTokenization');
      expect(config.piiTokenTableName).toBe('test-table');
      expect(config.tokenTtlSeconds).toBe(3600);
    });
  });

  describe('edge cases', () => {
    it('should disable service when region not configured (local dev mode)', () => {
      // Save and clear env var
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

      // Should not throw - gracefully degrade to disabled state
      const localService = new PIITokenizationService({
        piiTokenTableName: 'test-table',
        enablePiiTokenization: true,
        // No region provided
      });

      // Service should be disabled
      expect(localService.isEnabled()).toBe(false);

      // Restore env var
      if (originalRegion) {
        process.env.AWS_REGION = originalRegion;
      }
    });

    it('should handle empty string content', async () => {
      const result = await service.tokenize('', 'session-123');
      expect(result.tokenizedText).toBe('');
      expect(result.hasPII).toBe(false);
      expect(result.tokens).toEqual([]);
    });

    it('should handle whitespace-only content', async () => {
      const result = await service.tokenize('   \n\t  ', 'session-123');
      expect(result.tokenizedText).toBe('   \n\t  ');
      expect(result.hasPII).toBe(false);
    });

    it('should handle very long content without hanging', async () => {
      const longContent = 'Hello John '.repeat(10000);
      const result = await service.tokenize(longContent, 'session-123');
      // Graceful degradation when mocked - should not throw or hang
      expect(result.tokenizedText).toBe(longContent);
    });

    it('should handle detokenize with no placeholders', async () => {
      const result = await service.detokenize('No PII here', 'session-123');
      expect(result).toBe('No PII here');
    });

    it('should handle invalid token format gracefully', async () => {
      // Not a valid UUID format - should be left as-is
      const result = await service.detokenize('[PII:invalid]', 'session-123');
      expect(result).toBe('[PII:invalid]');
    });
  });

  describe('duplicate token deduplication (Issue #836)', () => {
    const TOKEN_UUID = '12345678-1234-1234-1234-123456789012';
    const PLACEHOLDER = `[PII:${TOKEN_UUID}]`;

    // Capture BatchGetItemCommand constructor args since auto-mock doesn't preserve input
    let capturedBatchInputs: unknown[];
    let mockSend: jest.Mock;

    function setupMockDynamo(responses: Record<string, unknown[]>) {
      capturedBatchInputs = [];
      const MockedBatchGetItemCommand = BatchGetItemCommand as jest.MockedClass<typeof BatchGetItemCommand>;
      MockedBatchGetItemCommand.mockImplementation((input) => {
        capturedBatchInputs.push(input);
        return Object.assign(Object.create(BatchGetItemCommand.prototype), { input });
      });

      mockSend = jest.fn().mockResolvedValue({ Responses: responses });
      (DynamoDBClient as jest.MockedClass<typeof DynamoDBClient>).prototype.send = mockSend;
    }

    it('should deduplicate token IDs before BatchGetItem call', async () => {
      // Text with the same PII token appearing 3 times
      const text = `Hello ${PLACEHOLDER}, as ${PLACEHOLDER} mentioned, ${PLACEHOLDER} is correct.`;

      setupMockDynamo({
        'test-table': [
          { token: { S: TOKEN_UUID }, original: { S: 'John' }, sessionId: { S: 'session-123' }, type: { S: 'NAME' } },
        ],
      });

      const result = await service.detokenize(text, 'session-123');

      // BatchGetItem should be called once with only 1 unique key (not 3)
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(capturedBatchInputs).toHaveLength(1);
      const keys = (capturedBatchInputs[0] as Record<string, Record<string, { Keys: unknown[] }>>)
        .RequestItems['test-table'].Keys;
      expect(keys).toHaveLength(1);

      // All 3 occurrences should still be replaced
      expect(result).toBe('Hello John, as John mentioned, John is correct.');
    });

    it('should handle all-duplicate tokens as a single batch key', async () => {
      const text = `${PLACEHOLDER} ${PLACEHOLDER}`;

      setupMockDynamo({
        'test-table': [
          { token: { S: TOKEN_UUID }, original: { S: 'Jane' }, sessionId: { S: 'session-123' }, type: { S: 'NAME' } },
        ],
      });

      const result = await service.detokenize(text, 'session-123');

      const keys = (capturedBatchInputs[0] as Record<string, Record<string, { Keys: unknown[] }>>)
        .RequestItems['test-table'].Keys;
      expect(keys).toHaveLength(1);
      expect(result).toBe('Jane Jane');
    });

    it('should preserve unique tokens while deduplicating repeats', async () => {
      const TOKEN_A = '11111111-1111-1111-1111-111111111111';
      const TOKEN_B = '22222222-2222-2222-2222-222222222222';
      // A appears twice, B appears once → batch should have 2 keys
      const text = `[PII:${TOKEN_A}] and [PII:${TOKEN_B}] met [PII:${TOKEN_A}]`;

      setupMockDynamo({
        'test-table': [
          { token: { S: TOKEN_A }, original: { S: 'Alice' }, sessionId: { S: 'session-123' }, type: { S: 'NAME' } },
          { token: { S: TOKEN_B }, original: { S: 'Bob' }, sessionId: { S: 'session-123' }, type: { S: 'NAME' } },
        ],
      });

      const result = await service.detokenize(text, 'session-123');

      const keys = (capturedBatchInputs[0] as Record<string, Record<string, { Keys: unknown[] }>>)
        .RequestItems['test-table'].Keys;
      expect(keys).toHaveLength(2);
      expect(result).toBe('Alice and Bob met Alice');
    });
  });
});
