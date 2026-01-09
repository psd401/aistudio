/**
 * K-12 Content Safety Module
 *
 * Provides comprehensive content safety for AI interactions in educational environments.
 *
 * Features:
 * - Content filtering (hate speech, violence, self-harm, sexual content)
 * - PII tokenization for student data protection
 * - SNS notifications for safety violations
 * - Graceful degradation when services unavailable
 *
 * Usage:
 * ```typescript
 * import { getContentSafetyService } from '@/lib/safety';
 *
 * const safetySvc = getContentSafetyService();
 *
 * // Process user input before sending to AI
 * const inputResult = await safetySvc.processInput(userMessage, sessionId);
 * if (!inputResult.allowed) {
 *   return { error: inputResult.blockedMessage };
 * }
 *
 * // Send tokenized content to AI
 * const aiResponse = await aiProvider.generate(inputResult.processedContent);
 *
 * // Process AI output before returning to user
 * const outputResult = await safetySvc.processOutput(
 *   aiResponse,
 *   modelId,
 *   provider,
 *   sessionId
 * );
 * if (!outputResult.allowed) {
 *   return { error: outputResult.blockedMessage };
 * }
 *
 * // Return detokenized content to user
 * return { content: outputResult.processedContent };
 * ```
 */

// Main service
export {
  ContentSafetyService,
  getContentSafetyService,
  resetContentSafetyService,
  type ContentSafetyResult,
} from './content-safety-service';

// Bedrock Guardrails
export {
  BedrockGuardrailsService,
  getBedrockGuardrailsService,
  resetBedrockGuardrailsService,
} from './bedrock-guardrails-service';

// PII Tokenization
export {
  PIITokenizationService,
  getPIITokenizationService,
  resetPIITokenizationService,
} from './pii-tokenization-service';

// Types
export type {
  SafetyCheckResult,
  GuardrailCheckResult,
  PIIEntity,
  TokenMapping,
  TokenizationResult,
  GuardrailViolation,
  PIITokenDynamoDBItem,
  GuardrailsConfig,
  ContentFilterType,
  FilterStrength,
  GuardrailAction,
  GuardrailAssessment,
  ApplyGuardrailResponse,
  ComprehendPIIType,
} from './types';

export { K12_PII_TYPES } from './types';
