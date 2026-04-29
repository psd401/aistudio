/**
 * Tests for BedrockGuardrailsService
 *
 * Focuses on core functionality and error handling.
 */

import { BedrockGuardrailsService } from '../bedrock-guardrails-service';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { SNSClient } from '@aws-sdk/client-sns';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-bedrock-runtime');
jest.mock('@aws-sdk/client-sns');

const TEST_REGION = 'us-west-2';

/**
 * Helper: create a service with standard test config
 */
function createTestService(overrides?: Partial<{ region: string; guardrailId: string; guardrailVersion: string; violationTopicArn: string; enableViolationNotifications: boolean }>): BedrockGuardrailsService {
  return new BedrockGuardrailsService({
    region: TEST_REGION,
    guardrailId: 'test-guardrail-id',
    guardrailVersion: 'DRAFT',
    ...overrides,
  });
}

/**
 * Helper: mock BedrockRuntimeClient.send to return a given response
 */
function mockBedrockResponse(response: Record<string, unknown>): jest.Mock {
  const mockSend = jest.fn().mockResolvedValue(response);
  (BedrockRuntimeClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));
  return mockSend;
}

/**
 * Helper: mock SNSClient.send and return the mock for assertions
 */
function mockSnsClient(): jest.Mock {
  const mockSend = jest.fn().mockResolvedValue({});
  (SNSClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));
  return mockSend;
}

describe('BedrockGuardrailsService - core', () => {
  let service: BedrockGuardrailsService;

  beforeEach(() => {
    service = createTestService();
  });

  describe('isEnabled', () => {
    it('should return true when guardrail ID is configured', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when guardrail ID is not configured', () => {
      const disabledService = createTestService({ guardrailId: '' });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('evaluateInput', () => {
    it('should pass through content when guardrails disabled', async () => {
      const disabledService = createTestService({ guardrailId: '' });
      const result = await disabledService.evaluateInput('test content');
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });

    it('should handle errors gracefully and allow content', async () => {
      const result = await service.evaluateInput('test content');
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });
  });

  describe('evaluateOutput', () => {
    it('should pass through content when guardrails disabled', async () => {
      const disabledService = createTestService({ guardrailId: '' });
      const result = await disabledService.evaluateOutput('test content', 'gpt-4', 'openai');
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe('test content');
    });

    it('should handle errors gracefully and allow content', async () => {
      const result = await service.evaluateOutput('test content', 'gpt-4', 'openai');
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
      expect(config).not.toHaveProperty('violationTopicArn');
    });
  });

  describe('edge cases', () => {
    it('should disable service when region not configured (local dev mode)', () => {
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

      const localService = new BedrockGuardrailsService({ guardrailId: 'test-guardrail' });
      expect(localService.isEnabled()).toBe(false);

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
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe(longContent);
    });
  });
});

/**
 * Educational Content Test Cases (Issue #639)
 *
 * These tests document the types of legitimate educational content that should
 * be allowed through the guardrails. They use mocked clients so they test
 * graceful degradation rather than actual filter behavior.
 */
describe('BedrockGuardrailsService - educational content (Issue #639)', () => {
  let service: BedrockGuardrailsService;

  beforeEach(() => {
    service = createTestService();
  });

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

/**
 * Production False Positive Test Cases (Issues #727, #742)
 *
 * IMPORTANT - Test Coverage Limitations:
 * These tests use mocked AWS clients and validate graceful degradation
 * (service behavior when AWS is unavailable), NOT actual guardrail filtering.
 * Integration tests against real Bedrock API are expensive/slow and not
 * included in the CI pipeline. Production validation is the primary verification.
 */
describe('BedrockGuardrailsService - false positives Issue #727', () => {
  let service: BedrockGuardrailsService;

  beforeEach(() => {
    service = createTestService();
  });

  it('should process PBIS "hands to self" behavior tracking content', async () => {
    const pbisContent = `
      PBIS Behavior Expectations Tracking:
      - Student reminded to keep hands to self during morning meeting
      - Practiced safe body expectations in the hallway
      - Self-monitoring checklist: Did I keep hands and feet to myself?
      - Self-regulation strategy: Take 3 deep breaths before reacting
      - Goal: Student will demonstrate safe body 4 out of 5 transitions
      - SEL lesson on self-advocacy: asking for help instead of acting out
    `;
    const result = await service.evaluateInput(pbisContent);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(pbisContent);
  });

  it('should process role-based prompting with Danielson rubrics', async () => {
    const roleBasedPrompt = `
      As an expert, veteran principal in the state of Washington with deep knowledge
      of the 2022 Danielson Framework for Teaching, please analyze the following
      classroom observation notes. Code each piece of evidence to the appropriate
      criterion and component. Provide specific ratings (Distinguished, Proficient,
      Basic, or Unsatisfied) with justification for each.

      Focus on:
      - Criterion 1: Centering instruction on high expectations for student achievement
      - Criterion 2: Demonstrating effective teaching practices
      - Criterion 3: Recognizing individual student learning needs

      Observation notes:
      Teacher used differentiated instruction with three small groups.
      Students were engaged in collaborative problem-solving.
      Teacher circulated and provided targeted feedback.
    `;
    const result = await service.evaluateInput(roleBasedPrompt);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(roleBasedPrompt);
  });

  it('should process Assistant Architect system prompts with detailed instructions', async () => {
    const architectPrompt = `
      You are the WA School Legislation Radar assistant for Peninsula School District.
      Your role is to monitor and analyze Washington State education legislation.

      INSTRUCTIONS:
      1. When a user asks about a bill, provide the bill number, title, sponsors, and current status.
      2. Analyze the potential impact on K-12 education in Washington State.
      3. Flag any bills that could affect school district funding, curriculum requirements,
         or student privacy.
      4. Provide balanced, non-partisan analysis of legislative proposals.
      5. Cross-reference with existing RCW and WAC regulations.
      6. Summarize committee hearing testimony when available.

      You must always cite specific bill numbers and sections when referencing legislation.
      Do not speculate about legislative outcomes. Base analysis on published committee reports.
    `;
    const result = await service.evaluateInput(architectPrompt);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(architectPrompt);
  });
});

describe('BedrockGuardrailsService - false positives Issue #742', () => {
  let service: BedrockGuardrailsService;

  beforeEach(() => {
    service = createTestService();
  });

  it('should process anti-bullying program content (Bullying false positive)', async () => {
    const antiBullyingContent = `
      Anti-Bullying Prevention Program Overview:
      Our school implements a comprehensive anti-bullying framework based on PBIS Tier 2 supports.

      Definition of Bullying (per RCW 28A.600.477):
      Bullying means any intentional electronic, written, verbal, or physical act that
      physically harms a student, damages property, substantially interferes with education,
      threatens the overall educational process, or places a person in reasonable fear of harm.

      Prevention Strategies:
      - Classroom lessons on identifying bullying behavior
      - Bystander intervention training for students
      - Restorative justice circles for conflict resolution
      - Anonymous reporting system for students to report harassment
      - Staff training on recognizing signs of bullying and cyberbullying
    `;
    const result = await service.evaluateInput(antiBullyingContent);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(antiBullyingContent);
  });

  it('should process student behavioral health documentation (Self-Harm false positive)', async () => {
    const behavioralHealthContent = `
      Student Support Team Meeting Notes - Confidential

      Presenting Concerns:
      - Student expressing feelings of hopelessness and isolation
      - Decline in academic performance over past 3 weeks
      - Social withdrawal from peer group activities

      Risk Assessment (Columbia Protocol):
      - Passive ideation reported, no active plan
      - Protective factors: supportive family, engaged in sports

      Support Plan:
      1. Weekly check-ins with school counselor
      2. Safety plan developed with student and family
      3. Referral to community mental health provider
      4. 504 accommodations for reduced workload during crisis period
      5. Re-assessment in 2 weeks
    `;
    const result = await service.evaluateInput(behavioralHealthContent);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(behavioralHealthContent);
  });

  it('should process school safety/discipline content (Violence+Bullying+Weapons false positive)', async () => {
    const safetyContent = `
      School Safety Assessment Report

      Threat Assessment Team Review:
      Following district protocol (per OSPI guidelines), the threat assessment team convened
      to evaluate a reported concern about a student's written assignment.

      Assessment Findings:
      - No specific threat identified toward any individual or group
      - Content consistent with age-appropriate creative writing themes
      - Student demonstrated understanding of fiction vs. reality in interview
      - No access to weapons confirmed through parent interview

      Recommendations:
      - No disciplinary action warranted
      - Continue monitoring through regular check-ins
    `;
    const result = await service.evaluateInput(safetyContent);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(safetyContent);
  });

  it('should process AI-generated anti-bullying response (OUTPUT false positive)', async () => {
    const aiResponse = `
      Here's an overview of evidence-based anti-bullying strategies for your school:

      **PBIS Framework for Bullying Prevention:**
      - Tier 1 (Universal): School-wide expectations, classroom lessons on respect
      - Tier 2 (Targeted): Social skills groups, Check-In/Check-Out for at-risk students
      - Tier 3 (Intensive): Individual behavior plans, wraparound services

      **Staff Response Protocol:**
      When a bullying incident is reported:
      1. Ensure immediate safety of the targeted student
      2. Separate involved parties
      3. Interview witnesses independently
      4. Document using the district's behavioral incident form
      5. Follow the HIB investigation timeline
      6. Communicate findings to families within 2 school days
    `;
    const result = await service.evaluateOutput(aiResponse, 'claude-haiku-4.5', 'amazon-bedrock');
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(aiResponse);
  });
});

/**
 * Issue #763: managedWordLists BLOCKED path
 *
 * Regression test for the bug where PROFANITY blocks were invisible in logs/notifications
 * because extractBlockedCategories() only checked wordPolicy.customWords, not managedWordLists.
 */
describe('BedrockGuardrailsService - managedWordLists blocking (Issue #763)', () => {
  it('should return allowed=false and blockedCategories with Profanity filter when managedWordLists is BLOCKED', async () => {
    mockBedrockResponse({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'Your request was blocked.' }],
      assessments: [{
        wordPolicy: {
          managedWordLists: [
            { match: 'redacted', type: 'PROFANITY', action: 'BLOCKED' },
          ],
        },
      }],
    });

    const blockedService = createTestService();
    const result = await blockedService.evaluateInput('test content with profanity');

    expect(result.allowed).toBe(false);
    expect(result.blockedCategories).toBeDefined();
    expect(result.blockedCategories?.some(c => c.includes('Profanity filter'))).toBe(true);
  });
});

/**
 * Issue #929: Detect-only detections must NOT trigger SNS notifications
 *
 * Previously, detect-only topics and filters each triggered individual
 * sendViolationNotification calls for both input and output evaluations,
 * resulting in up to 4 SNS publishes per user message. This flooded the
 * email notification channel with non-actionable telemetry.
 *
 * Detection data is still logged to CloudWatch via evaluateContent().
 * SNS notifications are reserved for actual blocks only.
 */
describe('BedrockGuardrailsService - detect-only SNS suppression (Issue #929)', () => {
  let mockBedrockSend: jest.Mock;
  let mockSnsSend: jest.Mock;

  beforeEach(() => {
    mockBedrockSend = mockBedrockResponse({
      action: 'NONE',
      assessments: [{
        topicPolicy: {
          topics: [
            { name: 'Weapons', type: 'DENY', action: 'NONE' },
            { name: 'Bullying', type: 'DENY', action: 'NONE' },
          ],
        },
        contentPolicy: {
          filters: [
            { type: 'HATE', confidence: 'LOW', action: 'NONE' },
            { type: 'VIOLENCE', confidence: 'MEDIUM', action: 'NONE' },
          ],
        },
      }],
    });

    mockSnsSend = mockSnsClient();
  });

  it('should NOT send SNS notification for detect-only topics on input', async () => {
    const detectService = createTestService({
      violationTopicArn: 'arn:aws:sns:us-west-2:123456789:test-topic',
      enableViolationNotifications: true,
    });

    const result = await detectService.evaluateInput('chemistry content about polyatomic ions');
    expect(result.allowed).toBe(true);
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it('should NOT send SNS notification for detect-only topics on output', async () => {
    const detectService = createTestService({
      violationTopicArn: 'arn:aws:sns:us-west-2:123456789:test-topic',
      enableViolationNotifications: true,
    });

    const result = await detectService.evaluateOutput(
      'educational response about conflict resolution',
      'claude-haiku-4.5',
      'amazon-bedrock'
    );
    expect(result.allowed).toBe(true);
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it('should still send SNS notification for actual blocks', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'Content blocked.' }],
      assessments: [{
        contentPolicy: {
          filters: [
            { type: 'HATE', confidence: 'HIGH', action: 'BLOCKED' },
          ],
        },
      }],
    });

    const detectService = createTestService({
      violationTopicArn: 'arn:aws:sns:us-west-2:123456789:test-topic',
      enableViolationNotifications: true,
    });

    const result = await detectService.evaluateInput('genuinely hateful content');
    expect(result.allowed).toBe(false);
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue #929: Chemistry education false positive regression test
 *
 * Teacher's legitimate chemistry content (polyatomic ion naming mnemonics with
 * words like "guillotine", "gangs", "marriage") was blocked by HATE at LOW.
 * This is the 3rd confirmed false positive on HATE at LOW (100% cumulative FP rate).
 */
describe('BedrockGuardrailsService - chemistry education content (Issue #929)', () => {
  it('should process chemistry mnemonics containing words like guillotine, gangs, marriage', async () => {
    const service = createTestService();
    const chemistryContent = `
      Chemistry Naming Mnemonics for Polyatomic Ions:

      To remember the naming conventions for polyatomic ions, use these memory aids:
      - "Guillotine" - the suffix "-ine" helps remember chlorine-family naming
      - "Gangs" - group naming patterns for ion families
      - "Marriage" - how ions "pair up" in compound formation
      - "Nick the Camel" - mnemonic for nitrate, carbonate, etc.

      Practice: Name the following polyatomic ions:
      1. NO3- (nitrate)
      2. SO4 2- (sulfate)
      3. PO4 3- (phosphate)
      4. CO3 2- (carbonate)

      Remember: -ate suffix means more oxygen atoms, -ite means fewer.
      The "gangs" of similar ions follow predictable patterns.
    `;
    const result = await service.evaluateInput(chemistryContent);
    expect(result.allowed).toBe(true);
    expect(result.processedContent).toBe(chemistryContent);
  });
});
