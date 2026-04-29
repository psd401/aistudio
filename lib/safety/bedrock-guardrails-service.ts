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
      this.bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
      this.snsClient = new SNSClient({ region: 'us-east-1' });
      this.config = BedrockGuardrailsService.buildDisabledConfig();
      return;
    }

    this.bedrockClient = new BedrockRuntimeClient({ region });
    this.snsClient = new SNSClient({ region });
    this.config = BedrockGuardrailsService.buildConfig(region, config);
    this.logConfigurationWarnings(config);
  }

  /**
   * Build a disabled configuration for local development (no AWS region)
   */
  private static buildDisabledConfig(): GuardrailsConfig {
    return {
      region: '',
      guardrailId: '',
      guardrailVersion: 'DRAFT',
      enableViolationNotifications: false,
      enablePiiTokenization: false,
      tokenTtlSeconds: 3600,
    };
  }

  /**
   * Build configuration from provided config and environment variables
   */
  private static buildConfig(region: string, config?: Partial<GuardrailsConfig>): GuardrailsConfig {
    return {
      region,
      guardrailId: config?.guardrailId || process.env.BEDROCK_GUARDRAIL_ID || '',
      guardrailVersion: config?.guardrailVersion || process.env.BEDROCK_GUARDRAIL_VERSION || 'DRAFT',
      violationTopicArn: config?.violationTopicArn || process.env.GUARDRAIL_VIOLATION_TOPIC_ARN,
      enableViolationNotifications: config?.enableViolationNotifications ?? true,
      enablePiiTokenization: config?.enablePiiTokenization ?? true,
      tokenTtlSeconds: config?.tokenTtlSeconds ?? 3600,
    };
  }

  /**
   * Log warnings about missing configuration
   */
  private logConfigurationWarnings(config?: Partial<GuardrailsConfig>): void {
    if (!this.config.guardrailId) {
      this.log.warn('Bedrock Guardrail ID not configured - content safety filtering disabled');
    }

    // Issue #727: Validate GUARDRAIL_HASH_SECRET is set for privacy protection
    if (!process.env.GUARDRAIL_HASH_SECRET && !config?.hashSecret) {
      this.log.warn('GUARDRAIL_HASH_SECRET not configured - using default secret for session ID hashing (weakens privacy protection)');
    }

    // Issue #929: Warn when content snippet logging is active — snippets contain the
    // first/last 30 chars of user content and bypass PII tokenization. This should
    // only be enabled during time-boxed tuning sprints, never left on in production.
    if (process.env.GUARDRAIL_LOG_SNIPPET === 'true') {
      this.log.warn('GUARDRAIL_LOG_SNIPPET is enabled — detection logs will include content head/tail snippets. Disable after tuning sprint to minimize PII surface in K-12 logs.');
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

      // Issue #929: Detect-only SNS notifications removed. Detection data is already
      // logged to CloudWatch (see evaluateContent → extractDetectedTopics/extractDetectedFilters).
      // SNS email is for actionable alerts (actual blocks), not high-volume telemetry.
      // Previously, up to 4 SNS publishes per message (detected topics + detected filters
      // on both input and output) created an email flood that made the notification channel
      // unusable. CloudWatch Logs Insights queries in docs/operations/guardrail-tuning-analysis.md
      // provide the appropriate monitoring channel for detect-only data.

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

      // Issue #929: Detect-only SNS notifications removed (same as evaluateInput).
      // Detection data is logged to CloudWatch via evaluateContent; SNS reserved for blocks.

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
      // Issue #763: Use FULL outputScope for detailed assessment data including
      // non-triggered filters. This improves diagnostic capability when analyzing
      // false positive patterns and tuning guardrail configuration.
      outputScope: 'FULL',
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
    const detectedFilters = this.extractDetectedFilters(assessment);

    // Issue #929: Build a privacy-preserving fingerprint to enable detection
    // clustering without writing raw content to logs. `contentHash` (HMAC-SHA256,
    // 16-hex-char prefix) lets us identify duplicate triggers across requests.
    // `contentSnippet` is opt-in via GUARDRAIL_LOG_SNIPPET=true and exposes only
    // the first/last 30 chars — enough to reverse-engineer trigger phrases during
    // a tuning sprint, but defaults OFF to minimize PII surface.
    const detectionFingerprint = (detectedTopics.length > 0 || detectedFilters.length > 0)
      ? this.buildDetectionFingerprint(content)
      : undefined;

    if (detectedTopics.length > 0) {
      this.log.info('Topics detected in detect-only mode (not blocked)', {
        source,
        detectedTopics,
        contentLength: content.length,
        ...detectionFingerprint,
      });
    }

    // Issue #761: Extract detected-but-not-blocked content filters from assessments.
    // When content filters use inputStrength/outputStrength: 'NONE' (detect-only mode),
    // the overall response.action will NOT be 'GUARDRAIL_INTERVENED' for those
    // filters, but the assessment trace still contains detection information.
    if (detectedFilters.length > 0) {
      this.log.info('Content filters detected in detect-only mode (not blocked)', {
        source,
        detectedFilters,
        contentLength: content.length,
        ...detectionFingerprint,
      });
    }

    if (response.action === 'GUARDRAIL_INTERVENED') {
      return this.buildBlockedResult(assessment, response, source, content.length);
    }

    return {
      blocked: false,
      detectedTopics: detectedTopics.length > 0 ? detectedTopics : undefined,
      detectedFilters: detectedFilters.length > 0 ? detectedFilters : undefined,
    };
  }

  /**
   * Build a blocked result with detailed assessment logging
   *
   * Issue #763: Logs word policy matches (count/type only — never raw words),
   * filter confidence levels, and topic triggers to support false positive analysis.
   */
  private buildBlockedResult(
    assessment: SDKGuardrailAssessment | undefined,
    response: { outputs?: Array<{ text?: string }> },
    source: 'INPUT' | 'OUTPUT',
    contentLength: number
  ): GuardrailCheckResult {
    const blockedCategories = this.extractBlockedCategories(assessment);
    const blockedMessage = response.outputs?.[0]?.text;

    const wordMatches = this.extractBlockedWordMatches(assessment);
    const filterDetails = this.extractBlockedFilterDetails(assessment);

    this.log.warn('Guardrail intervened', {
      source,
      blockedCategories,
      hasBlockedMessage: !!blockedMessage,
      wordPolicyMatches: wordMatches.length > 0 ? wordMatches : undefined,
      contentFilterDetails: filterDetails.length > 0 ? filterDetails : undefined,
      contentLength,
    });

    return {
      blocked: true,
      reason: blockedCategories.join(', ') || 'Content policy violation',
      blockedMessage,
      blockedCategories,
    };
  }

  /**
   * Extract word policy match metadata (type/count only — never raw matched words)
   */
  private extractBlockedWordMatches(assessment?: SDKGuardrailAssessment): Array<{ type: string; matchLength?: number }> {
    const customWordMatches = assessment?.wordPolicy?.customWords
      ?.filter(w => w.action === 'BLOCKED')
      .map(w => ({ type: 'custom', matchLength: w.match?.length })) ?? [];

    const managedWordMatches = assessment?.wordPolicy?.managedWordLists
      ?.filter(w => w.action === 'BLOCKED')
      .map(w => ({ type: w.type ?? 'unknown', matchLength: w.match?.length })) ?? [];

    return [...customWordMatches, ...managedWordMatches];
  }

  /**
   * Extract blocked content filter details (type and confidence)
   */
  private extractBlockedFilterDetails(assessment?: SDKGuardrailAssessment): Array<{ type?: string; confidence?: string }> {
    return assessment?.contentPolicy?.filters
      ?.filter(f => f.action === 'BLOCKED')
      .map(f => ({ type: f.type, confidence: f.confidence })) ?? [];
  }

  /**
   * Extract blocked category names from guardrail assessment
   */
  private extractBlockedCategories(assessment?: SDKGuardrailAssessment): string[] {
    return [
      ...this.extractBlockedContentFilterCategories(assessment),
      ...this.extractBlockedTopicCategories(assessment),
      ...this.extractBlockedWordCategories(assessment),
    ];
  }

  /**
   * Extract content filter categories that triggered blocking (hate, violence, etc.)
   */
  private extractBlockedContentFilterCategories(assessment?: SDKGuardrailAssessment): string[] {
    return assessment?.contentPolicy?.filters
      ?.filter(f => f.action === 'BLOCKED' && f.type)
      .map(f => this.formatCategoryName(f.type as ContentFilterType)) ?? [];
  }

  /**
   * Extract topic policy categories that triggered blocking
   */
  private extractBlockedTopicCategories(assessment?: SDKGuardrailAssessment): string[] {
    return assessment?.topicPolicy?.topics
      ?.filter(t => t.action === 'BLOCKED' && t.name)
      .map(t => t.name!) ?? [];
  }

  /**
   * Extract word policy categories that triggered blocking (custom words + managed word lists)
   *
   * Issue #763: Includes managedWordLists (PROFANITY filter) which was previously missing.
   * Note: word.match (the raw blocked word) is intentionally NOT included — it flows into
   * SNS email subjects which appear in plaintext on lock screens.
   */
  private extractBlockedWordCategories(assessment?: SDKGuardrailAssessment): string[] {
    const categories: string[] = [];

    const hasBlockedCustomWord = assessment?.wordPolicy?.customWords
      ?.some(w => w.action === 'BLOCKED') ?? false;
    if (hasBlockedCustomWord) {
      categories.push('Blocked word detected');
    }

    const blockedManagedWords = assessment?.wordPolicy?.managedWordLists
      ?.filter(w => w.action === 'BLOCKED') ?? [];
    for (const word of blockedManagedWords) {
      categories.push(`Profanity filter (${word.type ?? 'managed word list'})`);
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
    const lowerContent = content.toLowerCase();

    return [
      this.detectSystemOverride(lowerContent),
      this.detectRoleManipulation(content),
      this.detectDataExtraction(lowerContent),
      this.detectDelimiterBypass(content),
      this.detectJailbreak(content),
    ].filter((pattern): pattern is string => pattern !== null);
  }

  /** System instruction override attempts */
  private detectSystemOverride(lowerContent: string): string | null {
    const overridePhrases = [
      'system instruction', 'system prompt', 'system message',
      'ignore previous', 'ignore all previous',
      'disregard previous', 'forget everything',
    ];
    return overridePhrases.some(phrase => lowerContent.includes(phrase))
      ? 'system_override_attempt' : null;
  }

  /** Role manipulation attempts (excludes legitimate educational role-playing) */
  private detectRoleManipulation(content: string): string | null {
    const isLegitimateRolePlaying = /principal|teacher|administrator|superintendent|danielson|evaluation|observation/iu.test(content);
    if (isLegitimateRolePlaying) return null;

    const rolePatterns = [
      /you\s+are\s+now\s+(?:a|an|the)/iu,
      /act\s+as\s+(?:if|though)\s+you\s+(?:are|were)/iu,
      /pretend\s+(?:to\s+be|you\s+are)/iu,
      /simulate\s+(?:being|a)/iu,
    ];
    return rolePatterns.some(pattern => pattern.test(content))
      ? 'role_manipulation' : null;
  }

  /** Data extraction attempts (probing for system prompts / instructions) */
  private detectDataExtraction(lowerContent: string): string | null {
    const extractionPhrases = [
      'show me your prompt', 'what are your instructions',
      'reveal your system prompt', 'output your configuration',
    ];
    return extractionPhrases.some(phrase => lowerContent.includes(phrase))
      ? 'data_extraction_attempt' : null;
  }

  /** Delimiter/encoding bypass attempts */
  private detectDelimiterBypass(content: string): string | null {
    if (/[<>]{3,}/u.test(content) && /<\/?system>/iu.test(content)) return 'delimiter_bypass';
    if (content.includes('[INST]')) return 'delimiter_bypass';
    if (/\{\{\{\s*system/iu.test(content)) return 'delimiter_bypass';
    return null;
  }

  /** Jailbreak/DAN pattern attempts */
  private detectJailbreak(content: string): string | null {
    return /do\s+anything\s+now|dan\s+mode|developer\s+mode/iu.test(content)
      ? 'jailbreak_attempt' : null;
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
      INSULTS: 'Insults',
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
        // SNS Subject max is 100 chars. Truncate category list to fit.
        Subject: (() => {
          const base = 'K-12 Content Safety Alert: ';
          const full = base + violation.categories.join(', ');
          return full.length <= 100 ? full : full.slice(0, 97) + '...';
        })(),
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
   * Build a privacy-preserving fingerprint for a detection event (Issue #929).
   *
   * Returns the HMAC-SHA256 hash of the content (clustering key) and, when the
   * `GUARDRAIL_LOG_SNIPPET` env var is set to "true", a short head/tail snippet
   * for human review during tuning. Snippet is OFF by default to minimize PII
   * surface in K-12 logs.
   */
  private buildDetectionFingerprint(content: string): { contentHash: string; contentSnippet?: string } {
    const fp: { contentHash: string; contentSnippet?: string } = {
      contentHash: this.hashValue(content),
    };
    if (process.env.GUARDRAIL_LOG_SNIPPET === 'true') {
      const head = content.slice(0, 30).replace(/\s+/g, ' ').trim();
      const tail = content.length > 60 ? content.slice(-30).replace(/\s+/g, ' ').trim() : '';
      fp.contentSnippet = tail ? `${head} … ${tail}` : head;
    }
    return fp;
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
