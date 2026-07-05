import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Atrium Content Events Stack (Issue #1055, Epic #1059, Atrium Phase 5 §27/§30.2)
 *
 * Owns the SNS topic the application publishes content lifecycle events to
 * (`content.published` / `content.version_created` / `content.unpublished` /
 * `content.public_publish_requested`). Downstream automations subscribe here
 * instead of polling: re-index for retrieval (Phase 6), connector pushes, the
 * public-publish approval queue, notifications.
 *
 * The topic ARN is exported (public readonly + SSM + CfnOutput) and injected into
 * the ECS task as `ATRIUM_EVENTS_TOPIC_ARN`; the app's `lib/content/events.ts`
 * publisher is best-effort and no-ops when the var is unset, so this stack is a
 * pure additive enablement. A dead-letter queue is provisioned for the
 * subscriptions Phase 6 adds (an SNS subscription's redrive policy points here).
 *
 * Mirrors GuardrailsStack's SNS pattern (tags, SSM, outputs).
 */
export interface AtriumEventsStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
}

export class AtriumEventsStack extends cdk.Stack {
  public readonly topic: sns.Topic;
  public readonly topicArn: string;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AtriumEventsStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // Dead-letter queue for failed event deliveries (used by the Phase 6
    // subscription redrive policies; no subscriptions exist yet).
    this.deadLetterQueue = new sqs.Queue(this, 'ContentEventsDLQ', {
      queueName: `aistudio-${environment}-atrium-content-events-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    cdk.Tags.of(this.deadLetterQueue).add('Environment', environment);
    cdk.Tags.of(this.deadLetterQueue).add('ManagedBy', 'cdk');

    this.topic = new sns.Topic(this, 'ContentEventsTopic', {
      topicName: `aistudio-${environment}-atrium-content-events`,
      displayName: 'AI Studio Atrium Content Events',
    });
    cdk.Tags.of(this.topic).add('Environment', environment);
    cdk.Tags.of(this.topic).add('ManagedBy', 'cdk');

    this.topicArn = this.topic.topicArn;

    // Publish the ARN for runtime config lookup (mirrors the sandbox-origin SSM
    // fallback) and as a CloudFormation output for cross-stack import.
    new ssm.StringParameter(this, 'ContentEventsTopicArnParam', {
      parameterName: `/aistudio/${environment}/atrium-events-topic-arn`,
      stringValue: this.topicArn,
      description: 'SNS topic ARN for Atrium content lifecycle events',
      tier: ssm.ParameterTier.STANDARD,
    });

    new cdk.CfnOutput(this, 'ContentEventsTopicArn', {
      value: this.topicArn,
      description: 'Atrium content events SNS topic ARN',
      exportName: `AIStudio-AtriumEvents-TopicArn-${environment}`,
    });
  }
}
