import * as cdk from "aws-cdk-lib"
import * as iam from "aws-cdk-lib/aws-iam"
import * as accessanalyzer from "aws-cdk-lib/aws-accessanalyzer"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as sns from "aws-cdk-lib/aws-sns"
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "../constructs/config/environment-config"

export interface AccessAnalyzerStackProps extends cdk.StackProps {
  config: IEnvironmentConfig
  environment: string
  alertEmail?: string
}

/**
 * Stack for IAM Access Analyzer and automated compliance monitoring
 */
export class AccessAnalyzerStack extends cdk.Stack {
  public readonly analyzer: accessanalyzer.CfnAnalyzer
  public readonly alertTopic: sns.Topic
  public readonly remediationLambda: lambda.Function

  constructor(scope: Construct, id: string, props: AccessAnalyzerStackProps) {
    super(scope, id, props)

    // Create SNS topic for security alerts
    this.alertTopic = new sns.Topic(this, "SecurityAlertTopic", {
      topicName: `aistudio-${props.environment}-security-alerts`,
      displayName: "AI Studio Security Alerts",
    })

    // Add email subscription if configured
    if (props.alertEmail) {
      this.alertTopic.addSubscription(
        new subscriptions.EmailSubscription(props.alertEmail)
      )
    }

    // Create Access Analyzer
    this.analyzer = new accessanalyzer.CfnAnalyzer(this, "AccessAnalyzer", {
      type: "ACCOUNT",
      analyzerName: `aistudio-${props.environment}-analyzer`,
      archiveRules: this.createArchiveRules(props),
      tags: [
        {
          key: "Environment",
          value: props.environment,
        },
        {
          key: "Purpose",
          value: "IAMCompliance",
        },
        {
          key: "ManagedBy",
          value: "CDK",
        },
      ],
    })

    // Create remediation Lambda
    this.remediationLambda = this.createRemediationLambda(props)

    // Create EventBridge rule for findings
    this.createFindingsRule(props)

    // Create alarms
    this.createAlarms(props)
  }

  /**
   * Create archive rules to filter out expected findings
   */
  private createArchiveRules(
    props: AccessAnalyzerStackProps
  ): accessanalyzer.CfnAnalyzer.ArchiveRuleProperty[] {
    return [
      {
        ruleName: "ArchiveExpectedPublicS3Access",
        filter: [
          {
            property: "resourceType",
            eq: ["AWS::S3::Bucket"],
          },
          {
            property: "isPublic",
            eq: ["false"],
          },
        ],
      },
      {
        ruleName: "ArchiveInternalVPCAccess",
        filter: [
          {
            property: "principal.AWS",
            contains: [cdk.Aws.ACCOUNT_ID],
          },
        ],
      },
    ]
  }

  /**
   * Create remediation Lambda function
   */
  private createRemediationLambda(
    props: AccessAnalyzerStackProps
  ): lambda.Function {
    // Create explicit role to avoid CDK's deprecated fromAwsManagedPolicyName
    const remediationRole = new iam.Role(this, "RemediationLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "RemediationLambdaBasicExecPolicy",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })

    const remediationFunction = new lambda.Function(this, "RemediationLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      architecture: lambda.Architecture.ARM_64,
      handler: "remediation.handler",
      code: lambda.Code.fromAsset("lambda/iam-remediation"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      role: remediationRole,
      environment: {
        ANALYZER_ARN: this.analyzer.attrArn,
        SNS_TOPIC_ARN: this.alertTopic.topicArn,
        AUTO_REMEDIATE: props.environment === "dev" ? "true" : "false",
        ENVIRONMENT: props.environment,
      },
      description: "Automated remediation for IAM Access Analyzer findings",
    })

    // Grant permissions to the Lambda
    remediationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "access-analyzer:ListFindings",
          "access-analyzer:GetFinding",
          "access-analyzer:UpdateFindings",
        ],
        resources: [this.analyzer.attrArn],
      })
    )

    remediationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sns:Publish"],
        resources: [this.alertTopic.topicArn],
      })
    )

    // Add read permissions for analyzing policies
    // Note: Wildcard resource required because Access Analyzer findings can reference
    // any IAM role, S3 bucket, or KMS key in the account. We cannot predict which
    // resources will have security findings. This is read-only access for investigation.
    // Consider adding tag-based conditions in the future: {"aws:ResourceTag/ManagedBy": "BaseIAMRole"}
    remediationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          "s3:GetBucketPolicy",
          "s3:GetBucketAcl",
          "kms:GetKeyPolicy",
        ],
        resources: ["*"],
      })
    )

    // Only grant write permissions in dev for auto-remediation
    // IMPORTANT: Tag-based condition may not work for all IAM actions.
    // Some IAM operations (like DeleteRolePolicy) do NOT support resource tag conditions.
    // The Python Lambda includes explicit tag checking as a fallback to prevent
    // accidental modification of production resources.
    // Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_actions-resources-contextkeys.html
    if (props.environment === "dev") {
      remediationFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "iam:DeleteRolePolicy",
            "iam:PutRolePolicy",
            "iam:DetachRolePolicy",
            "s3:PutBucketPolicy",
            "s3:DeleteBucketPolicy",
          ],
          resources: ["*"],
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": "dev",
            },
          },
        })
      )
    }

    return remediationFunction
  }

  /**
   * Create EventBridge rule for Access Analyzer findings
   */
  private createFindingsRule(props: AccessAnalyzerStackProps): void {
    new events.Rule(this, "FindingsRule", {
      ruleName: `aistudio-${props.environment}-analyzer-findings`,
      description: "Trigger remediation on new Access Analyzer findings",
      eventPattern: {
        source: ["aws.access-analyzer"],
        detailType: ["Access Analyzer Finding"],
        detail: {
          status: ["ACTIVE"],
        },
      },
      targets: [
        new targets.LambdaFunction(this.remediationLambda),
        new targets.SnsTopic(this.alertTopic, {
          message: events.RuleTargetInput.fromEventPath("$.detail"),
        }),
      ],
    })
  }


  /**
   * Create CloudWatch alarms
   */
  private createAlarms(props: AccessAnalyzerStackProps): void {
    // Alarm for new critical findings
    const criticalFindingsAlarm = new cloudwatch.Alarm(this, "CriticalFindingsAlarm", {
      alarmName: `aistudio-${props.environment}-critical-findings`,
      alarmDescription: "Alert on new critical Access Analyzer findings",
      metric: new cloudwatch.Metric({
        namespace: "AIStudio/Security",
        metricName: "CriticalFindings",
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })

    criticalFindingsAlarm.addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alertTopic)
    )

    // Alarm for remediation failures
    const remediationFailureAlarm = new cloudwatch.Alarm(
      this,
      "RemediationFailureAlarm",
      {
        alarmName: `aistudio-${props.environment}-remediation-failures`,
        alarmDescription: "Alert on remediation Lambda failures",
        metric: new cloudwatch.Metric({
          namespace: "AWS/Lambda",
          metricName: "Errors",
          dimensionsMap: {
            FunctionName: this.remediationLambda.functionName,
          },
          statistic: "Sum",
          period: cdk.Duration.minutes(15),
        }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    )

    remediationFailureAlarm.addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(this.alertTopic)
    )
  }
}
