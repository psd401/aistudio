# K-12 Content Safety System

> Comprehensive content filtering and student data protection for educational AI environments.

## Overview

AI Studio includes an enterprise-grade content safety system specifically designed for K-12 educational environments. This system provides two layers of protection:

1. **Content Filtering** - Blocks inappropriate content in both user inputs and AI responses
2. **PII Tokenization** - Protects student personally identifiable information from being sent to AI providers

These features help school districts meet COPPA, FERPA, and CIPA compliance requirements while providing students safe access to frontier AI models.

## Why This Matters for Schools

### The Challenge

When students interact with AI systems, two critical risks emerge:

1. **Inappropriate Content**: Students may attempt to generate harmful content, or AI models may produce responses unsuitable for educational settings
2. **Data Privacy**: Students may inadvertently share personal information (names, emails, phone numbers) with third-party AI providers

### The Solution

AI Studio's content safety system addresses both risks at the infrastructure level, meaning:

- Protection applies to ALL AI interactions automatically
- Works across all supported AI providers (OpenAI, Anthropic, Google, Bedrock)
- No configuration required by teachers or students
- Administrators receive real-time violation notifications

## Features

### Content Filtering (Amazon Bedrock Guardrails)

The content filtering system evaluates all messages against configurable safety policies:

| Category | Description | Action |
|----------|-------------|--------|
| **Hate Speech** | Content targeting protected groups | Blocked |
| **Violence** | Graphic violence or threats | Blocked |
| **Self-Harm** | Content encouraging self-injury | Blocked |
| **Sexual Content** | Inappropriate sexual material | Blocked |
| **Misconduct** | Illegal activities, dangerous instructions | Blocked |
| **Prompt Attacks** | Attempts to bypass safety measures | Blocked |

When content is blocked, users receive an age-appropriate message explaining that their request couldn't be processed, without revealing specific filtering details that could be used for circumvention.

### PII Tokenization (Amazon Comprehend)

The PII protection system identifies and tokenizes sensitive information before it reaches AI providers:

| PII Type | Example | Protection |
|----------|---------|------------|
| **Names** | "John Smith" | Replaced with `[PII:token]` |
| **Email Addresses** | "student@school.edu" | Replaced with `[PII:token]` |
| **Phone Numbers** | "(555) 123-4567" | Replaced with `[PII:token]` |
| **Physical Addresses** | "123 Main St" | Replaced with `[PII:token]` |
| **SSN** | Social Security Numbers | Replaced with `[PII:token]` |
| **Dates/Ages** | Birth dates, student ages | Replaced with `[PII:token]` |

**How Tokenization Works:**

```
User Input: "Help me write a letter for John Smith at john@school.edu"
     ↓
Tokenized: "Help me write a letter for [PII:abc123] at [PII:def456]"
     ↓
Sent to AI Provider (sees only tokens, never actual PII)
     ↓
AI Response: "Dear [PII:abc123], I am writing to..."
     ↓
Detokenized: "Dear John Smith, I am writing to..."
     ↓
User sees original names restored
```

The AI provider never sees actual student information, yet the user experience remains seamless with names and details appearing naturally in responses.

### Violation Notifications

Administrators can receive real-time notifications when safety violations occur:

- **SNS Topic**: Subscribable for email, SMS, or webhook alerts
- **Privacy-Preserving**: User IDs are hashed in notifications
- **Categorized**: Violations tagged by type for trend analysis
- **Actionable**: Includes timestamp, model used, and violation category

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Request Flow                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User Input                                                         │
│      │                                                              │
│      ▼                                                              │
│  ┌─────────────────┐                                                │
│  │ Content Safety  │◄─── Bedrock Guardrails (Input Check)           │
│  │    Service      │                                                │
│  └────────┬────────┘                                                │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ PII Tokenizer   │◄─── Amazon Comprehend (PII Detection)          │
│  │                 │◄─── DynamoDB (Token Storage, 1hr TTL)          │
│  └────────┬────────┘                                                │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │   AI Provider   │     (Sees tokenized content only)              │
│  │ OpenAI/Claude/  │                                                │
│  │ Gemini/Bedrock  │                                                │
│  └────────┬────────┘                                                │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ Content Safety  │◄─── Bedrock Guardrails (Output Check)          │
│  │    Service      │                                                │
│  └────────┬────────┘                                                │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ PII Detokenizer │◄─── Restores original values from DynamoDB     │
│  └────────┬────────┘                                                │
│           │                                                         │
│           ▼                                                         │
│      User Response                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Compliance Benefits

### COPPA (Children's Online Privacy Protection Act)

- PII tokenization prevents children's personal information from being transmitted to third-party AI services
- Token storage with automatic expiration (1-hour TTL) minimizes data retention
- No persistent storage of children's PII outside your infrastructure

### FERPA (Family Educational Rights and Privacy Act)

- Student educational records remain within district infrastructure
- AI providers only see anonymized/tokenized data
- Audit trail via CloudWatch logs for compliance reporting

### CIPA (Children's Internet Protection Act)

- Content filtering blocks access to inappropriate material
- Real-time protection for all AI-generated content
- Configurable filtering levels for different grade levels

## Configuration

### Environment Variables

```bash
# Required for content safety
AWS_REGION=us-east-1
BEDROCK_GUARDRAIL_ID=<guardrail-id>
BEDROCK_GUARDRAIL_VERSION=DRAFT

# Required for PII tokenization
PII_TOKEN_TABLE_NAME=<dynamodb-table-name>

# Optional: Violation notifications
GUARDRAIL_VIOLATION_TOPIC_ARN=<sns-topic-arn>

# Optional: Security
GUARDRAIL_HASH_SECRET=<random-secret-for-user-id-hashing>

# Feature toggles (both default to true)
CONTENT_SAFETY_ENABLED=true
PII_TOKENIZATION_ENABLED=true
```

### CDK Deployment

The guardrails infrastructure is deployed via the `GuardrailsStack`:

```bash
cd infra
npx cdk deploy AIStudio-GuardrailsStack-Dev
npx cdk deploy AIStudio-GuardrailsStack-Prod
```

This creates:
- Bedrock Guardrail with K-12 appropriate content policies
- DynamoDB table for PII token storage (with encryption at rest)
- SNS topic for violation notifications
- Appropriate IAM roles with least-privilege access

### Customizing Content Policies

The Bedrock Guardrail can be customized via the AWS Console or CDK:

```typescript
// infra/lib/guardrails-stack.ts
const guardrail = new bedrock.CfnGuardrail(this, 'K12Guardrail', {
  contentPolicyConfig: {
    filtersConfig: [
      { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'SELF_HARM', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'HIGH' },
    ],
  },
  // Add custom blocked topics for your district
  topicPolicyConfig: {
    topicsConfig: [
      {
        name: 'weapons',
        definition: 'Instructions for creating weapons or explosives',
        type: 'DENY',
      },
      // Add more custom topics as needed
    ],
  },
});
```

## Local Development

When running AI Studio locally without AWS credentials, the content safety system automatically disables itself:

```
[WARN] AWS_REGION not configured - BedrockGuardrailsService disabled (local development mode)
[WARN] AWS_REGION not configured - PIITokenizationService disabled (local development mode)
```

This allows developers to test locally while ensuring safety features are always active in production (where `AWS_REGION` is automatically set by ECS/Lambda).

## Monitoring & Observability

### CloudWatch Metrics

The content safety system logs detailed metrics:

- `guardrails.input.checked` - Number of inputs evaluated
- `guardrails.input.blocked` - Number of inputs blocked
- `guardrails.output.checked` - Number of outputs evaluated
- `guardrails.output.blocked` - Number of outputs blocked
- `pii.tokens.created` - Number of PII tokens generated
- `pii.tokens.restored` - Number of tokens successfully detokenized

### Log Analysis

All safety events are logged with structured JSON for easy analysis:

```json
{
  "level": "warn",
  "message": "Content blocked by safety guardrails (input)",
  "requestId": "req_abc123",
  "reason": "Violence",
  "categories": ["VIOLENCE"],
  "timestamp": "2025-01-09T12:00:00.000Z"
}
```

### Violation Alerts

Subscribe to the SNS topic for real-time alerts:

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789:aistudio-prod-guardrail-violations \
  --protocol email \
  --notification-endpoint admin@school.edu
```

## Frequently Asked Questions

### Does content filtering slow down responses?

Content filtering adds approximately 50-100ms latency per request. This is imperceptible to users and a worthwhile tradeoff for safety in educational environments.

### What happens if the safety service is unavailable?

The system is designed with graceful degradation. If Bedrock Guardrails or Comprehend are temporarily unavailable, content passes through unchanged while errors are logged for investigation. This ensures service continuity while maintaining visibility into any issues.

### Can students bypass the content filtering?

The content filtering includes protection against "prompt injection" and "jailbreak" attempts. The `PROMPT_ATTACK` filter specifically detects attempts to manipulate the AI into bypassing safety measures.

### Is student data stored anywhere?

PII tokens are stored in DynamoDB with:
- Automatic expiration after 1 hour (configurable)
- Encryption at rest using AWS-managed keys
- Session isolation (tokens only valid within original session)
- No persistence of actual PII values outside your infrastructure

### Can I disable these features?

Yes, via environment variables:
- `CONTENT_SAFETY_ENABLED=false` - Disables content filtering
- `PII_TOKENIZATION_ENABLED=false` - Disables PII protection

However, we strongly recommend keeping both enabled for K-12 deployments.

## Related Documentation

- [Deployment Guide](../DEPLOYMENT.md) - Full deployment instructions
- [IAM Security](../security/IAM_LEAST_PRIVILEGE.md) - IAM role configuration
- [Architecture Overview](../ARCHITECTURE.md) - System architecture
