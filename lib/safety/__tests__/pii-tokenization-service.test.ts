/**
 * Tests for PIITokenizationService
 *
 * Focuses on core functionality and token lifecycle.
 */

import { PIITokenizationService } from '../pii-tokenization-service';
import { PII_MIN_CONFIDENCE_SCORE } from '../types';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-comprehend');
jest.mock('@aws-sdk/client-dynamodb');

import { ComprehendClient, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { DynamoDBClient, BatchGetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

interface MockBatchGetItemInput {
  RequestItems: {
    [tableName: string]: {
      Keys: Array<{ token: { S: string }; sessionId: { S: string } }>;
    };
  };
}

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

  describe('confidence score threshold (Issue #972)', () => {
    const SESSION = 'session-threshold-test';

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockComprehendResponse(entities: Array<{ Type: string; BeginOffset: number; EndOffset: number; Score: number }>) {
      const MockedDetectPiiEntitiesCommand = DetectPiiEntitiesCommand as jest.MockedClass<typeof DetectPiiEntitiesCommand>;
      MockedDetectPiiEntitiesCommand.mockImplementation((input) =>
        Object.assign(Object.create(DetectPiiEntitiesCommand.prototype), { input })
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(ComprehendClient.prototype as any, 'send')
        .mockResolvedValue({ Entities: entities });

      // DynamoDB PutItem must succeed for tokens to be stored
      const MockedPutItemCommand = PutItemCommand as jest.MockedClass<typeof PutItemCommand>;
      MockedPutItemCommand.mockImplementation((input) =>
        Object.assign(Object.create(PutItemCommand.prototype), { input })
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(DynamoDBClient.prototype as any, 'send')
        .mockResolvedValue({});
    }

    it('should NOT tokenize Comprehend detections below the confidence threshold', async () => {
      // Simulate "AP-505" misclassified as NAME with low confidence
      mockComprehendResponse([
        { Type: 'NAME', BeginOffset: 34, EndOffset: 40, Score: 0.72 },
      ]);

      const text = 'Compare these Aruba access points: AP-505 and AP-515';
      const result = await service.tokenize(text, SESSION);

      expect(result.hasPII).toBe(false);
      expect(result.tokens).toHaveLength(0);
      expect(result.tokenizedText).toBe(text);
    });

    it('should NOT tokenize NAME detections at exactly the threshold boundary (score < threshold)', async () => {
      // Score of 0.89 is just below the 0.90 threshold
      mockComprehendResponse([
        { Type: 'NAME', BeginOffset: 7, EndOffset: 17, Score: PII_MIN_CONFIDENCE_SCORE - 0.01 },
      ]);

      const text = 'Hello JW177A, please confirm your model.';
      const result = await service.tokenize(text, SESSION);

      expect(result.hasPII).toBe(false);
      expect(result.tokens).toHaveLength(0);
    });

    it('should tokenize NAME detections at or above the threshold', async () => {
      // High-confidence real name detection
      mockComprehendResponse([
        { Type: 'NAME', BeginOffset: 6, EndOffset: 16, Score: 0.99 },
      ]);

      const text = 'Hello John Smith, how are you?';
      const result = await service.tokenize(text, SESSION);

      expect(result.hasPII).toBe(true);
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].type).toBe('NAME');
      expect(result.tokenizedText).not.toContain('John Smith');
    });

    it('should tokenize NAME at exactly the threshold boundary (score === threshold)', async () => {
      mockComprehendResponse([
        { Type: 'NAME', BeginOffset: 6, EndOffset: 16, Score: PII_MIN_CONFIDENCE_SCORE },
      ]);

      const text = 'Hello John Smith, how are you?';
      const result = await service.tokenize(text, SESSION);

      expect(result.hasPII).toBe(true);
      expect(result.tokens).toHaveLength(1);
    });

    it('should NOT tokenize DATE_TIME or AGE misclassified from version strings at low confidence', async () => {
      mockComprehendResponse([
        { Type: 'DATE_TIME', BeginOffset: 17, EndOffset: 23, Score: 0.65 },
        { Type: 'AGE', BeginOffset: 33, EndOffset: 36, Score: 0.71 },
      ]);

      const text = 'Firmware version 3.2.14 requires age 18+ authorization.';
      const result = await service.tokenize(text, SESSION);

      expect(result.hasPII).toBe(false);
      expect(result.tokens).toHaveLength(0);
    });

    it('should tokenize a mix: reject low-confidence hardware hit, keep high-confidence real PII', async () => {
      mockComprehendResponse([
        { Type: 'NAME', BeginOffset: 38, EndOffset: 44, Score: 0.78 },   // "AP-505" → false positive
        { Type: 'EMAIL', BeginOffset: 56, EndOffset: 78, Score: 0.997 },  // real email
      ]);

      const text = 'Please compare the Aruba access point AP-505 with user@example.com for support.';
      const result = await service.tokenize(text, SESSION);

      expect(result.hasPII).toBe(true);
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].type).toBe('EMAIL');
      // The hardware model should be preserved in the tokenized text
      expect(result.tokenizedText).toContain('AP-505');
    });
  });

  describe('duplicate token deduplication (Issue #836)', () => {
    const TOKEN_UUID = '12345678-1234-1234-1234-123456789012';
    const PLACEHOLDER = `[PII:${TOKEN_UUID}]`;

    // Capture BatchGetItemCommand constructor args since auto-mock doesn't preserve input
    let capturedBatchInputs: MockBatchGetItemInput[];

    afterEach(() => {
      // restoreAllMocks() only restores jest.spyOn spies — not direct prototype assignments.
      // Using jest.spyOn below ensures this cleanup is actually effective.
      jest.restoreAllMocks();
    });

    function setupMockDynamo(responses: Record<string, unknown[]>) {
      capturedBatchInputs = [];
      const MockedBatchGetItemCommand = BatchGetItemCommand as jest.MockedClass<typeof BatchGetItemCommand>;
      MockedBatchGetItemCommand.mockImplementation((input) => {
        capturedBatchInputs.push(input as unknown as MockBatchGetItemInput);
        return Object.assign(Object.create(BatchGetItemCommand.prototype), { input });
      });

      // Use jest.spyOn (not direct assignment) so afterEach restoreAllMocks() cleans up.
      // Direct assignment (prototype.send = mockFn) is NOT restored by restoreAllMocks()
      // and would leak mock state to subsequent tests in the same worker.
      // Cast prototype to any: DynamoDBClient.send is overloaded and TypeScript
      // resolves the intersection to `never`, blocking mockResolvedValue without the cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(DynamoDBClient.prototype as any, 'send')
        .mockResolvedValue({ Responses: responses });
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
      expect(capturedBatchInputs).toHaveLength(1);
      const keys = capturedBatchInputs[0].RequestItems['test-table'].Keys;
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

      expect(capturedBatchInputs).toHaveLength(1);
      const keys = capturedBatchInputs[0].RequestItems['test-table'].Keys;
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

      expect(capturedBatchInputs).toHaveLength(1);
      const keys = capturedBatchInputs[0].RequestItems['test-table'].Keys;
      expect(keys).toHaveLength(2);
      expect(result).toBe('Alice and Bob met Alice');
    });
  });
});
