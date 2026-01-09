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

    if (!region) {
      this.log.error('AWS_REGION not configured - BedrockGuardrailsService requires region');
      throw new Error('AWS_REGION environment variable or config.region is required for BedrockGuardrailsService');
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

      this.log.info('Input content passed safety check', {
        requestId,
        contentLength: content.length,
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

      this.log.info('Output content passed safety check', {
        requestId,
        contentLength: content.length,
        modelId,
        provider,
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

    if (response.action === 'GUARDRAIL_INTERVENED') {
      const assessment = response.assessments?.[0];
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
