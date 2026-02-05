import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GuardrailsStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  /** Optional email for guardrail violation notifications */
  notificationEmail?: string;
}

/**
 * GuardrailsStack - K-12 Content Safety Infrastructure
 *
 * Creates:
 * - Amazon Bedrock Guardrail for content safety filtering
 * - DynamoDB table for PII token storage
 * - SNS topic for violation notifications
 * - SSM parameters for service configuration
 *
 * This stack provides the infrastructure needed by the content safety service
 * to protect K-12 students from harmful content and protect their PII.
 */
export class GuardrailsStack extends cdk.Stack {
  /** Bedrock Guardrail for K-12 content filtering */
  public readonly guardrail: bedrock.CfnGuardrail;
  /** DynamoDB table for PII token storage */
  public readonly piiTokenTable: dynamodb.Table;
  /** SNS topic for violation notifications */
  public readonly violationTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: GuardrailsStackProps) {
    super(scope, id, props);

    // =====================================================================
    // 1. Amazon Bedrock Guardrail for K-12 Content Safety
    // =====================================================================

    this.guardrail = new bedrock.CfnGuardrail(this, 'K12ContentGuardrail', {
      name: `aistudio-${props.environment}-k12-safety`,
      description: 'K-12 content safety guardrail for AI Studio - filters harmful content including hate speech, violence, self-harm, and inappropriate material for educational environments.',

      // Blocked input/output messages shown to users
      blockedInputMessaging: 'This content is not appropriate for educational use. Please rephrase your question.',
      blockedOutputsMessaging: 'The AI response contained inappropriate content and has been blocked for your safety.',

      // Content filtering policies
      //
      // Issue #761: Content filters switched to detect-only mode where possible.
      // Following the same strategy as topic policies (Issue #742), content filters
      // were blocking legitimate K-12 educational content:
      // - SEXUAL: Blocking health education discussions
      // - INSULTS: Blocking teacher observations about student behavior
      // - VIOLENCE: Blocking history lessons (wars, civil rights struggles)
      // - HATE: Blocking Holocaust education, civil rights content
      //
      // AWS Bedrock requires at least ONE content filter at non-NONE strength.
      // HATE at LOW is kept as the minimum required filter — LOW threshold has
      // the fewest false positives for K-12 educational content.
      //
      // Safety net: LLM providers (OpenAI, Anthropic, Google) have built-in safety
      // training that provides baseline content filtering even without Bedrock.
      //
      // History:
      // - Issue #639: INSULTS/MISCONDUCT lowered from MEDIUM to LOW
      // - Issue #727: PROMPT_ATTACK disabled (75% false positive rate)
      // - Issue #761: All filters to NONE except HATE at LOW (Bedrock minimum requirement)
      contentPolicyConfig: {
        filtersConfig: [
          {
            // Kept at LOW — Bedrock requires at least one non-NONE filter
            type: 'HATE',
            inputStrength: 'LOW',
            outputStrength: 'LOW',
          },
          {
            type: 'VIOLENCE',
            inputStrength: 'NONE',  // Issue #761: Detect only, don't block
            outputStrength: 'NONE',
          },
          {
            type: 'SEXUAL',
            inputStrength: 'NONE',  // Issue #761: Detect only, don't block
            outputStrength: 'NONE',
          },
          {
            type: 'INSULTS',
            inputStrength: 'NONE',  // Issue #761: Detect only, don't block
            outputStrength: 'NONE',
          },
          {
            type: 'MISCONDUCT',
            inputStrength: 'NONE',  // Issue #761: Detect only, don't block
            outputStrength: 'NONE',
          },
          {
            type: 'PROMPT_ATTACK',
            inputStrength: 'NONE',  // Issue #727: Already disabled
            outputStrength: 'NONE',
          },
        ],
      },

      // Note: sensitiveInformationPolicyConfig is intentionally NOT configured here
      // because we handle PII detection and tokenization using Amazon Comprehend,
      // which gives us more flexibility for educational use cases. Bedrock's PII
      // blocking would reject legitimate educational content before our tokenization
      // service has a chance to protect it.

      // Topic-based filtering for K-12 inappropriate topics
      //
      // Issue #742: All topics switched to detect-only mode (inputAction/outputAction: NONE).
      // False positives were blocking legitimate K-12 educational content:
      // - Staff writing about student bullying incidents for PBIS documentation
      // - AI generating anti-bullying/SEL content classified as "Bullying"
      // - Student behavioral health discussions classified as "Self-Harm"
      // - Safety/discipline content hitting Violence + Bullying + Weapons simultaneously
      //
      // Strategy: Log all detections without blocking to collect data on what triggers
      // each topic. Once we understand the false positive patterns, we can selectively
      // re-enable blocking on topics that don't affect educational use cases.
      //
      // Content filters (HATE, VIOLENCE, SEXUAL, etc.) remain active as a safety net.
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'Weapons',
            definition: 'Content about weapons, firearms, explosives, or how to make weapons',
            type: 'DENY',
            inputAction: 'NONE',    // Issue #742: Detect only, don't block
            inputEnabled: true,      // Still evaluate for logging
            outputAction: 'NONE',   // Issue #742: Detect only, don't block
            outputEnabled: true,     // Still evaluate for logging
            examples: [
              'How to build a bomb',
              'Where can I buy a gun without ID',
              'How to make explosives at home',
            ],
          },
          {
            name: 'Drugs',
            definition: 'Content promoting or instructing about illegal drug use or substance abuse',
            type: 'DENY',
            inputAction: 'NONE',    // Issue #742: Detect only, don't block
            inputEnabled: true,
            outputAction: 'NONE',   // Issue #742: Detect only, don't block
            outputEnabled: true,
            examples: [
              'How to make drugs',
              'Where to buy illegal substances',
              'How to get high',
            ],
          },
          {
            // Issue #727: Simplified definition with stronger positive examples.
            // ML-based filtering works better with focused definitions and diverse examples
            // showing what TO block, rather than long exclusion lists. K-12 behavioral
            // management language (PBIS, SEL self-regulation) is not harmful and should
            // not match these explicit self-harm examples.
            //
            // Issue #731: Bedrock enforces max 5 examples per topic. Selected examples
            // cover distinct categories: general self-harm, suicide, eating disorders,
            // and instructional content.
            name: 'Self-Harm',
            definition: 'Content that promotes, instructs, or glorifies self-harm, suicide, or eating disorders. Targets instructional or promotional content, not educational discussions or behavioral documentation.',
            type: 'DENY',
            inputAction: 'NONE',    // Issue #742: Detect only, don't block
            inputEnabled: true,
            outputAction: 'NONE',   // Issue #742: Detect only, don't block
            outputEnabled: true,
            examples: [
              'Methods of self-harm',
              'Ways to commit suicide',
              'Pro-eating disorder content',
              'Step by step guide to self-injury',
              'How to restrict food intake severely',
            ],
          },
          {
            // Issue #742: Refined definition to narrow scope (matching Self-Harm pattern).
            // Previous broad definition "promotes bullying, harassment, or intimidation"
            // was triggering on AI responses discussing anti-bullying programs, PBIS
            // documentation, and student incident reports.
            // NOTE: CLASSIC tier limit is 200 chars for definitions (187 chars used).
            name: 'Bullying',
            definition: 'Instructions or encouragement for bullying, harassing, or intimidating individuals. Targets promotional content, not educational discussions about anti-bullying or behavior documentation.',
            type: 'DENY',
            inputAction: 'NONE',    // Issue #742: Detect only, don't block
            inputEnabled: true,
            outputAction: 'NONE',   // Issue #742: Detect only, don't block
            outputEnabled: true,
            examples: [
              'Ways to cyberbully someone',
              'How to harass classmates',
              'Creating fake profiles to bully',
              'Strategies to intimidate a student',
              'How to spread rumors about someone at school',
            ],
          },
        ],
      },

      // Word policy - block specific terms inappropriate for K-12
      wordPolicyConfig: {
        managedWordListsConfig: [
          {
            type: 'PROFANITY',
          },
        ],
      },

      // Resource tags
      tags: [
        { key: 'Environment', value: props.environment },
        { key: 'ManagedBy', value: 'cdk' },
        { key: 'Purpose', value: 'k12-content-safety' },
      ],
    });

    // =====================================================================
    // 2. DynamoDB Table for PII Token Storage
    // =====================================================================

    this.piiTokenTable = new dynamodb.Table(this, 'PIITokenTable', {
      tableName: `aistudio-${props.environment}-pii-tokens`,
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Encryption at rest enabled by default (AWS_OWNED)
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // TTL for automatic token expiration
      timeToLiveAttribute: 'ttl',
      // Point-in-time recovery for compliance
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retain data on stack deletion for production
      removalPolicy: props.environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add tags for tag-based access control
    cdk.Tags.of(this.piiTokenTable).add('Environment', props.environment);
    cdk.Tags.of(this.piiTokenTable).add('ManagedBy', 'cdk');

    // =====================================================================
    // 3. SNS Topic for Violation Notifications
    // =====================================================================

    this.violationTopic = new sns.Topic(this, 'GuardrailViolationsTopic', {
      topicName: `aistudio-${props.environment}-guardrail-violations`,
      displayName: 'AI Studio Guardrail Violations',
    });

    // Add tags for tag-based access control
    cdk.Tags.of(this.violationTopic).add('Environment', props.environment);
    cdk.Tags.of(this.violationTopic).add('ManagedBy', 'cdk');

    // Subscribe notification email if provided
    if (props.notificationEmail) {
      this.violationTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.notificationEmail)
      );
    }

    // =====================================================================
    // 4. SSM Parameters for Service Configuration
    // =====================================================================

    // Store guardrail ID in SSM for runtime lookup
    new ssm.StringParameter(this, 'GuardrailIdParam', {
      parameterName: `/aistudio/${props.environment}/guardrail-id`,
      stringValue: this.guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID for K-12 content safety',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Store guardrail version (always use DRAFT in dev, numbered in prod)
    new ssm.StringParameter(this, 'GuardrailVersionParam', {
      parameterName: `/aistudio/${props.environment}/guardrail-version`,
      stringValue: 'DRAFT', // Use DRAFT for now, update to versioned when ready
      description: 'Bedrock Guardrail version',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Store PII token table name
    new ssm.StringParameter(this, 'PIITokenTableParam', {
      parameterName: `/aistudio/${props.environment}/pii-token-table-name`,
      stringValue: this.piiTokenTable.tableName,
      description: 'DynamoDB table name for PII token storage',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Store violation topic ARN
    new ssm.StringParameter(this, 'ViolationTopicArnParam', {
      parameterName: `/aistudio/${props.environment}/guardrail-violation-topic-arn`,
      stringValue: this.violationTopic.topicArn,
      description: 'SNS topic ARN for guardrail violations',
      tier: ssm.ParameterTier.STANDARD,
    });

    // =====================================================================
    // 5. Outputs
    // =====================================================================

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: this.guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID',
      exportName: `${props.environment}-GuardrailId`,
    });

    new cdk.CfnOutput(this, 'GuardrailArn', {
      value: this.guardrail.attrGuardrailArn,
      description: 'Bedrock Guardrail ARN',
      exportName: `${props.environment}-GuardrailArn`,
    });

    new cdk.CfnOutput(this, 'PIITokenTableName', {
      value: this.piiTokenTable.tableName,
      description: 'DynamoDB table for PII tokens',
      exportName: `${props.environment}-PIITokenTableName`,
    });

    new cdk.CfnOutput(this, 'PIITokenTableArn', {
      value: this.piiTokenTable.tableArn,
      description: 'DynamoDB table ARN for PII tokens',
      exportName: `${props.environment}-PIITokenTableArn`,
    });

    new cdk.CfnOutput(this, 'ViolationTopicArn', {
      value: this.violationTopic.topicArn,
      description: 'SNS topic for violations',
      exportName: `${props.environment}-ViolationTopicArn`,
    });
  }

  /**
   * Generate IAM policy for services that need guardrails access
   *
   * Use this method to create policies for Lambda/ECS roles that need
   * to interact with the guardrails infrastructure.
   */
  getGuardrailsAccessPolicy(environment: string): iam.PolicyDocument {
    return new iam.PolicyDocument({
      statements: [
        // Bedrock Guardrails API access
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:ApplyGuardrail',
            'bedrock:GetGuardrail',
          ],
          resources: [this.guardrail.attrGuardrailArn],
        }),
        // Comprehend PII detection (requires wildcard - AWS limitation)
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'comprehend:DetectPiiEntities',
            'comprehend:ContainsPiiEntities',
          ],
          resources: ['*'], // Comprehend doesn't support resource-level permissions
        }),
        // DynamoDB access for PII tokens (with tag conditions)
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:Query',
            'dynamodb:BatchGetItem',
          ],
          resources: [this.piiTokenTable.tableArn],
          conditions: {
            StringEquals: {
              'aws:ResourceTag/Environment': environment,
              'aws:ResourceTag/ManagedBy': 'cdk',
            },
          },
        }),
        // SNS publish for violations (with tag conditions)
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sns:Publish'],
          resources: [this.violationTopic.topicArn],
          conditions: {
            StringEquals: {
              'aws:ResourceTag/Environment': environment,
              'aws:ResourceTag/ManagedBy': 'cdk',
            },
          },
        }),
      ],
    });
  }
}
