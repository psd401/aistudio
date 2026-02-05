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

  /**
   * Production False Positive Test Cases (Issues #727, #742)
   *
   * Issue #727: 4 of 5 violations were false positives (80%) on first deployment day.
   * Issue #742: 6+ additional false positives on 2026-02-04 — staff educational content
   * about student behavior (PBIS, anti-bullying, behavioral health) being classified as
   * Bullying/Self-Harm/Violence/Weapons. 3 of 4 original violations were OUTPUT blocks.
   *
   * Filter changes:
   * - Issue #727: PROMPT_ATTACK: LOW → NONE (75% false positive rate)
   * - Issue #727: Self-Harm topic: definition simplified
   * - Issue #742: All topics: BLOCK → NONE (detect-only mode)
   * - Issue #742: Bullying topic: definition narrowed
   *
   * IMPORTANT - Test Coverage Limitations:
   * These tests use mocked AWS clients and validate graceful degradation
   * (service behavior when AWS is unavailable), NOT actual guardrail filtering.
   * To verify actual Bedrock Guardrails behavior, you must:
   *
   * 1. Deploy to dev environment: `cd infra && npx cdk deploy AIStudio-GuardrailsStack-Dev`
   * 2. Manually test with the content below (see manual test checklist in PR description)
   * 3. Monitor CloudWatch logs for 48 hours post-deployment
   * 4. Use CloudWatch Logs Insights queries to validate:
   *
   *    -- Blocked content (should be zero for topics now)
   *    fields @timestamp, requestId, source, blockedCategories, action
   *    | filter module = "BedrockGuardrailsService"
   *    | filter action = "blocked"
   *    | stats count() by source, blockedCategories
   *    | sort count desc
   *
   *    -- Detected topics (detect-only mode logging)
   *    fields @timestamp, detectedTopics, source, contentLength
   *    | filter module = "BedrockGuardrailsService"
   *    | filter detectedTopics is not empty
   *    | stats count() by detectedTopics
   *    | sort count desc
   *
   * Integration tests against real Bedrock API are expensive/slow and not
   * included in the CI pipeline. Production validation is the primary verification.
   */
  describe('production false positives (Issues #727, #742)', () => {
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

        RESPONSE FORMAT:
        - Start with a brief summary
        - Include bill status and timeline
        - Analyze impact on districts
        - Provide actionable recommendations for district leadership

        You must always cite specific bill numbers and sections when referencing legislation.
        Do not speculate about legislative outcomes. Base analysis on published committee reports.
      `;

      const result = await service.evaluateInput(architectPrompt);
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe(architectPrompt);
    });
  });

  /**
   * Production False Positive Test Cases (Issue #742)
   *
   * These tests document false positives observed on 2026-02-04 where staff
   * educational content was being classified as Bullying/Self-Harm/Violence/Weapons.
   *
   * Key observations from #742:
   * - 3 of 4 violations were OUTPUT blocks (AI responses about educational topics)
   * - Self-Harm input was 54K chars (large document attachment through model-compare)
   * - Two violations from same user session working on behavior/safety content
   * - One session had 4 successful checks before 5th response triggered Bullying
   * - Two more violations triggered Violence + Bullying + Weapons simultaneously
   */
  describe('production false positives (Issue #742)', () => {
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

        Intervention Protocol:
        1. Document the incident using behavior referral form
        2. Notify parents/guardians of both parties
        3. Implement safety plan for targeted student
        4. Assign consequences per student handbook
        5. Follow up with counseling referral if needed
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
        - Parent reports difficulty sleeping and changes in appetite

        Risk Assessment (Columbia Protocol):
        - Passive ideation reported, no active plan
        - Protective factors: supportive family, engaged in sports
        - Previous counseling history: none

        Support Plan:
        1. Weekly check-ins with school counselor
        2. Safety plan developed with student and family
        3. Referral to community mental health provider
        4. 504 accommodations for reduced workload during crisis period
        5. Teacher notification of support plan (without clinical details)
        6. Re-assessment in 2 weeks

        Crisis Resources Provided to Family:
        - 988 Suicide & Crisis Lifeline
        - Crisis Text Line: Text HOME to 741741
        - Local crisis center contact information
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

        Context:
        - Student wrote a creative fiction piece involving conflict and confrontation
        - Teacher flagged per mandatory reporting procedures
        - Student has no prior behavioral concerns or disciplinary history

        Assessment Findings:
        - No specific threat identified toward any individual or group
        - Content consistent with age-appropriate creative writing themes
        - Student demonstrated understanding of fiction vs. reality in interview
        - No access to weapons confirmed through parent interview

        Recommendations:
        - No disciplinary action warranted
        - Continue monitoring through regular check-ins
        - Provide guidance on school writing assignment expectations
        - Document in student file per district records retention policy
      `;

      const result = await service.evaluateInput(safetyContent);
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe(safetyContent);
    });

    it('should process AI-generated anti-bullying response (OUTPUT false positive)', async () => {
      const aiResponse = `
        Here's a comprehensive overview of evidence-based anti-bullying strategies for your school:

        **Understanding Bullying Dynamics:**
        Research shows that bullying involves a power imbalance between the person doing the
        bullying and the target. It can manifest as physical aggression, verbal harassment,
        social exclusion, or cyberbullying through digital platforms.

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
        5. Follow the harassment, intimidation, and bullying (HIB) investigation timeline
        6. Communicate findings to families within 2 school days
      `;

      const result = await service.evaluateOutput(aiResponse, 'claude-haiku-4.5', 'amazon-bedrock');
      expect(result.allowed).toBe(true);
      expect(result.processedContent).toBe(aiResponse);
    });
  });
});
