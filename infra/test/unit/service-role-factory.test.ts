import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import * as ecr from "aws-cdk-lib/aws-ecr"
import * as iam from "aws-cdk-lib/aws-iam"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as sns from "aws-cdk-lib/aws-sns"
import * as sqs from "aws-cdk-lib/aws-sqs"
import { ServiceRoleFactory } from "../../lib/constructs/security/service-role-factory"
import type { IAMResourceReference } from "../../lib/constructs/security/types"

interface AccessProps {
  secrets?: IAMResourceReference[]
  s3Buckets?: IAMResourceReference[]
  dynamodbTables?: IAMResourceReference[]
  sqsQueues?: IAMResourceReference[]
  snsTopics?: IAMResourceReference[]
}

interface PolicyStatement {
  Action?: string | string[]
  Resource?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function policyStatements(value: unknown): PolicyStatement[] {
  if (Array.isArray(value)) {
    return value.flatMap(policyStatements)
  }
  if (!isRecord(value)) {
    return []
  }

  const direct = Array.isArray(value.Statement)
    ? value.Statement.filter(isRecord).map(
        (statement): PolicyStatement => statement
      )
    : []

  return [...direct, ...Object.values(value).flatMap(policyStatements)]
}

function hasAction(statement: PolicyStatement, action: string): boolean {
  return Array.isArray(statement.Action)
    ? statement.Action.includes(action)
    : statement.Action === action
}

function createRole(stack: cdk.Stack, access: AccessProps): void {
  ServiceRoleFactory.createLambdaRole(stack, "TestRole", {
    functionName: "service-role-factory-test",
    environment: "dev",
    region: "us-east-1",
    account: "123456789012",
    ...access,
    enablePermissionBoundary: false,
  })
}

function statementFor(
  stack: cdk.Stack,
  action: string
): PolicyStatement {
  const roles = Template.fromStack(stack).findResources("AWS::IAM::Role")
  const statement = policyStatements(roles).find((candidate) =>
    hasAction(candidate, action)
  )
  if (!statement) {
    throw new Error(`Policy statement for ${action} not found`)
  }
  return statement
}

function synthesizeSecretRole(secretReference: IAMResourceReference): string {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, "ServiceRoleFactoryTest", {
    env: { account: "123456789012", region: "us-east-1" },
  })

  createRole(stack, { secrets: [secretReference] })

  const roles = Template.fromStack(stack).findResources("AWS::IAM::Role")
  return JSON.stringify(Object.values(roles))
}

describe("ServiceRoleFactory resource ARN normalization", () => {
  it("preserves an unresolved secret ARN token as the exact policy resource", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenSecretRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const secret = new secretsmanager.Secret(stack, "SigningSecret")

    createRole(stack, { secrets: [{ arn: secret.secretArn }] })

    expect(
      statementFor(stack, "secretsmanager:GetSecretValue").Resource
    ).toEqual(stack.resolve(secret.secretArn))
  })

  it("preserves unresolved S3 bucket ARN tokens", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenBucketRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const bucket = new s3.Bucket(stack, "DocumentsBucket")

    createRole(stack, { s3Buckets: [{ arn: bucket.bucketArn }] })

    expect(statementFor(stack, "s3:ListBucket").Resource).toEqual(
      stack.resolve(bucket.bucketArn)
    )
  })

  it("preserves unresolved DynamoDB table ARN tokens", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenTableRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const table = new dynamodb.Table(stack, "DataTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    })

    createRole(stack, { dynamodbTables: [{ arn: table.tableArn }] })

    expect(statementFor(stack, "dynamodb:GetItem").Resource).toEqual(
      expect.arrayContaining([stack.resolve(table.tableArn)])
    )
  })

  it("preserves unresolved SQS queue ARN tokens", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenQueueRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const queue = new sqs.Queue(stack, "WorkQueue")

    createRole(stack, { sqsQueues: [{ arn: queue.queueArn }] })

    expect(statementFor(stack, "sqs:SendMessage").Resource).toEqual(
      stack.resolve(queue.queueArn)
    )
  })

  it("preserves unresolved SNS topic ARN tokens", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenTopicRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const topic = new sns.Topic(stack, "AlertsTopic")

    createRole(stack, { snsTopics: [{ arn: topic.topicArn }] })

    expect(statementFor(stack, "sns:Publish").Resource).toEqual(
      stack.resolve(topic.topicArn)
    )
  })

  it("preserves unresolved ECR repository ARN tokens", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenRepositoryRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const repository = new ecr.Repository(stack, "ImageRepository")
    const ecrPolicyFactory = ServiceRoleFactory as unknown as {
      buildECRAccessPolicy(
        repositoryNames: IAMResourceReference[],
        props: { region: string; account: string; environment: string }
      ): iam.PolicyDocument
    }
    const ecrPolicy = ecrPolicyFactory.buildECRAccessPolicy(
      [{ arn: repository.repositoryArn }],
      {
        region: "us-east-1",
        account: "123456789012",
        environment: "dev",
      }
    )
    new iam.Role(stack, "TestRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      inlinePolicies: { EcrAccess: ecrPolicy },
    })

    expect(statementFor(stack, "ecr:BatchGetImage").Resource).toEqual(
      stack.resolve(repository.repositoryArn)
    )
  })

  it("expands an unresolved S3 bucket name token", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenBucketNameRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const bucket = new s3.Bucket(stack, "DocumentsBucket")

    createRole(stack, { s3Buckets: [{ name: bucket.bucketName }] })

    expect(statementFor(stack, "s3:ListBucket").Resource).toEqual(
      stack.resolve(`arn:aws:s3:::${bucket.bucketName}`)
    )
  })

  it("expands an unresolved DynamoDB table name token", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenTableNameRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const table = new dynamodb.Table(stack, "DataTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    })

    createRole(stack, { dynamodbTables: [{ name: table.tableName }] })

    expect(statementFor(stack, "dynamodb:GetItem").Resource).toEqual(
      expect.arrayContaining([
        stack.resolve(
          `arn:aws:dynamodb:us-east-1:123456789012:table/${table.tableName}`
        ),
      ])
    )
  })

  it("expands an unresolved SQS queue name token", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenQueueNameRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const queue = new sqs.Queue(stack, "WorkQueue")

    createRole(stack, { sqsQueues: [{ name: queue.queueName }] })

    expect(statementFor(stack, "sqs:SendMessage").Resource).toEqual(
      stack.resolve(
        `arn:aws:sqs:us-east-1:123456789012:${queue.queueName}`
      )
    )
  })

  it("rejects ambiguous unresolved string references", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "AmbiguousTokenRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const secret = new secretsmanager.Secret(stack, "SigningSecret")

    expect(() => createRole(stack, { secrets: [secret.secretArn] })).toThrow(
      "Ambiguous unresolved IAM resource reference; wrap token values as { arn } or { name }"
    )
  })

  it("preserves a literal complete secret ARN", () => {
    const secretArn =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-known-AbCdEf"
    const serialized = synthesizeSecretRole(secretArn)

    expect(serialized).toContain(`"Resource":"${secretArn}"`)
    expect(serialized).not.toContain(`"Resource":"${secretArn}*"`)
  })

  it("expands a literal secret name to include the generated ARN suffix", () => {
    const serialized = synthesizeSecretRole("aistudio-dev-known")

    expect(serialized).toContain(
      '"Resource":"arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-known*"'
    )
  })
})
