/**
 * Tests for PIITokenizationService
 *
 * Focuses on core functionality and token lifecycle.
 */

import { PIITokenizationService } from '../pii-tokenization-service';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-comprehend');
jest.mock('@aws-sdk/client-dynamodb');

describe('PIITokenizationService', () => {
  let service: PIITokenizationService;

  beforeEach(() => {
    service = new PIITokenizationService({
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
        piiTokenTableName: undefined,
        enablePiiTokenization: false,
      });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('tokenize', () => {
    it('should pass through content when disabled', async () => {
      const disabledService = new PIITokenizationService({
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
});
