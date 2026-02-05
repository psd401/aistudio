/**
 * Amazon Bedrock Guardrails Service
 *
 * Provides comprehensive content safety filtering for K-12 AI interactions.
 * Uses AWS Bedrock Guardrails API for universal content filtering across all AI providers.
 *
 * Features:
 * - Content safety filtering (hate, violence, self-harm, sexual, misconduct, prompt attacks)
 * - Input and output evaluation
 * - SNS notifications for violations
 * - Graceful degradation when service unavailable
 */

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
  type ApplyGuardrailCommandInput,
  type GuardrailAssessment as SDKGuardrailAssessment,
} from '@aws-sdk/client-bedrock-runtime';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { createLogger, generateRequestId } from '@/lib/logger';
import { createHmac } from 'node:crypto';
import type {
  SafetyCheckResult,
  GuardrailCheckResult,
  GuardrailViolation,
  GuardrailsConfig,
  ContentFilterType,
} from './types';

/**
 * BedrockGuardrailsService - Content safety filtering for K-12 environments
 *
 * Integration Points:
 * - Called by UnifiedStreamingService before AI requests (input filtering)
 * - Called by UnifiedStreamingService after AI responses (output filtering)
 * - Sends violation notifications via SNS for administrator alerts
 */
export class BedrockGuardrailsService {
  private bedrockClient: BedrockRuntimeClient;
  private snsClient: SNSClient;
  private config: GuardrailsConfig;
  private log = createLogger({ module: 'BedrockGuardrailsService' });

  constructor(config?: Partial<GuardrailsConfig>) {
    const region = config?.region || process.env.AWS_REGION;

    // Graceful degradation for local development - disable if no region
    // In production (ECS/Lambda), AWS_REGION is always set
    if (!region) {
      this.log.warn('AWS_REGION not configured - BedrockGuardrailsService disabled (local development mode)');
      // Initialize with dummy region for client instantiation (won't be used)
      this.bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
      this.snsClient = new SNSClient({ region: 'us-east-1' });
      this.config = {
        region: '',
        guardrailId: '', // Empty guardrailId disables the service
        guardrailVersion: 'DRAFT',
        enableViolationNotifications: false,
        enablePiiTokenization: false,
        tokenTtlSeconds: 3600,
      };
      return;
    }

    this.bedrockClient = new BedrockRuntimeClient({ region });
    this.snsClient = new SNSClient({ region });

    this.config = {
      region,
      guardrailId: config?.guardrailId || process.env.BEDROCK_GUARDRAIL_ID || '',
      guardrailVersion: config?.guardrailVersion || process.env.BEDROCK_GUARDRAIL_VERSION || 'DRAFT',
      violationTopicArn: config?.violationTopicArn || process.env.GUARDRAIL_VIOLATION_TOPIC_ARN,
      enableViolationNotifications: config?.enableViolationNotifications ?? true,
      enablePiiTokenization: config?.enablePiiTokenization ?? true,
      tokenTtlSeconds: config?.tokenTtlSeconds ?? 3600, // 1 hour default
    };

    // Validate required configuration
    if (!this.config.guardrailId) {
      this.log.warn('Bedrock Guardrail ID not configured - content safety filtering disabled');
    }

    // Issue #727: Validate GUARDRAIL_HASH_SECRET is set for privacy protection
    if (!process.env.GUARDRAIL_HASH_SECRET && !config?.hashSecret) {
      this.log.warn('GUARDRAIL_HASH_SECRET not configured - using default secret for session ID hashing (weakens privacy protection)');
    }
  }

  /**
   * Check if guardrails service is properly configured and available
   */
  isEnabled(): boolean {
    return !!this.config.guardrailId;
  }

  /**
   * Evaluate user input content for safety violations
   *
   * @param content - User message content to evaluate
   * @param sessionId - Session identifier for context
   * @returns Safety check result with processed content or block message
   */
  async evaluateInput(
    content: string,
    sessionId?: string
  ): Promise<SafetyCheckResult> {
    if (!this.isEnabled()) {
      // Guardrails disabled - pass through content unchanged
      return {
        allowed: true,
        processedContent: content,
      };
    }

    const requestId = generateRequestId();

    // Issue #727: Monitor for suspicious patterns even when PROMPT_ATTACK filter is disabled
    // This provides visibility into potential injection attempts without blocking legitimate content
    const suspiciousPatterns = this.detectSuspiciousPatterns(content);
    if (suspiciousPatterns.length > 0) {
      this.log.warn('Suspicious prompt patterns detected (allowed due to disabled PROMPT_ATTACK filter)', {
        requestId,
        sessionId,
        patterns: suspiciousPatterns,
        contentLength: content.length,
        contentPreview: content.substring(0, 200),
      });
    }

    this.log.info('Evaluating input content', {
      requestId,
      contentLength: content.length,
      sessionId,
    });

    try {
      const result = await this.evaluateContent(content, 'INPUT');

      if (result.blocked) {
        // Send violation notification
        await this.sendViolationNotification({
          violationId: requestId,
          userIdHash: this.hashValue(sessionId || 'anonymous'),
          timestamp: new Date().toISOString(),
          source: 'input',
          categories: result.blockedCategories || [],
          modelId: 'pre-check',
          provider: 'user-input',
          action: 'blocked',
          sessionId,
        });

        return {
          allowed: false,
          processedContent: content,
          blockedReason: result.reason,
          blockedMessage: result.blockedMessage ||
            'This content is not appropriate for educational use. Please rephrase your question.',
          blockedCategories: result.blockedCategories,
        };
      }

      // Issue #742: Send detection notification for topics in detect-only mode
      if (result.detectedTopics && result.detectedTopics.length > 0) {
        await this.sendViolationNotification({
          violationId: requestId,
          userIdHash: this.hashValue(sessionId || 'anonymous'),
          timestamp: new Date().toISOString(),
          source: 'input',
          categories: result.detectedTopics,
          modelId: 'pre-check',
          provider: 'user-input',
          action: 'detected',
          sessionId,
        });
      }

      // Issue #761: Send detection notification for content filters in detect-only mode
      if (result.detectedFilters && result.detectedFilters.length > 0) {
        await this.sendViolationNotification({
          violationId: requestId,
          userIdHash: this.hashValue(sessionId || 'anonymous'),
          timestamp: new Date().toISOString(),
          source: 'input',
          categories: result.detectedFilters,
          modelId: 'pre-check',
          provider: 'user-input',
          action: 'detected',
          sessionId,
        });
      }

      this.log.info('Input content passed safety check', {
        requestId,
        contentLength: content.length,
        detectedTopics: result.detectedTopics,
        detectedFilters: result.detectedFilters,
      });

      return {
        allowed: true,
        processedContent: content,
      };
    } catch (error) {
      this.log.error('Guardrails evaluation failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Graceful degradation - allow content if guardrails unavailable
      // This ensures service continuity while logging the issue
      return {
        allowed: true,
        processedContent: content,
      };
    }
  }

  /**
   * Evaluate AI output content for safety violations
   *
   * @param content - AI response content to evaluate
   * @param modelId - Model that generated the response
   * @param provider - AI provider used
   * @param sessionId - Session identifier for context
   * @returns Safety check result with processed content or block message
   */
  async evaluateOutput(
    content: string,
    modelId: string,
    provider: string,
    sessionId?: string
  ): Promise<SafetyCheckResult> {
    if (!this.isEnabled()) {
      // Guardrails disabled - pass through content unchanged
      return {
        allowed: true,
        processedContent: content,
      };
    }

    const requestId = generateRequestId();
    this.log.info('Evaluating output content', {
      requestId,
      contentLength: content.length,
      modelId,
      provider,
      sessionId,
    });

    try {
      const result = await this.evaluateContent(content, 'OUTPUT');

      if (result.blocked) {
        // Send violation notification
        await this.sendViolationNotification({
          violationId: requestId,
          userIdHash: this.hashValue(sessionId || 'anonymous'),
          timestamp: new Date().toISOString(),
          source: 'output',
          categories: result.blockedCategories || [],
          modelId,
          provider,
          action: 'blocked',
          sessionId,
        });

        return {
          allowed: false,
          processedContent: content,
          blockedReason: result.reason,
          blockedMessage: result.blockedMessage ||
            'The AI response contained inappropriate content and has been blocked for your safety.',
          blockedCategories: result.blockedCategories,
        };
      }

      // Issue #742: Send detection notification for topics in detect-only mode
      if (result.detectedTopics && result.detectedTopics.length > 0) {
        await this.sendViolationNotification({
          violationId: requestId,
          userIdHash: this.hashValue(sessionId || 'anonymous'),
          timestamp: new Date().toISOString(),
          source: 'output',
          categories: result.detectedTopics,
          modelId,
          provider,
          action: 'detected',
          sessionId,
        });
      }

      // Issue #761: Send detection notification for content filters in detect-only mode
      if (result.detectedFilters && result.detectedFilters.length > 0) {
        await this.sendViolationNotification({
          violationId: requestId,
          userIdHash: this.hashValue(sessionId || 'anonymous'),
          timestamp: new Date().toISOString(),
          source: 'output',
          categories: result.detectedFilters,
          modelId,
          provider,
          action: 'detected',
          sessionId,
        });
      }

      this.log.info('Output content passed safety check', {
        requestId,
        contentLength: content.length,
        modelId,
        provider,
        detectedTopics: result.detectedTopics,
        detectedFilters: result.detectedFilters,
      });

      return {
        allowed: true,
        processedContent: content,
      };
    } catch (error) {
      this.log.error('Guardrails output evaluation failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        modelId,
        provider,
      });

      // Graceful degradation - allow content if guardrails unavailable
      return {
        allowed: true,
        processedContent: content,
      };
    }
  }

  /**
   * Core content evaluation using Bedrock Guardrails API
   */
  private async evaluateContent(
    content: string,
    source: 'INPUT' | 'OUTPUT'
  ): Promise<GuardrailCheckResult> {
    const input: ApplyGuardrailCommandInput = {
      guardrailIdentifier: this.config.guardrailId,
      guardrailVersion: this.config.guardrailVersion,
      source,
      content: [
        {
          text: {
            text: content,
          },
        },
      ],
    };

    const command = new ApplyGuardrailCommand(input);
    const response = await this.bedrockClient.send(command);

    // Issue #742: Extract detected-but-not-blocked topics from assessments.
    // When topics use inputAction/outputAction: 'NONE' (detect-only mode),
    // the overall response.action will NOT be 'GUARDRAIL_INTERVENED' for those
    // topics, but the assessment trace still contains detection information.
    const assessment = response.assessments?.[0];
    const detectedTopics = this.extractDetectedTopics(assessment);
    if (detectedTopics.length > 0) {
      this.log.info('Topics detected in detect-only mode (not blocked)', {
        source,
        detectedTopics,
        contentLength: content.length,
      });
    }

    // Issue #761: Extract detected-but-not-blocked content filters from assessments.
    // When content filters use inputStrength/outputStrength: 'NONE' (detect-only mode),
    // the overall response.action will NOT be 'GUARDRAIL_INTERVENED' for those
    // filters, but the assessment trace still contains detection information.
    const detectedFilters = this.extractDetectedFilters(assessment);
    if (detectedFilters.length > 0) {
      this.log.info('Content filters detected in detect-only mode (not blocked)', {
        source,
        detectedFilters,
        contentLength: content.length,
      });
    }

    if (response.action === 'GUARDRAIL_INTERVENED') {
      const blockedCategories = this.extractBlockedCategories(assessment);
      const blockedMessage = response.outputs?.[0]?.text;

      this.log.warn('Guardrail intervened', {
        source,
        blockedCategories,
        hasBlockedMessage: !!blockedMessage,
      });

      return {
        blocked: true,
        reason: blockedCategories.join(', ') || 'Content policy violation',
        blockedMessage,
        blockedCategories,
      };
    }

    return {
      blocked: false,
      detectedTopics: detectedTopics.length > 0 ? detectedTopics : undefined,
      detectedFilters: detectedFilters.length > 0 ? detectedFilters : undefined,
    };
  }

  /**
   * Extract blocked category names from guardrail assessment
   */
  private extractBlockedCategories(assessment?: SDKGuardrailAssessment): string[] {
    const categories: string[] = [];

    // Content policy filters (hate, violence, etc.)
    if (assessment?.contentPolicy?.filters) {
      for (const filter of assessment.contentPolicy.filters) {
        if (filter.action === 'BLOCKED' && filter.type) {
          categories.push(this.formatCategoryName(filter.type as ContentFilterType));
        }
      }
    }

    // Topic policy
    if (assessment?.topicPolicy?.topics) {
      for (const topic of assessment.topicPolicy.topics) {
        if (topic.action === 'BLOCKED' && topic.name) {
          categories.push(topic.name);
        }
      }
    }

    // Word policy
    if (assessment?.wordPolicy?.customWords) {
      for (const word of assessment.wordPolicy.customWords) {
        if (word.action === 'BLOCKED') {
          categories.push('Blocked word detected');
          break; // Only add once
        }
      }
    }

    return categories;
  }

  /**
   * Extract topic names that were detected but not blocked (detect-only mode)
   *
   * Issue #742: When topics use inputAction/outputAction: 'NONE', Bedrock still
   * evaluates content against topic definitions and returns detection information
   * in the assessment. The topic action will be 'NONE' instead of 'BLOCKED'.
   * We extract these for logging and monitoring to learn what triggers false positives.
   */
  private extractDetectedTopics(assessment?: SDKGuardrailAssessment): string[] {
    const detected: string[] = [];

    if (assessment?.topicPolicy?.topics) {
      for (const topic of assessment.topicPolicy.topics) {
        // Topics in detect-only mode have action 'NONE' instead of 'BLOCKED'
        if (topic.action === 'NONE' && topic.name) {
          detected.push(topic.name);
        }
      }
    }

    return detected;
  }

  /**
   * Extract content filter types that were detected but not blocked (detect-only mode)
   *
   * Issue #761: When content filters use inputStrength/outputStrength: 'NONE', Bedrock
   * still evaluates content and returns detection information in the assessment.
   * The filter action will be 'NONE' instead of 'BLOCKED'.
   * We extract these for logging and monitoring to learn what triggers false positives.
   */
  private extractDetectedFilters(assessment?: SDKGuardrailAssessment): string[] {
    const detected: string[] = [];

    if (assessment?.contentPolicy?.filters) {
      for (const filter of assessment.contentPolicy.filters) {
        // Filters in detect-only mode have action 'NONE' instead of 'BLOCKED'
        // We also check that confidence exists to confirm it was actually triggered
        if (filter.action === 'NONE' && filter.type && filter.confidence) {
          detected.push(this.formatCategoryName(filter.type as ContentFilterType));
        }
      }
    }

    return detected;
  }

  /**
   * Detect potentially malicious prompt injection patterns
   *
   * Issue #727: With PROMPT_ATTACK filter disabled (inputStrength: NONE), we monitor
   * for suspicious patterns to maintain visibility into potential attacks without blocking
   * legitimate educational content. LLM safety training still prevents actual exploitation.
   *
   * @param content - User input content to analyze
   * @returns Array of detected pattern types (empty if none found)
   */
  private detectSuspiciousPatterns(content: string): string[] {
    const patterns: string[] = [];
    const lowerContent = content.toLowerCase();

    // System instruction override attempts
    if (lowerContent.includes('system instruction') ||
        lowerContent.includes('system prompt') ||
        lowerContent.includes('system message') ||
        lowerContent.includes('ignore previous') ||
        lowerContent.includes('ignore all previous') ||
        lowerContent.includes('disregard previous') ||
        lowerContent.includes('forget everything')) {
      patterns.push('system_override_attempt');
    }

    // Role manipulation attempts
    const roleManipulationPatterns = [
      /you\s+are\s+now\s+(?:a|an|the)/iu,
      /act\s+as\s+(?:if|though)\s+you\s+(?:are|were)/iu,
      /pretend\s+(?:to\s+be|you\s+are)/iu,
      /simulate\s+(?:being|a)/iu,
    ];
    // Exclude legitimate educational role-playing (context: Danielson observations, teacher evaluation)
    const isLegitimateRolePlaying = /principal|teacher|administrator|superintendent|danielson|evaluation|observation/iu.test(content);
    if (!isLegitimateRolePlaying && roleManipulationPatterns.some(pattern => pattern.test(content))) {
      patterns.push('role_manipulation');
    }

    // Data extraction attempts
    if (lowerContent.includes('show me your prompt') ||
        lowerContent.includes('what are your instructions') ||
        lowerContent.includes('reveal your system prompt') ||
        lowerContent.includes('output your configuration')) {
      patterns.push('data_extraction_attempt');
    }

    // Delimiter/encoding bypass attempts
    if ((/[<>]{3,}/u.test(content) && /<\/?system>/iu.test(content)) ||
        content.includes('[INST]') ||
        /\{\{\{\s*system/iu.test(content)) {
      patterns.push('delimiter_bypass');
    }

    // Jailbreak/DAN patterns
    if (/do\s+anything\s+now|dan\s+mode|developer\s+mode/iu.test(content)) {
      patterns.push('jailbreak_attempt');
    }

    return patterns;
  }

  /**
   * Format category type for user-friendly display
   */
  private formatCategoryName(type: ContentFilterType): string {
    const categoryNames: Record<ContentFilterType, string> = {
      HATE: 'Hate speech',
      VIOLENCE: 'Violence',
      SELF_HARM: 'Self-harm',
      SEXUAL: 'Sexual content',
      MISCONDUCT: 'Misconduct',
      PROMPT_ATTACK: 'Prompt attack',
    };
    return categoryNames[type] || type;
  }

  /**
   * Send violation notification via SNS
   */
  private async sendViolationNotification(
    violation: GuardrailViolation
  ): Promise<void> {
    if (!this.config.enableViolationNotifications || !this.config.violationTopicArn) {
      this.log.debug('Violation notifications disabled or topic not configured');
      return;
    }

    try {
      const message = {
        timestamp: violation.timestamp,
        violationId: violation.violationId,
        source: violation.source,
        categories: violation.categories,
        action: violation.action,
        modelId: violation.modelId,
        provider: violation.provider,
        // Note: userIdHash is a hash, not actual user ID for privacy
        userIdHash: violation.userIdHash,
      };

      const command = new PublishCommand({
        TopicArn: this.config.violationTopicArn,
        Subject: `K-12 Content Safety Alert: ${violation.categories.join(', ')}`,
        Message: JSON.stringify(message, null, 2),
        MessageAttributes: {
          violationType: {
            DataType: 'String',
            StringValue: violation.source,
          },
          action: {
            DataType: 'String',
            StringValue: violation.action,
          },
        },
      });

      await this.snsClient.send(command);

      this.log.info('Violation notification sent', {
        violationId: violation.violationId,
        categories: violation.categories,
      });
    } catch (error) {
      this.log.error('Failed to send violation notification', {
        violationId: violation.violationId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - notification failure shouldn't block the response
    }
  }

  /**
   * Hash a value for privacy (e.g., user ID) using HMAC-SHA256
   *
   * Uses a secret key to prevent rainbow table attacks on predictable values
   * like session IDs. The secret should be set via GUARDRAIL_HASH_SECRET env var.
   */
  private hashValue(value: string): string {
    const secret = process.env.GUARDRAIL_HASH_SECRET || this.config.hashSecret || 'aistudio-guardrail-default-secret';
    return createHmac('sha256', secret).update(value).digest('hex').substring(0, 16);
  }

  /**
   * Get current configuration (for diagnostics)
   */
  getConfig(): Omit<GuardrailsConfig, 'violationTopicArn'> {
    return {
      region: this.config.region,
      guardrailId: this.config.guardrailId,
      guardrailVersion: this.config.guardrailVersion,
      enablePiiTokenization: this.config.enablePiiTokenization,
      enableViolationNotifications: this.config.enableViolationNotifications,
      tokenTtlSeconds: this.config.tokenTtlSeconds,
    };
  }
}

// Singleton instance
let bedrockGuardrailsServiceInstance: BedrockGuardrailsService | null = null;

/**
 * Get or create the BedrockGuardrailsService singleton
 */
export function getBedrockGuardrailsService(
  config?: Partial<GuardrailsConfig>
): BedrockGuardrailsService {
  if (!bedrockGuardrailsServiceInstance) {
    bedrockGuardrailsServiceInstance = new BedrockGuardrailsService(config);
  }
  return bedrockGuardrailsServiceInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetBedrockGuardrailsService(): void {
  bedrockGuardrailsServiceInstance = null;
}
