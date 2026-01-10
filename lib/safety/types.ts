/**
 * Amazon Bedrock Guardrails - Type Definitions
 *
 * Types for K-12 content safety filtering and PII tokenization services.
 */

/**
 * Result of content safety evaluation
 */
export interface SafetyCheckResult {
  /** Whether the content is allowed */
  allowed: boolean;
  /** Processed content (may be tokenized) */
  processedContent: string;
  /** Reason for blocking (if blocked) */
  blockedReason?: string;
  /** User-friendly message for blocked content */
  blockedMessage?: string;
  /** Whether PII was detected and tokenized */
  hasPII?: boolean;
  /** Token mappings (if PII was tokenized) */
  tokens?: TokenMapping[];
  /** Categories that triggered blocking */
  blockedCategories?: string[];
}

/**
 * Result of guardrail content evaluation
 */
export interface GuardrailCheckResult {
  /** Whether the content was blocked */
  blocked: boolean;
  /** Reason for blocking */
  reason?: string;
  /** User-friendly blocked message */
  blockedMessage?: string;
  /** Categories that triggered blocking */
  blockedCategories?: string[];
}

/**
 * PII entity detected by Comprehend
 */
export interface PIIEntity {
  /** Type of PII (NAME, EMAIL, PHONE, etc.) */
  type: string;
  /** Start position in text */
  beginOffset: number;
  /** End position in text */
  endOffset: number;
  /** Confidence score (0-1) */
  score: number;
}

/**
 * Token mapping for PII replacement
 */
export interface TokenMapping {
  /** Unique token identifier */
  token: string;
  /** Original PII value (encrypted in storage) */
  original: string;
  /** Type of PII */
  type: string;
  /** Placeholder used in text */
  placeholder: string;
}

/**
 * Result of PII tokenization
 */
export interface TokenizationResult {
  /** Text with PII replaced by tokens */
  tokenizedText: string;
  /** Token mappings for de-tokenization */
  tokens: TokenMapping[];
  /** Whether any PII was detected */
  hasPII: boolean;
}

/**
 * Guardrail violation event for notifications
 */
export interface GuardrailViolation {
  /** Unique violation ID */
  violationId: string;
  /** User ID (hashed for privacy) */
  userIdHash: string;
  /** Timestamp of violation */
  timestamp: string;
  /** Content type (input/output) */
  source: 'input' | 'output';
  /** Categories that were violated */
  categories: string[];
  /** AI model used */
  modelId: string;
  /** Provider used */
  provider: string;
  /** Action taken (blocked/warned) */
  action: 'blocked' | 'warned';
  /** Conversation ID (if available) */
  conversationId?: string;
  /** Session ID */
  sessionId?: string;
}

/**
 * DynamoDB item for PII token storage
 */
export interface PIITokenDynamoDBItem {
  /** Partition key: token UUID */
  token: string;
  /** Sort key: session ID for isolation */
  sessionId: string;
  /** Original PII value (encrypted at rest) */
  original: string;
  /** PII type */
  type: string;
  /** Creation timestamp */
  createdAt: number;
  /** TTL for automatic expiration */
  ttl: number;
}

/**
 * Configuration for guardrails service
 */
export interface GuardrailsConfig {
  /** AWS region */
  region: string;
  /** Bedrock guardrail ID */
  guardrailId: string;
  /** Bedrock guardrail version */
  guardrailVersion: string;
  /** DynamoDB table name for PII tokens */
  piiTokenTableName?: string;
  /** SNS topic ARN for violation notifications */
  violationTopicArn?: string;
  /** Token TTL in seconds (default: 3600 = 1 hour) */
  tokenTtlSeconds?: number;
  /** Enable PII tokenization (default: true) */
  enablePiiTokenization?: boolean;
  /** Enable violation notifications (default: true) */
  enableViolationNotifications?: boolean;
  /** Secret key for HMAC hashing of user IDs in violation reports */
  hashSecret?: string;
}

/**
 * Content filter types supported by Bedrock Guardrails
 */
export type ContentFilterType =
  | 'HATE'
  | 'VIOLENCE'
  | 'SELF_HARM'
  | 'SEXUAL'
  | 'MISCONDUCT'
  | 'PROMPT_ATTACK';

/**
 * Filter strength levels
 */
export type FilterStrength = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Guardrail action
 */
export type GuardrailAction = 'NONE' | 'GUARDRAIL_INTERVENED';

/**
 * Assessment from guardrail evaluation
 */
export interface GuardrailAssessment {
  contentPolicy?: {
    filters?: Array<{
      type: ContentFilterType;
      confidence: string;
      action: 'BLOCKED' | 'ALLOWED';
    }>;
  };
  topicPolicy?: {
    topics?: Array<{
      name: string;
      type: string;
      action: 'BLOCKED' | 'ALLOWED';
    }>;
  };
  wordPolicy?: {
    customWords?: Array<{
      match: string;
      action: 'BLOCKED' | 'ALLOWED';
    }>;
  };
  sensitiveInformationPolicy?: {
    piiEntities?: Array<{
      type: string;
      match: string;
      action: 'ANONYMIZED' | 'BLOCKED';
    }>;
  };
}

/**
 * Response from Bedrock ApplyGuardrail API
 */
export interface ApplyGuardrailResponse {
  action: GuardrailAction;
  outputs?: Array<{
    text?: string;
  }>;
  assessments?: GuardrailAssessment[];
}

/**
 * PII types supported by Amazon Comprehend
 */
export type ComprehendPIIType =
  | 'NAME'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'SSN'
  | 'CREDIT_DEBIT_NUMBER'
  | 'CREDIT_DEBIT_CVV'
  | 'CREDIT_DEBIT_EXPIRY'
  | 'BANK_ACCOUNT_NUMBER'
  | 'BANK_ROUTING'
  | 'PASSPORT_NUMBER'
  | 'DRIVER_ID'
  | 'DATE_TIME'
  | 'AGE'
  | 'PIN'
  | 'URL'
  | 'IP_ADDRESS'
  | 'MAC_ADDRESS'
  | 'USERNAME'
  | 'PASSWORD';

/**
 * PII types to tokenize for K-12 safety
 * (Subset of Comprehend types relevant for student data protection)
 */
export const K12_PII_TYPES: ComprehendPIIType[] = [
  'NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'SSN',
  'DATE_TIME',
  'AGE',
];

/**
 * Custom PII pattern definition for district-specific identifiers
 *
 * Use this to define patterns that Amazon Comprehend doesn't detect,
 * such as student IDs, employee numbers, or other district-specific formats.
 */
export interface CustomPIIPattern {
  /** Unique identifier for this pattern (e.g., 'STUDENT_ID') */
  type: string;
  /** Human-readable description */
  description: string;
  /** Regular expression pattern (without global flag - added automatically) */
  pattern: RegExp;
  /** Minimum confidence score (0-1) - custom patterns default to 1.0 */
  confidence?: number;
}

/**
 * District-specific PII patterns
 *
 * Add custom patterns here for identifiers specific to your district.
 * These are detected alongside Amazon Comprehend's built-in PII types.
 *
 * To add a new pattern:
 * 1. Add a new entry to this array
 * 2. Define the regex pattern (test it thoroughly!)
 * 3. Deploy the application (no infrastructure changes needed)
 *
 * Pattern tips:
 * - Use \b for word boundaries to avoid partial matches
 * - Test with edge cases (embedded in text, at start/end, multiple occurrences)
 * - Consider false positives (dates, phone numbers, etc.)
 */
export const CUSTOM_PII_PATTERNS: CustomPIIPattern[] = [
  {
    type: 'STUDENT_ID',
    description: 'PSD401 student numbers - 7 digits starting with 2 (e.g., 2240393)',
    // Matches: 2000000-2999999 (7 digits starting with 2)
    // Word boundaries prevent matching within larger numbers
    pattern: /\b2\d{6}\b/,
    confidence: 1.0,
  },
  // Add more district-specific patterns below:
  // {
  //   type: 'EMPLOYEE_ID',
  //   description: 'Employee badge numbers - E followed by 5 digits',
  //   pattern: /\bE\d{5}\b/i,
  //   confidence: 1.0,
  // },
];
