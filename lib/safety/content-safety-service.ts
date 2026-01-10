/**
 * Content Safety Service
 *
 * Unified content safety service that combines:
 * 1. Bedrock Guardrails for content filtering (hate, violence, etc.)
 * 2. PII tokenization for student data protection
 *
 * This is the main integration point for the streaming service.
 *
 * Flow:
 * INPUT: User Message → Content Safety Check → PII Tokenization → AI Provider
 * OUTPUT: AI Response → Content Safety Check → PII Detokenization → User
 */

import { createLogger, generateRequestId } from '@/lib/logger';
import {
  BedrockGuardrailsService,
  getBedrockGuardrailsService,
} from './bedrock-guardrails-service';
import {
  PIITokenizationService,
  getPIITokenizationService,
} from './pii-tokenization-service';
import type {
  SafetyCheckResult,
  GuardrailsConfig,
  TokenMapping,
} from './types';

/**
 * Combined result from safety processing
 */
export interface ContentSafetyResult extends SafetyCheckResult {
  /** Request ID for tracing */
  requestId: string;
  /** Time taken for safety check (ms) */
  processingTimeMs: number;
  /** Whether content was modified (tokenized/detokenized) */
  contentModified: boolean;
}

/**
 * ContentSafetyService - Unified K-12 content protection
 *
 * Provides a single interface for all content safety operations:
 * - Input validation (before sending to AI)
 * - Output validation (before returning to user)
 * - Automatic PII protection
 * - SNS notifications for violations
 */
export class ContentSafetyService {
  private guardrailsService: BedrockGuardrailsService;
  private piiService: PIITokenizationService;
  private log = createLogger({ module: 'ContentSafetyService' });

  constructor(config?: Partial<GuardrailsConfig>) {
    this.guardrailsService = getBedrockGuardrailsService(config);
    this.piiService = getPIITokenizationService(config);
  }

  /**
   * Check if any safety services are enabled
   */
  isEnabled(): boolean {
    return this.guardrailsService.isEnabled() || this.piiService.isEnabled();
  }

  /**
   * Check if guardrails (content filtering) is enabled
   */
  isGuardrailsEnabled(): boolean {
    return this.guardrailsService.isEnabled();
  }

  /**
   * Check if PII tokenization is enabled
   */
  isPiiTokenizationEnabled(): boolean {
    return this.piiService.isEnabled();
  }

  /**
   * Process user input - content safety check + PII tokenization
   *
   * This should be called BEFORE sending messages to AI providers.
   *
   * @param content - User message content
   * @param sessionId - Session identifier for PII token scoping
   * @returns Processed content (may be tokenized) or blocked result
   */
  async processInput(
    content: string,
    sessionId: string
  ): Promise<ContentSafetyResult> {
    const requestId = generateRequestId();
    const startTime = Date.now();

    this.log.info('Processing input content', {
      requestId,
      contentLength: content.length,
      sessionId,
      guardrailsEnabled: this.guardrailsService.isEnabled(),
      piiEnabled: this.piiService.isEnabled(),
    });

    try {
      // Step 1: Content safety check (hate, violence, etc.)
      if (this.guardrailsService.isEnabled()) {
        const safetyResult = await this.guardrailsService.evaluateInput(
          content,
          sessionId
        );

        if (!safetyResult.allowed) {
          this.log.warn('Input blocked by guardrails', {
            requestId,
            reason: safetyResult.blockedReason,
            categories: safetyResult.blockedCategories,
          });

          return {
            ...safetyResult,
            requestId,
            processingTimeMs: Date.now() - startTime,
            contentModified: false,
          };
        }
      }

      // Step 2: PII tokenization (if enabled and content passed safety check)
      let processedContent = content;
      let tokens: TokenMapping[] = [];
      let hasPII = false;
      let contentModified = false;

      if (this.piiService.isEnabled()) {
        const tokenizationResult = await this.piiService.tokenize(
          content,
          sessionId
        );
        processedContent = tokenizationResult.tokenizedText;
        tokens = tokenizationResult.tokens;
        hasPII = tokenizationResult.hasPII;
        contentModified = hasPII;

        if (hasPII) {
          this.log.info('PII tokenized in input', {
            requestId,
            tokensCreated: tokens.length,
            piiTypes: tokens.map((t) => t.type),
          });
        }
      }

      const result: ContentSafetyResult = {
        allowed: true,
        processedContent,
        hasPII,
        tokens,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified,
      };

      this.log.info('Input processing complete', {
        requestId,
        processingTimeMs: result.processingTimeMs,
        hasPII,
        contentModified,
      });

      return result;
    } catch (error) {
      this.log.error('Input processing failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Graceful degradation - allow content through on error
      return {
        allowed: true,
        processedContent: content,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified: false,
      };
    }
  }

  /**
   * Process AI output - content safety check + PII detokenization
   *
   * This should be called BEFORE returning AI responses to users.
   *
   * @param content - AI response content
   * @param modelId - Model that generated the response
   * @param provider - AI provider used
   * @param sessionId - Session identifier for PII token lookup
   * @returns Processed content (may be detokenized) or blocked result
   */
  async processOutput(
    content: string,
    modelId: string,
    provider: string,
    sessionId: string
  ): Promise<ContentSafetyResult> {
    const requestId = generateRequestId();
    const startTime = Date.now();

    this.log.info('Processing output content', {
      requestId,
      contentLength: content.length,
      modelId,
      provider,
      sessionId,
      guardrailsEnabled: this.guardrailsService.isEnabled(),
      piiEnabled: this.piiService.isEnabled(),
    });

    try {
      // Step 1: Content safety check on AI output
      if (this.guardrailsService.isEnabled()) {
        const safetyResult = await this.guardrailsService.evaluateOutput(
          content,
          modelId,
          provider,
          sessionId
        );

        if (!safetyResult.allowed) {
          this.log.warn('Output blocked by guardrails', {
            requestId,
            reason: safetyResult.blockedReason,
            categories: safetyResult.blockedCategories,
            modelId,
            provider,
          });

          return {
            ...safetyResult,
            requestId,
            processingTimeMs: Date.now() - startTime,
            contentModified: false,
          };
        }
      }

      // Step 2: PII detokenization (restore original values)
      let processedContent = content;
      let contentModified = false;

      if (this.piiService.isEnabled()) {
        const originalContent = content;
        processedContent = await this.piiService.detokenize(content, sessionId);
        contentModified = processedContent !== originalContent;

        if (contentModified) {
          this.log.info('PII restored in output', {
            requestId,
            originalLength: originalContent.length,
            processedLength: processedContent.length,
          });
        }
      }

      const result: ContentSafetyResult = {
        allowed: true,
        processedContent,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified,
      };

      this.log.info('Output processing complete', {
        requestId,
        processingTimeMs: result.processingTimeMs,
        contentModified,
      });

      return result;
    } catch (error) {
      this.log.error('Output processing failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Graceful degradation - return content as-is on error
      return {
        allowed: true,
        processedContent: content,
        requestId,
        processingTimeMs: Date.now() - startTime,
        contentModified: false,
      };
    }
  }

  /**
   * Quick input check (content safety only, no PII tokenization)
   *
   * Use this for lightweight validation when PII protection isn't needed.
   */
  async checkInputSafety(
    content: string,
    sessionId?: string
  ): Promise<SafetyCheckResult> {
    if (!this.guardrailsService.isEnabled()) {
      return { allowed: true, processedContent: content };
    }
    return this.guardrailsService.evaluateInput(content, sessionId);
  }

  /**
   * Quick output check (content safety only, no PII detokenization)
   *
   * Use this for lightweight validation when PII protection isn't needed.
   */
  async checkOutputSafety(
    content: string,
    modelId: string,
    provider: string,
    sessionId?: string
  ): Promise<SafetyCheckResult> {
    if (!this.guardrailsService.isEnabled()) {
      return { allowed: true, processedContent: content };
    }
    return this.guardrailsService.evaluateOutput(content, modelId, provider, sessionId);
  }

  /**
   * Get service status and configuration
   */
  getStatus(): {
    guardrailsEnabled: boolean;
    piiTokenizationEnabled: boolean;
    guardrailsConfig: ReturnType<BedrockGuardrailsService['getConfig']>;
    piiConfig: ReturnType<PIITokenizationService['getConfig']>;
  } {
    return {
      guardrailsEnabled: this.guardrailsService.isEnabled(),
      piiTokenizationEnabled: this.piiService.isEnabled(),
      guardrailsConfig: this.guardrailsService.getConfig(),
      piiConfig: this.piiService.getConfig(),
    };
  }
}

// Singleton instance
let contentSafetyServiceInstance: ContentSafetyService | null = null;

/**
 * Get or create the ContentSafetyService singleton
 */
export function getContentSafetyService(
  config?: Partial<GuardrailsConfig>
): ContentSafetyService {
  if (!contentSafetyServiceInstance) {
    contentSafetyServiceInstance = new ContentSafetyService(config);
  }
  return contentSafetyServiceInstance;
}

/**
 * Reset all safety service singletons (for testing)
 */
export function resetContentSafetyService(): void {
  contentSafetyServiceInstance = null;
}
