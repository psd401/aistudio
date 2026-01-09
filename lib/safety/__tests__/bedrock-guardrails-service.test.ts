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

  beforeEach(() => {
    service = new BedrockGuardrailsService({
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
        guardrailId: '',
      });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('evaluateInput', () => {
    it('should pass through content when guardrails disabled', async () => {
      const disabledService = new BedrockGuardrailsService({
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
});
