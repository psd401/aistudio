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
    it('should disable service when region not configured (local dev mode)', () => {
      // Save and clear env var
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

      // Should not throw - gracefully degrade to disabled state
      const localService = new BedrockGuardrailsService({
        guardrailId: 'test-guardrail',
        // No region provided
      });

      // Service should be disabled
      expect(localService.isEnabled()).toBe(false);

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

  /**
   * Educational Content Test Cases (Issue #639)
   *
   * These tests document the types of legitimate educational content that should
   * be allowed through the guardrails. They use mocked clients so they test
   * graceful degradation rather than actual filter behavior.
   *
   * The actual filter behavior is configured in:
   * - infra/lib/guardrails-stack.ts (CDK configuration)
   * - AWS Bedrock Guardrails console
   *
   * These tests serve as documentation and regression tests to ensure the
   * service handles educational content gracefully.
   */
  describe('educational content (Issue #639)', () => {
    // Sample teacher observation content that was blocked (conversation 12f266db)
    const teacherObservationContent = `
      as an expert, veteran principal in the state of washington, please look at the attached
      observation notes to provide evidence coding for the criterion and components in the
      attached 2022 danielson framework document.

      Observation Notes:
      Teacher working with one student on solving problems
      Directed student's attention to "size of the problem" poster
      Student chose to focus on the problem that happened during reading time
      Teacher: "what is the problem in that situation?" Student: "it's a little problem"
      Teacher: "one thing you're amazing at is identifying a problem"
      Student: "i argued"
      Teacher: "so you need the reminders?" Student: "yes"
      Teacher discussed consequences about losing tickets
      Student mentioned feeling nervous and experiencing anxiety
    `;

    it('should process teacher observation content without error', async () => {
      // With mocked AWS client, this tests graceful degradation
      const result = await service.evaluateInput(teacherObservationContent);

      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe(teacherObservationContent);
    });

    it('should process Danielson Framework evaluation requests', async () => {
      const danielsonRequest = `
        Please evaluate this lesson using the Danielson Framework criteria:
        - Criterion 1: Centering instruction on high expectations
        - Component 2b: Fostering a Culture for Learning
        - Component 3a: Communicating About Purpose and Content

        The teacher was working with a student who had behavioral challenges during
        the reading instruction period. The student mentioned they "argued" and
        discussed consequences for not showing expected behavior.
      `;

      const result = await service.evaluateInput(danielsonRequest);
      expect(result.allowed).toBe(true);
    });

    it('should process behavior management discussions', async () => {
      const behaviorContent = `
        Student behavior report:
        - Student argued with teacher about materials
        - Discussed consequences: losing tickets
        - Student expressed feeling nervous and anxious
        - Teacher helped student identify problem-solving strategies
        - Discussed "what ifs" thinking patterns related to anxiety
      `;

      const result = await service.evaluateInput(behaviorContent);
      expect(result.allowed).toBe(true);
    });

    it('should process special education SEL lesson observations', async () => {
      const selContent = `
        SEL lesson observation for behavior special education:
        - Teacher using "size of the problem" poster
        - Student practicing problem-solving after incident in general ed classroom
        - Discussion about appropriate vs inappropriate responses
        - Student reflecting on why they made certain choices
        - Teacher explaining snowball effect of not problem-solving in the moment
      `;

      const result = await service.evaluateInput(selContent);
      expect(result.allowed).toBe(true);
    });

    it('should process classroom management discussions', async () => {
      const classroomMgmtContent = `
        Classroom management strategies observed:
        - Token economy system (tickets for positive behavior)
        - Consequences for not showing expected behavior
        - Student reflection time for behavioral incidents
        - Teacher reminders about expectations
        - Discussion about intrinsic vs extrinsic motivation
      `;

      const result = await service.evaluateInput(classroomMgmtContent);
      expect(result.allowed).toBe(true);
    });
  });
});
