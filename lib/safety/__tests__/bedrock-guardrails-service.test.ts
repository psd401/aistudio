/**
 * Tests for BedrockGuardrailsService
 *
 * Focuses on core functionality and error handling.
 */

import { BedrockGuardrailsService } from '../bedrock-guardrails-service';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-bedrock-runtime');
jest.mock('@aws-sdk/client-sns');

describe('BedrockGuardrailsService', () => {
  let service: BedrockGuardrailsService;
  const TEST_REGION = 'us-west-2';

  beforeEach(() => {
    service = new BedrockGuardrailsService({
      region: TEST_REGION,
      guardrailId: 'test-guardrail-id',
      guardrailVersion: 'DRAFT',
    });
  });

  describe('isEnabled', () => {
    it('should return true when guardrail ID is configured', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when guardrail ID is not configured', () => {
      const disabledService = new BedrockGuardrailsService({
        region: TEST_REGION,
        guardrailId: '',
      });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('evaluateInput', () => {
    it('should pass through content when guardrails disabled', async () => {
      const disabledService = new BedrockGuardrailsService({
        region: TEST_REGION,
        guardrailId: '',
      });

      const result = await disabledService.evaluateInput('test content');

      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });

    it('should handle errors gracefully and allow content', async () => {
      // Mock implementation will throw by default since AWS clients are mocked
      const result = await service.evaluateInput('test content');

      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });
  });

  describe('evaluateOutput', () => {
    it('should pass through content when guardrails disabled', async () => {
      const disabledService = new BedrockGuardrailsService({
        region: TEST_REGION,
        guardrailId: '',
      });

      const result = await disabledService.evaluateOutput(
        'test content',
        'gpt-4',
        'openai'
      );

      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });

    it('should handle errors gracefully and allow content', async () => {
      // Mock implementation will throw by default since AWS clients are mocked
      const result = await service.evaluateOutput(
        'test content',
        'gpt-4',
        'openai'
      );

      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });
  });

  describe('getConfig', () => {
    it('should return configuration without sensitive data', () => {
      const config = service.getConfig();

      expect(config).toHaveProperty('region');
      expect(config).toHaveProperty('guardrailId');
      expect(config).toHaveProperty('guardrailVersion');
      expect(config).toHaveProperty('enablePiiTokenization');
      expect(config).toHaveProperty('enableViolationNotifications');
      expect(config).not.toHaveProperty('violationTopicArn'); // Sensitive data excluded
    });
  });

  describe('edge cases', () => {
    it('should throw error when region not configured', () => {
      // Save and clear env var
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

      expect(() => {
        new BedrockGuardrailsService({
          guardrailId: 'test-guardrail',
          // No region provided
        });
      }).toThrow('AWS_REGION environment variable or config.region is required');

      // Restore env var
      if (originalRegion) {
        process.env.AWS_REGION = originalRegion;
      }
    });

    it('should handle empty string content gracefully', async () => {
      const result = await service.evaluateInput('');
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('');
    });

    it('should handle whitespace-only content', async () => {
      const result = await service.evaluateInput('   \n\t  ');
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('   \n\t  ');
    });

    it('should handle very long content', async () => {
      const longContent = 'a'.repeat(100000);
      const result = await service.evaluateInput(longContent);
      // Graceful degradation when mocked - should not throw
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe(longContent);
    });
  });
});
