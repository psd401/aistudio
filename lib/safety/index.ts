/**
 * K-12 content safety module.
 *
 * Bedrock Guardrails evaluate inference inputs and outputs without rewriting
 * allowed content. Amazon Comprehend backs two explicit detect-only PII gates:
 * fail-closed Nexus memory writes and non-blocking published-agent telemetry.
 */

export {
  ContentSafetyService,
  getContentSafetyService,
  resetContentSafetyService,
  type ContentSafetyResult,
} from "./content-safety-service";

export {
  BedrockGuardrailsService,
  getBedrockGuardrailsService,
  resetBedrockGuardrailsService,
} from "./bedrock-guardrails-service";

export {
  PIIDetectionService,
  PIIDetectionUnavailableError,
  getPIIDetectionService,
  resetPIIDetectionService,
} from "./pii-detection-service";

export type {
  SafetyCheckResult,
  GuardrailCheckResult,
  PIIEntity,
  GuardrailViolation,
  GuardrailsConfig,
  ContentFilterType,
  FilterStrength,
  GuardrailAction,
  GuardrailAssessment,
  ApplyGuardrailResponse,
  ComprehendPIIType,
} from "./types";

export { K12_PII_TYPES } from "./types";
