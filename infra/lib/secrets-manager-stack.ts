import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "./constructs/config/environment-config"
import {
  ManagedSecret,
  SecretType,
  ComplianceAuditor,
} from "./constructs/security"
import { SecretCacheLayer } from "./constructs/compute/secret-cache-layer"
import * as sns from "aws-cdk-lib/aws-sns"
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions"

export interface SecretsManagerStackProps extends cdk.StackProps {
  environment: "dev" | "staging" | "prod"
  config: IEnvironmentConfig
  alertEmail?: string
}

/**
 * Secrets Manager Stack
 *
 * Centralized secrets management with:
 * - Encrypted storage with KMS
 * - Automatic rotation
 * - Cross-region replication (production only)
 * - Compliance monitoring and auditing
 * - Lambda layer for efficient caching
 *
 * Architecture:
 * 1. ManagedSecret constructs for individual secrets
 * 2. SecretCacheLayer for Lambda performance optimization
 * 3. ComplianceAuditor for ongoing monitoring
 * 4. SNS alerting for rotation failures and compliance violations
 *
 * @example
 * ```typescript
 * new SecretsManagerStack(app, 'AIStudio-SecretsManagerStack-Dev', {
 *   environment: 'dev',
 *   config: EnvironmentConfig.get('dev')
 * })
 * ```
 */
export class SecretsManagerStack extends cdk.Stack {
  public secretCacheLayer: SecretCacheLayer
  public complianceAuditor: ComplianceAuditor
  public alertTopic: sns.Topic

  constructor(scope: Construct, id: string, props: SecretsManagerStackProps) {
    super(scope, id, props)

    // Apply standard tags
    cdk.Tags.of(this).add('Environment', props.environment)
    cdk.Tags.of(this).add('ManagedBy', 'cdk')
    cdk.Tags.of(this).add('Project', 'AIStudio')
    // Create SNS topic for alerts
    this.alertTopic = new sns.Topic(this, "SecretAlertTopic", {
      displayName: `AIStudio Secrets Manager Alerts - ${props.environment}`,
      topicName: `AIStudio-${props.environment}-secrets-alerts`,
    })

    // Add email subscription if alertEmail is provided
    if (props.alertEmail) {
      this.alertTopic.addSubscription(
        new subscriptions.EmailSubscription(props.alertEmail)
      )
    }

    // Create Secret Cache Lambda Layer
    this.secretCacheLayer = new SecretCacheLayer(this, "SecretCacheLayer", {
      description: `Secret cache layer for ${props.environment} environment`,
      layerName: `AIStudio-${props.environment}-secret-cache`,
    })

    // Create Compliance Auditor
    this.complianceAuditor = new ComplianceAuditor(this, "ComplianceAuditor", {
      config: props.config,
      deploymentEnvironment: props.environment,
      projectName: "AIStudio",
      alertTopic: this.alertTopic,
      maxSecretAge: props.environment === "prod" ? 60 : 90,
    })

    // Add CloudFormation outputs
    new cdk.CfnOutput(this, "AlertTopicArn", {
      value: this.alertTopic.topicArn,
      description: "SNS topic for secrets alerts",
      exportName: `${this.stackName}-AlertTopicArn`,
    })
  }
}
