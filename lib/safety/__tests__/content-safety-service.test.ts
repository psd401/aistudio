/**
 * Tests for ContentSafetyService (unified facade)
 *
 * Tests integration between guardrails and PII tokenization.
 */

import { ContentSafetyService } from '../content-safety-service';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-bedrock-runtime');
jest.mock('@aws-sdk/client-sns');
jest.mock('@aws-sdk/client-comprehend');
jest.mock('@aws-sdk/client-dynamodb');

describe('ContentSafetyService', () => {
  let service: ContentSafetyService;

  beforeEach(() => {
    service = new ContentSafetyService({
      guardrailId: 'test-guardrail',
      piiTokenTableName: 'test-table',
      enablePiiTokenization: true,
    });
  });

  describe('processInput', () => {
    it('should handle safety check and tokenization', async () => {
      const result = await service.processInput(
        'Hello John at john@example.com',
        'session-123'
      );

      // Should gracefully degrade when AWS services are mocked
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('processedContent');
      expect(result).toHaveProperty('hasPII');
    });

    it('should skip tokenization when disabled', async () => {
      const disabledService = new ContentSafetyService({
        guardrailId: 'test-guardrail',
        enablePiiTokenization: false,
      });

      const result = await disabledService.processInput(
        'Hello John',
        'session-123'
      );

      expect(result.processedContent).toBe('Hello John');
      expect(result.hasPII).toBe(false);
    });
  });

  describe('processOutput', () => {
    it('should handle safety check and detokenization', async () => {
      const result = await service.processOutput(
        '[PII:12345678-1234-1234-1234-123456789012]',
        'gpt-4',
        'openai',
        'session-123'
      );

      // Should gracefully degrade when AWS services are mocked
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('processedContent');
    });

    it('should skip detokenization when disabled', async () => {
      const disabledService = new ContentSafetyService({
        guardrailId: 'test-guardrail',
        enablePiiTokenization: false,
      });

      const result = await disabledService.processOutput(
        '[PII:test]',
        'gpt-4',
        'openai',
        'session-123'
      );

      expect(result.processedContent).toBe('[PII:test]');
    });
  });

  describe('isEnabled', () => {
    it('should return boolean indicating if any service is enabled', () => {
      const result = service.isEnabled();
      expect(typeof result).toBe('boolean');
    });

    it('should return true when guardrails service is configured', () => {
      const guardrailOnlyService = new ContentSafetyService({
        guardrailId: 'test-guardrail',
        enablePiiTokenization: false,
      });

      expect(guardrailOnlyService.isEnabled()).toBeTruthy();
    });
  });

  describe('getStatus', () => {
    it('should return service status', () => {
      const status = service.getStatus();

      expect(status).toHaveProperty('guardrailsEnabled');
      expect(status).toHaveProperty('piiTokenizationEnabled');
      expect(status).toHaveProperty('guardrailsConfig');
      expect(status).toHaveProperty('piiConfig');
    });
  });
});
