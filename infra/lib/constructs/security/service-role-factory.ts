import * as iam from "aws-cdk-lib/aws-iam"
import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import { BaseIAMRole } from "./base-iam-role"
import { LambdaRoleProps, ECSTaskRoleProps } from "./types"

/**
 * Factory for creating service-specific IAM roles with least privilege
 */
export class ServiceRoleFactory {
  /**
   * Create a Lambda execution role with least privilege
   */
  static createLambdaRole(
    scope: Construct,
    id: string,
    props: LambdaRoleProps
  ): iam.Role {
    const policies: iam.PolicyDocument[] = []

    // Basic Lambda execution policy
    policies.push(this.buildLambdaBasePolicy(props))

    // VPC access if enabled
    if (props.vpcEnabled) {
      policies.push(this.buildVPCAccessPolicy(props))
    }

    // Secrets Manager access
    if (props.secrets && props.secrets.length > 0) {
      policies.push(this.buildSecretsAccessPolicy(props.secrets, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // S3 bucket access
    if (props.s3Buckets && props.s3Buckets.length > 0) {
      policies.push(this.buildS3AccessPolicy(props.s3Buckets, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // DynamoDB table access
    if (props.dynamodbTables && props.dynamodbTables.length > 0) {
      policies.push(this.buildDynamoDBAccessPolicy(props.dynamodbTables, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // SQS queue access
    if (props.sqsQueues && props.sqsQueues.length > 0) {
      policies.push(this.buildSQSAccessPolicy(props.sqsQueues, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // SNS topic access
    if (props.snsTopics && props.snsTopics.length > 0) {
      policies.push(this.buildSNSAccessPolicy(props.snsTopics, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // Add any additional policies
    if (props.additionalPolicies) {
      policies.push(...props.additionalPolicies)
    }

    const baseRole = new BaseIAMRole(scope, id, {
      roleName: `${props.functionName}-execution-role-${props.environment}`,
      service: "lambda.amazonaws.com",
      description: `Execution role for ${props.functionName} Lambda function`,
      policies,
      environment: props.environment,
      maxSessionDuration: cdk.Duration.hours(1),
    })

    return baseRole.role
  }

  /**
   * Create an ECS task role with least privilege
   */
  static createECSTaskRole(
    scope: Construct,
    id: string,
    props: ECSTaskRoleProps
  ): iam.Role {
    const policies: iam.PolicyDocument[] = []

    // Secrets Manager access
    if (props.secrets && props.secrets.length > 0) {
      policies.push(this.buildSecretsAccessPolicy(props.secrets, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // S3 bucket access
    if (props.s3Buckets && props.s3Buckets.length > 0) {
      policies.push(this.buildS3AccessPolicy(props.s3Buckets, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // DynamoDB table access
    if (props.dynamodbTables && props.dynamodbTables.length > 0) {
      policies.push(this.buildDynamoDBAccessPolicy(props.dynamodbTables, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // SQS queue access
    if (props.sqsQueues && props.sqsQueues.length > 0) {
      policies.push(this.buildSQSAccessPolicy(props.sqsQueues, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // SNS topic access
    if (props.snsTopics && props.snsTopics.length > 0) {
      policies.push(this.buildSNSAccessPolicy(props.snsTopics, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // ECR repository access
    if (props.ecrRepositories && props.ecrRepositories.length > 0) {
      policies.push(this.buildECRAccessPolicy(props.ecrRepositories, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // Add any additional policies
    if (props.additionalPolicies) {
      policies.push(...props.additionalPolicies)
    }

    const baseRole = new BaseIAMRole(scope, id, {
      roleName: `${props.taskName}-task-role-${props.environment}`,
      service: "ecs-tasks.amazonaws.com",
      description: `Task role for ${props.taskName} ECS service`,
      policies,
      environment: props.environment,
    })

    return baseRole.role
  }

  /**
   * Create an ECS task execution role (for pulling images, logs, secrets)
   */
  static createECSTaskExecutionRole(
    scope: Construct,
    id: string,
    props: ECSTaskRoleProps
  ): iam.Role {
    const policies: iam.PolicyDocument[] = []

    // Basic ECS task execution policy
    policies.push(this.buildECSExecutionBasePolicy(props))

    // ECR access for pulling images
    if (props.ecrRepositories && props.ecrRepositories.length > 0) {
      policies.push(this.buildECRAccessPolicy(props.ecrRepositories, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    // Secrets access for environment variables
    if (props.secrets && props.secrets.length > 0) {
      policies.push(this.buildSecretsAccessPolicy(props.secrets, {
        region: props.region,
        account: props.account,
        environment: props.environment
      }))
    }

    const baseRole = new BaseIAMRole(scope, id, {
      roleName: `${props.taskName}-execution-role`,
      service: "ecs-tasks.amazonaws.com",
      description: `Execution role for ${props.taskName} ECS service`,
      policies,
      environment: props.environment,
    })

    return baseRole.role
  }

  /**
   * Build Lambda base policy (CloudWatch Logs, X-Ray)
   */
  private static buildLambdaBasePolicy(props: LambdaRoleProps): iam.PolicyDocument {
    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          resources: [
            `arn:aws:logs:${props.region}:${props.account}:log-group:/aws/lambda/${props.functionName}:*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"], // X-Ray requires wildcard
        }),
      ],
    })
  }

  /**
   * Build VPC access policy for Lambda
   */
  private static buildVPCAccessPolicy(props: LambdaRoleProps): iam.PolicyDocument {
    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "ec2:CreateNetworkInterface",
            "ec2:DescribeNetworkInterfaces",
            "ec2:DeleteNetworkInterface",
            "ec2:AssignPrivateIpAddresses",
            "ec2:UnassignPrivateIpAddresses",
          ],
          resources: ["*"], // VPC ENI operations require wildcard, but we add conditions
          conditions: {
            StringEquals: {
              "ec2:Subnet": [
                `arn:aws:ec2:${props.region}:${props.account}:subnet/*`,
              ],
            },
          },
        }),
      ],
    })
  }

  /**
   * Build ECS execution base policy (CloudWatch Logs, ECR)
   */
  private static buildECSExecutionBasePolicy(
    props: ECSTaskRoleProps
  ): iam.PolicyDocument {
    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          resources: [
            `arn:aws:logs:${props.region}:${props.account}:log-group:/ecs/${props.taskName}:*`,
          ],
        }),
      ],
    })
  }

  /**
   * Build Secrets Manager access policy with tag-based conditions for enhanced security
   */
  private static buildSecretsAccessPolicy(
    secretArns: string[],
    props: { region: string; account: string; environment: string }
  ): iam.PolicyDocument {
    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue"],
          resources: secretArns.map((secretName) =>
            secretName.startsWith("arn:")
              ? secretName
              : `arn:aws:secretsmanager:${props.region}:${props.account}:secret:${secretName}*`
          ),
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
      ],
    })
  }

  /**
   * Build S3 access policy with tag-based conditions for enhanced security
   *
   * Note: Tag conditions are applied at bucket level only. Object-level tag conditions
   * (s3:ExistingObjectTag) are not used because:
   * - They don't apply to PutObject operations on new objects
   * - Bucket-level tags provide sufficient environment isolation
   * - Avoids requiring object tagging in application code
   */
  private static buildS3AccessPolicy(
    bucketNames: string[],
    props: { region: string; account: string; environment: string }
  ): iam.PolicyDocument {
    const bucketArns = bucketNames.map((bucket) =>
      bucket.startsWith("arn:") ? bucket : `arn:aws:s3:::${bucket}`
    )

    return new iam.PolicyDocument({
      statements: [
        // Object operations - tag conditions check parent bucket tags for environment isolation
        // Note: aws:ResourceTag on object ARNs checks the bucket's tags, not object tags
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:PutObject",
            "s3:DeleteObject",
          ],
          resources: bucketArns.map((arn) => `${arn}/*`),
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
        // Bucket operations - tag conditions enforce environment isolation
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:ListBucket", "s3:GetBucketLocation"],
          resources: bucketArns,
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
      ],
    })
  }

  /**
   * Build DynamoDB access policy with tag-based conditions for enhanced security
   */
  private static buildDynamoDBAccessPolicy(
    tableNames: string[],
    props: { region: string; account: string; environment: string }
  ): iam.PolicyDocument {
    const tableArns = tableNames.map((table) =>
      table.startsWith("arn:")
        ? table
        : `arn:aws:dynamodb:${props.region}:${props.account}:table/${table}`
    )

    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:Scan",
          ],
          resources: [...tableArns, ...tableArns.map((arn) => `${arn}/index/*`)],
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
      ],
    })
  }

  /**
   * Build SQS access policy with tag-based conditions for enhanced security
   */
  private static buildSQSAccessPolicy(
    queueNames: string[],
    props: { region: string; account: string; environment: string }
  ): iam.PolicyDocument {
    const queueArns = queueNames.map((queue) =>
      queue.startsWith("arn:")
        ? queue
        : `arn:aws:sqs:${props.region}:${props.account}:${queue}`
    )

    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sqs:SendMessage",
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
          ],
          resources: queueArns,
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
      ],
    })
  }

  /**
   * Build SNS access policy with tag-based conditions for enhanced security
   */
  private static buildSNSAccessPolicy(
    topicNames: string[],
    props: { region: string; account: string; environment: string }
  ): iam.PolicyDocument {
    const topicArns = topicNames.map((topic) =>
      topic.startsWith("arn:")
        ? topic
        : `arn:aws:sns:${props.region}:${props.account}:${topic}`
    )

    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["sns:Publish"],
          resources: topicArns,
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
      ],
    })
  }

  /**
   * Build ECR access policy with tag-based conditions for enhanced security
   */
  private static buildECRAccessPolicy(
    repositoryNames: string[],
    props: { region: string; account: string; environment: string }
  ): iam.PolicyDocument {
    const repositoryArns = repositoryNames.map((repo) =>
      repo.startsWith("arn:")
        ? repo
        : `arn:aws:ecr:${props.region}:${props.account}:repository/${repo}`
    )

    return new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:BatchCheckLayerAvailability",
          ],
          resources: repositoryArns,
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": props.environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ecr:GetAuthorizationToken"],
          resources: ["*"], // GetAuthorizationToken doesn't support resource-level permissions
        }),
      ],
    })
  }
}
